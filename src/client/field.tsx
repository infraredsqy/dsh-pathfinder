/**
 * 依赖那一格：一张分层场，谁挡着谁。
 *
 * 层与边从记录里来（`readGraph`），摆在哪儿由这一层算：每一层一列，列里的次序按邻居的
 * 平均高度过两趟（先看它欠的，再看欠它的），线在列与列之间自己找一条不压记号的走法。
 * 没有物理、没有动画、没有帧循环——图在第一笔画出来之前就已经定了，剩下的是读它。
 *
 * 同一张图有三种读法，放大不改排布，只改一格有多大、列与列隔多远：点阵那一档看形状，
 * 卡片那两档看名字。抠出来看是同一个问题的另一半：只留选中那一格和它上下游那一圈，
 * 空掉的列与行不再占地方。
 *
 * @module dsh-pathfinder/client/field
 */
import * as React from 'react'
import type { GraphReading, NodeReading, ProjectReading } from '../model/index.ts'

/** 三种读法：点阵、点阵铺到四列一屏、卡片（最上面那一档多带一行前置）。 */
type Zoom = 0 | 1 | 2 | 3

/** 第一档带名字的尺寸：点进一个记号就落到它上面。 */
const CARD_ZOOM: Zoom = 2

/** 那一层顶上的留白：记号不进这里，横穿的线因此能从所有格子上头绕过去。 */
const STRIP = 22
/** 一条绕行的线要跟别人的记号隔开多少：记号 7px 宽，这是它的一半再加一点。 */
const CLEAR = 5.6
/** 压到一枚记号算绕多远的路；拿它跟绕行的距离放在同一把尺子上比。 */
const LANE_HIT = 24
/** 点阵铺到四列一屏：只有横向的疏密变了，纵向还是全景那一套。 */
const DOTS_COLS = 4
/** 量不到地界时用的尺子：面板还没露面时也画得出来，读数不至于算成 0。 */
const FALLBACK_W = 1280
const FALLBACK_H = 720

/** 卡片那两档各自的尺寸与行距。 */
const CARD_GEOM = {
  2: { card: 280, gap: 44, row: 34, pad: 16, full: false },
  3: { card: 340, gap: 52, row: 52, pad: 16, full: true },
} as const

/** 一格摆在哪、在哪一列。 */
interface Point {
  readonly x: number
  readonly y: number
  readonly col: number
}

/** 排布好的一张图：列、每一格的位置、记号多大、列距多少、画布多大。 */
interface Placed {
  readonly columns: readonly (readonly NodeReading[])[]
  readonly pos: Readonly<Record<string, Point>>
  readonly mark: number
  /** 相邻两列之间隔多远。 */
  readonly step: number
  readonly width: number
  readonly height: number
}

/** 画出来的一张图：记号、卡片与线，位置都已经算好。 */
interface Scene {
  readonly placed: Placed
  readonly marks: readonly { readonly node: NodeReading; readonly point: Point; readonly dim: string }[]
  readonly cards: readonly { readonly node: NodeReading; readonly point: Point; readonly lit: boolean; readonly marked: boolean; readonly full: boolean }[]
  readonly edges: readonly { readonly from: string; readonly to: string; readonly d: string; readonly cls: string }[]
}

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
  /* 双击由这两下 click 自己认：第一下点完地界会把那一格挪到眼前，第二下的落点常常已经
     换成邻居，浏览器也就不发 dblclick 了。`detail` 是浏览器量过的连击数。 */
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
                  <span className="pf-ztitle">{titleOf(card.node)}</span>
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

/** 卡片上那一行：它还等不等、等几件。落定的、进行中的、放下的那一格都不写。 */
function CardDeps(props: { readonly node: NodeReading }): React.ReactElement | null {
  const { node } = props
  /* 「可开工」只认读数自己那一栏（词表那三条判据算出来的值），不拿 `state` 自己拼：进行中的一
     格 `state` 也是 `todo`，照 `state` 拼就会把别人手里正做的那一格印成可开工。 */
  if (node.ready) {
    return (
      <span className="pf-zmeta">
        <span className="pf-deps is-ready">可开工</span>
      </span>
    )
  }
  /* 还没进行中、只是真欠着前置的那一格：写几件。进行中的、放下的、落定的、以及一件都不欠的都不写。 */
  if (node.state !== 'todo' || node.running || node.openDependencies.length === 0) return null
  return (
    <span className="pf-zmeta">
      <span className="pf-deps">
        {'前置节点 '}<b className="pf-num">{String(node.openDependencies.length)}</b>{' 个'}
      </span>
    </span>
  )
}

