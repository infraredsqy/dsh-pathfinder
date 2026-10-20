/**
 * The dependency view: one layered field of who blocks whom.
 *
 * Once the viewport is measured, placement and wire routing are computed by field-layout.ts — that
 * engine has no JSX and no DOM, so it can be measured standalone; this file only measures the
 * viewport (on show and on window resize) and renders the scene the engine computed.
 */
import * as React from 'react'
import { depsWord } from '../model/index.ts'
import { CARD_GEOM, CARD_ZOOM, sceneOf } from './field-layout.ts'
import type { NodeReading, ProjectReading } from '../model/index.ts'
import type { Zoom } from './field-layout.ts'
import { nodeName, nodeHover } from './nodes.ts'

/** The ruler used when the viewport cannot be measured: the field still draws before the panel shows, and readings never come out as 0. */
const FALLBACK_W = 1280
const FALLBACK_H = 720

export function DependencyField(props: { readonly project: ProjectReading; readonly active: boolean }): React.ReactElement {
  const { graph, nodes } = props.project
  const fieldRef = React.useRef<HTMLDivElement | null>(null)
  const [box, setBox] = React.useState({ w: FALLBACK_W, h: FALLBACK_H })
  const [zoom, setZoom] = React.useState<Zoom>(0)
  const [focusId, setFocusId] = React.useState<string | null>(null)
  const [cut, setCut] = React.useState(false)
  /* The double click is recognized from these two clicks themselves: after the first click the view
     scrolls that cell into view, so the second click often lands on a different neighbor and the
     browser never fires dblclick; `detail` is the browser's own click count. */
  const lastHit = React.useRef<string | null>(null)

  const measure = React.useCallback(() => {
    const field = fieldRef.current
    if (field === null) return
    const rect = field.getBoundingClientRect()
    setBox({ w: rect.width > 0 ? rect.width : FALLBACK_W, h: rect.height > 0 ? rect.height : FALLBACK_H })
  }, [])

  /* Measure once when this view becomes visible: there is no layout to measure while hidden behind another tab. */
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

  /* After a selection or a zoom change, scroll the target to the center: on a zoomed canvas what
     the reader wants is the middle of the viewport. Back at the panoramic level the canvas is
     exactly one screen, and the top-left corner returns to the origin too. */
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

  /* At the dot level only the horizontal axis scrolls: the wheel therefore moves left/right; vertically it stays one screen. */
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

  /* A record with no nodes at all: nothing to draw here. */
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
 * The dependency line, wearing the same face in every view: ready to start, or N prerequisite nodes.
 *
 * Which sentence belongs to a cell and what the wording is are both decided by the reading
 * (`depsWord`) — the sentence is assembled in exactly one place in the repo, the model. Here the
 * number is threaded out of that sentence, the surrounding segments are placed back verbatim, and
 * only the threaded number gets its own mark styling (monospace, brighter) — styling is something
 * only the UI can provide.
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

/** The line on a card: whether it still waits, and for how many. Settled, running, and shelved cells omit it. */
function CardDeps(props: { readonly node: NodeReading }): React.ReactElement | null {
  if (depsWord(props.node) === null) return null
  return (
    <span className="pf-zmeta">
      <DepsChip node={props.node} />
    </span>
  )
}

/** How one mark is drawn: filled when settled, link color while running, hollow before starting, fainter while blocked on prerequisites. */
function stateClass(node: NodeReading): string {
  if (node.state === 'completed') return 'is-done'
  if (node.state === 'shelved') return 'is-shelved'
  if (node.running) return 'is-running'
  return node.ready ? 'is-todo' : 'is-wait'
}

/** What one mark says: the name and 8-char handle (the shared node naming), plus the one thing the
 *  graphic cannot show — the dependency sentence, the same one as on the card, from the reading's wording. */
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

