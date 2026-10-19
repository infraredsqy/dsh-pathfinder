/**
 * 依赖那一格：一张分层场，谁挡着谁。
 *
 * 地界量出来之后，摆在哪儿、线怎么走都由 field-layout.ts 算——那份引擎没有 JSX 也没有 DOM，
 * 单独量得出；这一份只管量地界（露面与窗口变了量一次）与照引擎算出来的场景渲染。
 */
import * as React from 'react'
import { depsWord } from '../model/index.ts'
import { CARD_GEOM, CARD_ZOOM, sceneOf } from './field-layout.ts'
import type { NodeReading, ProjectReading } from '../model/index.ts'
import type { Zoom } from './field-layout.ts'
import { nodeName, nodeHover } from './nodes.ts'

/** 量不到地界时用的尺子：面板还没露面时也画得出来，读数不至于算成 0。 */
const FALLBACK_W = 1280
const FALLBACK_H = 720

/**
 * 依赖那一格。
 * @param props - 那一刻的项目读数，以及这一格此刻在不在屏上。
 */
export function DependencyField(props: { readonly project: ProjectReading; readonly active: boolean }): React.ReactElement {
  const { graph, nodes } = props.project
  const fieldRef = React.useRef<HTMLDivElement | null>(null)
  const [box, setBox] = React.useState({ w: FALLBACK_W, h: FALLBACK_H })
  const [zoom, setZoom] = React.useState<Zoom>(0)
  const [focusId, setFocusId] = React.useState<string | null>(null)
  const [cut, setCut] = React.useState(false)
  /* 双击由这两下 click 自己认：第一下点完地界会把那一格挪到眼前，第二下的落点常常已经换成邻居，
     浏览器也就不发 dblclick 了；`detail` 是浏览器量过的连击数。 */
  const lastHit = React.useRef<string | null>(null)

  const measure = React.useCallback(() => {
    const field = fieldRef.current
    if (field === null) return
    const rect = field.getBoundingClientRect()
    setBox({ w: rect.width > 0 ? rect.width : FALLBACK_W, h: rect.height > 0 ? rect.height : FALLBACK_H })
  }, [])

  /* 这一格露面那一趟量一次：藏在别的标签后面的时候没有版面可量。 */
  React.useLayoutEffect(() => {
    if (props.active) measure()
  }, [props.active, measure])

  React.useEffect(() => {
    const onResize = (): void => {
      if (props.active) measure()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [props.active, measure])

  const scene = React.useMemo(
    () => sceneOf({ graph, nodes, width: box.w, height: box.h, zoom, focusId, cut }),
    [graph, nodes, box.w, box.h, zoom, focusId, cut],
  )

  /* 选中一格或换一档之后把它挪到眼前：一个放大的画布，读者看的就是正中间那一块。
     回到全景那一档时画布正好一屏，左上也跟着回到原点。 */
  React.useEffect(() => {
    const field = fieldRef.current
    if (field === null) return
    const point = focusId === null ? undefined : scene.placed.pos[focusId]
    if (zoom > 0 && point !== undefined) {
      field.scrollLeft = Math.max(0, point.x - field.clientWidth / 2)
      field.scrollTop = Math.max(0, point.y - field.clientHeight / 2)
    } else if (zoom === 0) {
      field.scrollLeft = 0
      field.scrollTop = 0
    }
  }, [zoom, focusId, cut, scene])

  /* 点阵那一档只有横向能挪：滚轮因此左右走，纵向仍是一屏。 */
  React.useEffect(() => {
    const field = fieldRef.current
    if (field === null) return undefined
    const onWheel = (event: WheelEvent): void => {
      if (!(zoom === 1 && !cut)) return
      if (event.ctrlKey) return
      const delta = event.deltaY || event.deltaX
      if (delta === 0) return
      field.scrollLeft += delta
      event.preventDefault()
    }
    field.addEventListener('wheel', onWheel, { passive: false })
    return () => field.removeEventListener('wheel', onWheel)
  }, [zoom, cut])

  const onMarkClick = (event: React.MouseEvent<HTMLElement>, id: string | null): void => {
    if (cut) return
    if (event.detail > 1 && lastHit.current !== null) {
      setFocusId(lastHit.current)
      setCut(true)
      setZoom((level) => (level === 0 ? CARD_ZOOM : level))
      lastHit.current = null
      return
    }
    lastHit.current = id
    if (id === null) return
    setFocusId(id)
    if (zoom === 0) setZoom(CARD_ZOOM)
  }

  /* 一个节点都没有的那一份记录：这里没有东西可画。 */
  if (nodes.length === 0) return <div className="pf-page" />

  const centered = cut && scene.placed.width < box.w
  const canvasStyle: React.CSSProperties = {
    width: `${String(scene.placed.width)}px`,
    height: `${String(scene.placed.height)}px`,
    ...(centered ? { left: `${String(Math.round((box.w - scene.placed.width) / 2))}px` } : {}),
    ...(cut && scene.placed.height < box.h ? { top: `${String(Math.round((box.h - scene.placed.height) / 2))}px` } : {}),
  }
  const fieldStyle = { ['--pf-mark' as string]: `${String(scene.placed.mark)}px` } as React.CSSProperties

  return (
    <div className="pf-page">
      <div className="pf-bar">
        <div className="pf-figs">
          <b className="pf-num">{String(graph.layers.length)}</b>
          {' 列 · '}
          <b className="pf-num">{String(nodes.length)}</b>
          {' 节点 · '}
          <b className="pf-num">{String(graph.edges.length)}</b>
          {' 边'}
        </div>
        <div className="pf-zoom">
          <button
            type="button"
            className="pf-zbtn"
            id="zoom-in"
            aria-label="放大"
            disabled={zoom >= 3}
            onClick={() => setZoom((level) => Math.min(3, level + 1) as Zoom)}
          />
          <button
            type="button"
            className="pf-zbtn"
            id="zoom-out"
            aria-label="缩小"
            disabled={zoom <= 0}
            onClick={() => setZoom((level) => Math.max(0, level - 1) as Zoom)}
          />
          <button
            type="button"
            className="pf-zbtn"
            id="zoom-cut"
            aria-label="回到全图"
            hidden={!cut}
            onClick={() => setCut(false)}
          />
        </div>
      </div>
      <div
        className={`pf-field${zoom > 0 ? ' is-zoom' : ''}${zoom === 1 && !cut ? ' is-panx' : ''}`}
        id="field"
        role="region"
        aria-label="依赖全景"
        ref={fieldRef}
        style={fieldStyle}
      >
        <div className="pf-canvas" id="canvas" style={canvasStyle}>
          <svg className="pf-wires" id="wires" aria-hidden="true">
            <g id="wires-all">
              {scene.edges.map((edge) => (
                <path
                  className={`pf-edge${edge.cls}`}
                  key={`${edge.from}:${edge.to}`}
                  data-from={edge.from}
                  data-to={edge.to}
                  d={edge.d}
                />
              ))}
            </g>
          </svg>
          <div className="pf-marks" id="marks">
            {scene.marks.map((mark) => (
              <button
                type="button"
                className={`pf-cell pf-node ${stateClass(mark.node)}${mark.dim}`}
                key={mark.node.id}
                data-id={mark.node.id}
                title={hoverOf(mark.node)}
                style={{
                  left: `${String(mark.point.x - scene.placed.mark / 2)}px`,
                  top: `${String(mark.point.y - scene.placed.mark / 2)}px`,
                }}
                onClick={(event) => onMarkClick(event, mark.node.id)}
              />
            ))}
            {scene.cards.map((card) => (
              <button
                type="button"
                className={`pf-zcard${CARD_GEOM[card.full ? 3 : 2].full ? ' is-full' : ''}${card.lit ? ' is-lit' : ''}${card.marked ? ' is-focus' : ''}`}
                key={card.node.id}
                data-id={card.node.id}
                title={hoverOf(card.node)}
                style={{
                  left: `${String(card.point.x - CARD_GEOM[card.full ? 3 : 2].card / 2)}px`,
                  top: `${String(card.point.y - CARD_GEOM[card.full ? 3 : 2].row / 2)}px`,
                  width: `${String(CARD_GEOM[card.full ? 3 : 2].card)}px`,
                  height: `${String(CARD_GEOM[card.full ? 3 : 2].row)}px`,
                }}
                onClick={(event) => onMarkClick(event, card.node.id)}
              >
                <span className={`pf-cell pf-mark ${stateClass(card.node)}`} />
                <span className="pf-zbody">
                  <span className="pf-ztitle">{nodeName(card.node)}</span>
                  {CARD_GEOM[card.full ? 3 : 2].full ? <CardDeps node={card.node} /> : null}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 依赖那一栏的话，长在哪个看法都这一张脸：可开工，或者前置节点 N 个。
 *
 * 哪一句归这一格、词面是什么，都由读数说（`depsWord`）——这句话全仓只在 model 拼一处；这里
 * 把数字从那句话里穿出来，前后两段原样摆回，只给穿出来的数字套上它那身记号（等宽、亮一档）
 * ——那一身只有界面摆得出来。
 */
export function DepsChip(props: { readonly node: NodeReading }): React.ReactElement | null {
  const { node } = props
  const said = depsWord(node)
  if (said === null) return null
  const [head, tail] = said.count === null ? [said.word] : said.word.split(String(said.count))
  return (
    <span className={`pf-deps${said.ready ? ' is-ready' : ''}`}>
      {head}
      {tail !== undefined ? <b className="pf-num">{String(said.count)}</b> : null}
      {tail}
    </span>
  )
}

/** 卡片上那一行：它还等不等、等几件。落定的、进行中的、放下的那一格都不写。 */
function CardDeps(props: { readonly node: NodeReading }): React.ReactElement | null {
  if (depsWord(props.node) === null) return null
  return (
    <span className="pf-zmeta">
      <DepsChip node={props.node} />
    </span>
  )
}

/** 一个记号的画法：落定的实心、进行中的用链接色、没开动的空心、还欠前置的更淡。 */
function stateClass(node: NodeReading): string {
  if (node.state === 'completed') return 'is-done'
  if (node.state === 'shelved') return 'is-shelved'
  if (node.running) return 'is-running'
  return node.ready ? 'is-todo' : 'is-wait'
}

/** 一个记号说的是什么：名字与八字把手（共用那副节点名），以及图形说不出来的那一件事——
 *  依赖上那句与卡片上那一行同一句话，都从读数那份措辞来。 */
function hoverOf(node: NodeReading): string {
  const parts = [nodeHover(node)]
  if (node.state === 'completed') parts.push('已交付')
  else if (node.state === 'shelved') parts.push('等待处理')
  else if (node.running) parts.push('进行中')
  else {
    const said = depsWord(node)
    if (said !== null) parts.push(said.word)
  }
  return parts.join(' · ')
}