/** 一格的标题：记录里那个标题；没写就用身份的前八个字。 */
function titleOf(node: NodeReading): string {
  return node.title ?? shortOf(node)
}

/** 记录里那个八字把手。 */
function shortOf(node: NodeReading): string {
  return node.id.length > 8 ? node.id.slice(0, 8) : node.id
}

/** 一个记号的画法：落定的实心、进行中的用链接色、没开动的空心、还欠前置的更淡。 */
function stateClass(node: NodeReading): string {
  if (node.state === 'completed') return 'is-done'
  if (node.state === 'shelved') return 'is-shelved'
  if (node.running) return 'is-running'
  return node.ready ? 'is-todo' : 'is-wait'
}

/** 一个记号说的是什么：标题、八字把手，以及图形说不出来的那一件事。
 *  与 `CardDeps` 说的是同一件事——两边都先认读数自己的 `ready`、再看有没有人握着，所以那一
 *  格在卡片上不印什么、在这里说「进行中」，不会一处说可开工、一处说在别人手里。 */
function hoverOf(node: NodeReading): string {
  const short = shortOf(node)
  const parts = [node.title === undefined ? short : node.title]
  if (node.title !== undefined && node.title !== short) parts.push(short)
  if (node.state === 'completed') parts.push('已交付')
  else if (node.state === 'shelved') parts.push('等待处理')
  else if (node.running) parts.push('进行中')
  else if (node.ready) parts.push('可开工')
  else parts.push(`前置节点 ${String(node.openDependencies.length)} 个`)
  return parts.join(' · ')
}

/**
 * 把一张图排出来、画出来。
 * @param input - 层与边、地界多大、此刻读的是哪一档、选中了谁、抠没抠出来。
 */
function sceneOf(input: {
  readonly graph: GraphReading
  readonly nodes: readonly NodeReading[]
  readonly width: number
  readonly height: number
  readonly zoom: Zoom
  readonly focusId: string | null
  readonly cut: boolean
}): Scene {
  const knows = new Set(input.nodes.map((node) => node.id))
  const deps = new Map<string, string[]>()
  const dependents = new Map<string, string[]>()
  for (const node of input.nodes) deps.set(node.id, node.dependencies.filter((id) => knows.has(id)))
  for (const node of input.nodes) dependents.set(node.id, [])
  for (const node of input.nodes) {
    for (const from of deps.get(node.id) ?? []) dependents.get(from)?.push(node.id)
  }

  const focused = input.focusId === null ? null : input.nodes.find((node) => node.id === input.focusId) ?? null
  /* 亮着的那些：选中的自己、它欠的、欠它的。没选中就一个都不亮。 */
  const lit = new Set<string>()
  if (focused !== null) {
    lit.add(focused.id)
    for (const id of deps.get(focused.id) ?? []) lit.add(id)
    for (const id of dependents.get(focused.id) ?? []) lit.add(id)
  }

  const fit = orderColumns(input.graph.layers, deps, dependents, input.width, input.height)
  const placed = input.cut && focused !== null
    ? cutPlaced(fit, lit, input.width, input.height, input.zoom)
    : levelPlaced(fit, input.width, input.height, input.zoom)

  const shown = placed.columns.flat().filter((node) => node.id in placed.pos)
  const shownEdges = input.graph.edges.filter((edge) => (
    edge.from in placed.pos && edge.to in placed.pos && (!input.cut || (lit.has(edge.from) && lit.has(edge.to)))
  ))
  const lanes = laneHeights(placed)
  const cards = input.zoom >= CARD_ZOOM
  /* 放大那两档整张图退成灰，等读者点一个出来；点阵那两档只在有选中的时候才压暗别的。 */
  const dimming = input.zoom >= CARD_ZOOM || focused !== null
  const dimMark = input.zoom > 0 && focused !== null

  return {
    placed,
    marks: cards ? [] : shown.map((node) => ({
      node,
      point: placed.pos[node.id] as Point,
      dim: dimMark ? (lit.has(node.id) ? ' is-lit' : ' is-dim') : '',
    })),
    cards: cards ? shown.map((node) => ({
      node,
      point: placed.pos[node.id] as Point,
      lit: lit.has(node.id),
      marked: node.id === input.focusId,
      full: input.zoom === 3,
    })) : [],
    edges: shownEdges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      d: cards ? cardWire(placed, edge.from, edge.to, input.zoom) : dotWire(placed, edge.from, edge.to, edge.span, lanes),
      cls: `${edgeInk(edge.from, edge.to, input.nodes)}${dimming && !(lit.has(edge.from) && lit.has(edge.to)) ? ' is-dim' : ''}`,
    })),
  }
}

/** 每一格是哪一列的、摆在哪：最长路那一档先排一遍，再按邻居的平均高度过两趟。 */
function orderColumns(
  layers: readonly (readonly NodeReading[])[],
  deps: ReadonlyMap<string, string[]>,
  dependents: ReadonlyMap<string, string[]>,
  width: number,
  height: number,
): Placed {
  let columns: NodeReading[][] = layers.map((layer) => [...layer])
  let placed = assignFit(columns, width, height)
  for (let col = 1; col < columns.length; col += 1) {
    columns = reorder(columns, col, placed.pos, (node) => deps.get(node.id) ?? [])
    placed = assignFit(columns, width, height)
  }
  for (let col = columns.length - 2; col >= 0; col -= 1) {
    columns = reorder(columns, col, placed.pos, (node) => dependents.get(node.id) ?? [])
    placed = assignFit(columns, width, height)
  }
  return placed
}

/** 把一列按它邻居的平均高度重排；高度一样时保持记录给的次序。 */
function reorder(
  columns: readonly NodeReading[][],
  col: number,
  pos: Readonly<Record<string, Point>>,
  pick: (node: NodeReading) => readonly string[],
): NodeReading[][] {
  const keyed = (columns[col] ?? []).map((node, at) => {
    let sum = 0
    let count = 0
    for (const other of pick(node)) {
      const point = pos[other]
      if (point === undefined) continue
      sum += point.y
      count += 1
    }
    return { node, mean: count === 0 ? pos[node.id]?.y ?? 0 : sum / count, at }
  })
  keyed.sort((left, right) => (left.mean - right.mean) || (left.at - right.at))
  const out = columns.map((list) => list)
  out[col] = keyed.map((entry) => entry.node)
  return out
}

/** 全景那一档：列就是层，纵向一套共同的间距，整张图正好装进地界。 */
function assignFit(columns: readonly (readonly NodeReading[])[], width: number, height: number): Placed {
  const rows = rowsOf(columns)
  const room = height - STRIP - 7
  const pitch = rows > 1 ? room / (rows - 1) : 0
  /* 结构先说：记号可以缩到 5px 也不许一列从地界底下长出去。 */
  const mark = Math.max(5, Math.min(8, Math.floor(pitch * 0.4)))
  const step = width / Math.max(1, columns.length)
  const inner = height - STRIP - mark
  const rowPitch = rows > 1 ? inner / (rows - 1) : 0
  const mid = STRIP + mark / 2 + inner / 2
  const pos: Record<string, Point> = {}
  for (const [col, list] of columns.entries()) {
    for (const [at, node] of list.entries()) {
      pos[node.id] = { x: step * (col + 0.5), y: mid + (at - (list.length - 1) / 2) * rowPitch, col }
    }
  }
  return { columns, pos, mark, step, width, height }
}

/** 点阵那一档：纵向还是全景那一套，列距摊到四列一屏，画布因此比地界宽。 */
function dotPlaced(fit: Placed, width: number, height: number): Placed {
  const step = width / DOTS_COLS
  const pos: Record<string, Point> = {}
  for (const [col, list] of fit.columns.entries()) {
    for (const node of list) {
      const held = fit.pos[node.id]
      if (held === undefined) continue
      pos[node.id] = { x: step * (col + 0.5), y: held.y, col }
    }
  }
  return { columns: fit.columns, pos, mark: fit.mark, step, width: step * fit.columns.length, height }
}

/** 卡片那一档：每一格一张卡片，列与列之间留一道缝。 */
function cardPlaced(columns: readonly (readonly NodeReading[])[], zoom: Zoom, rows: number): Placed {
  const geom = CARD_GEOM[zoom === 3 ? 3 : 2]
  const step = geom.card + geom.gap
  const pos: Record<string, Point> = {}
  for (const [col, list] of columns.entries()) {
    for (const [at, node] of list.entries()) {
      pos[node.id] = { x: geom.pad + col * step + geom.card / 2, y: geom.pad + at * geom.row + geom.row / 2, col }
    }
  }
  return {
    columns,
    pos,
    mark: 7,
    step,
    width: geom.pad * 2 + columns.length * geom.card + Math.max(0, columns.length - 1) * geom.gap,
    height: geom.pad * 2 + rows * geom.row,
  }
}

/** 选中的那一档：只留亮着的那一圈，空掉的列与行不再占地方。 */
function cutPlaced(fit: Placed, lit: ReadonlySet<string>, width: number, height: number, zoom: Zoom): Placed {
  const keep = fit.columns
    .map((list) => list.filter((node) => lit.has(node.id)))
    .filter((list) => list.length > 0)
  let deep = 1
  for (const list of keep) deep = Math.max(deep, list.length)
  if (zoom < CARD_ZOOM) {
    const step = keep.length > 0 ? width / Math.min(DOTS_COLS, keep.length) : 0
    const inner = height - STRIP - fit.mark
    const rowPitch = deep > 1 ? inner / (deep - 1) : 0
    const mid = STRIP + fit.mark / 2 + inner / 2
    const pos: Record<string, Point> = {}
    for (const [col, list] of keep.entries()) {
      for (const [at, node] of list.entries()) {
        pos[node.id] = { x: step * (col + 0.5), y: mid + (at - (list.length - 1) / 2) * rowPitch, col }
      }
    }
    return { columns: keep, pos, mark: fit.mark, step, width: step * keep.length, height }
  }
  const geom = CARD_GEOM[zoom === 3 ? 3 : 2]
  const step = geom.card + geom.gap
  const pos: Record<string, Point> = {}
  for (const [col, list] of keep.entries()) {
    for (const [at, node] of list.entries()) {
      pos[node.id] = { x: geom.pad + col * step + geom.card / 2, y: geom.pad + at * geom.row + geom.row / 2, col }
    }
  }
  return {
    columns: keep,
    pos,
    mark: fit.mark,
    step,
    width: keep.length > 0 ? geom.pad * 2 + keep.length * geom.card + (keep.length - 1) * geom.gap : 0,
    height: geom.pad * 2 + deep * geom.row,
  }
}

/** 那一档该用的排布。 */
function levelPlaced(fit: Placed, width: number, height: number, zoom: Zoom): Placed {
  if (zoom === 0) return fit
  if (zoom === 1) return dotPlaced(fit, width, height)
  return cardPlaced(fit.columns, zoom, rowsOf(fit.columns))
}

/** 一列最长有多少格。 */
function rowsOf(columns: readonly (readonly NodeReading[])[]): number {
  return columns.reduce((most, list) => Math.max(most, list.length), 1)
}

/** 每一列里那几格的高度，按当前这一版的列号分堆。 */
function laneHeights(placed: Placed): readonly (readonly number[])[] {
  const out: number[][] = placed.columns.map(() => [])
  for (const list of placed.columns) {
    for (const node of list) {
      const point = placed.pos[node.id]
      if (point === undefined) continue
      const lane = out[point.col]
      if (lane !== undefined) lane.push(point.y)
    }
  }
  for (const lane of out) lane.sort((left, right) => left - right)
  return out
}

/** 点阵那一档的线：隔一列的拉一条弧，隔得远的走阶梯。 */
function dotWire(placed: Placed, from: string, to: string, span: number, lanes: readonly (readonly number[])[]): string {
  const a = placed.pos[from]
  const b = placed.pos[to]
  if (a === undefined || b === undefined) return ''
  const x1 = a.x + placed.mark / 2
  const x2 = b.x - placed.mark / 2
  if (span <= 1) {
    const bend = (x2 - x1) * 0.45
    return `M${String(x1)} ${String(a.y)}C${String(x1 + bend)} ${String(a.y)} ${String(x2 - bend)} ${String(b.y)} ${String(x2)} ${String(b.y)}`
  }
  const g1 = placed.step * (a.col + 1)
  const g2 = placed.step * b.col
  const lane = pickLane(a, b, lanes)
  return `M${String(x1)} ${String(a.y)}L${String(g1)} ${String(a.y)}L${String(g1)} ${String(lane)}L${String(g2)} ${String(lane)}L${String(g2)} ${String(b.y)}L${String(x2)} ${String(b.y)}`
}

/**
 * 一条绕行的线走哪一条缝：擦到的记号最少、又离直线最近的那一条。
 *
 * 擦到一枚算绕 24px 的路，跟绕行的距离放在同一把尺子上比——只数擦到几枚的话，密度一
 * 上来中间那些缝个个都算擦到，长边就一齐挤到画面顶上去了。
 */
function pickLane(a: Point, b: Point, lanes: readonly (readonly number[])[]): number {
  const merged: number[] = []
  for (let col = a.col + 1; col < b.col; col += 1) merged.push(...(lanes[col] ?? []))
  merged.sort((left, right) => left - right)
  /* 顶上那一条在每个列里都是空的，所以它永远走得通。 */
  const candidates = [STRIP / 2]
  for (let at = 1; at < merged.length; at += 1) candidates.push(((merged[at - 1] ?? 0) + (merged[at] ?? 0)) / 2)
  const want = (a.y + b.y) / 2
  let best = candidates[0] ?? STRIP / 2
  let bestCost = Number.POSITIVE_INFINITY
  for (const y of candidates) {
    let hits = 0
    for (let col = a.col + 1; col < b.col; col += 1) {
      for (const height of lanes[col] ?? []) if (Math.abs(height - y) < CLEAR) hits += 1
    }
    const cost = hits * LANE_HIT + Math.abs(y - want)
    if (cost < bestCost) {
      bestCost = cost
      best = y
    }
  }
  return best
}

/** 卡片那一档的线：从源头出到右边的缝，上下走到目标那一层，再进目标。 */
function cardWire(placed: Placed, from: string, to: string, zoom: Zoom): string {
  const a = placed.pos[from]
  const b = placed.pos[to]
  if (a === undefined || b === undefined) return ''
  const geom = CARD_GEOM[zoom === 3 ? 3 : 2]
  const gutter = geom.pad + a.col * placed.step + geom.card + geom.gap / 2
  return rounded([
    [a.x + geom.card / 2, a.y],
    [gutter, a.y],
    [gutter, b.y],
    [b.x - geom.card / 2, b.y],
  ])
}

/** 一条折线，转角上削掉一点；转角都落在列与列之间的缝里，削掉的那点够不到任何记号。 */
function rounded(points: readonly (readonly [number, number])[]): string {
  const r = 3
  const first = points[0]
  if (first === undefined) return ''
  let d = `M${String(first[0])} ${String(first[1])}`
  for (let at = 1; at < points.length - 1; at += 1) {
    const point = points[at] as readonly [number, number]
    const before = points[at - 1] as readonly [number, number]
    const after = points[at + 1] as readonly [number, number]
    const ix = before[0] === point[0] ? 0 : (point[0] > before[0] ? 1 : -1)
    const iy = before[1] === point[1] ? 0 : (point[1] > before[1] ? 1 : -1)
    const ox = after[0] === point[0] ? 0 : (after[0] > point[0] ? 1 : -1)
    const oy = after[1] === point[1] ? 0 : (after[1] > point[1] ? 1 : -1)
    const r1 = Math.min(r, Math.abs(point[0] - before[0]) / 2 + Math.abs(point[1] - before[1]) / 2)
    const r2 = Math.min(r, Math.abs(after[0] - point[0]) / 2 + Math.abs(after[1] - point[1]) / 2)
    d += `L${String(point[0] - ix * r1)} ${String(point[1] - iy * r1)}`
    d += `Q${String(point[0])} ${String(point[1])} ${String(point[0] + ox * r2)} ${String(point[1] + oy * r2)}`
  }
  const last = points[points.length - 1] as readonly [number, number]
  return `${d}L${String(last[0])} ${String(last[1])}`
}

/** 一条线此刻是什么颜色：它两头有没有人等人、有没有人握着、等的那一头开不开工。 */
function edgeInk(from: string, to: string, nodes: readonly NodeReading[]): string {
  const a = nodes.find((node) => node.id === from)
  const b = nodes.find((node) => node.id === to)
  if (a === undefined || b === undefined) return ''
  if (a.state === 'shelved' || b.state === 'shelved') return ' is-shelved'
  if (a.running || b.running) return ' is-running'
  if (b.ready) return ' is-ready'
  return ''
}