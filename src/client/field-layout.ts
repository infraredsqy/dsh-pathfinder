/**
 * The layout engine of the dependency view: lays out a graph and draws it, without touching the UI.
 *
 * Layers and edges come from the record; where things sit is computed here: one column per layer,
 * ordering within a column refined over two passes by neighbors' mean height (first the nodes it
 * depends on, then those depending on it), and wires find their own path between columns that
 * avoids crossing marks. No physics, no animation, no frame loop — the graph is fully decided
 * before the first stroke is drawn. No JSX and no DOM calls here, same approach as config-rows.ts,
 * so it can be measured standalone where no browser is installed; the component side (field.tsx)
 * only measures the viewport and renders the scene computed here.
 */
import type { GraphReading, NodeReading } from '../model/index.ts'

/** Three readings: dot matrix, dot matrix spread over four columns, cards (the top level adds a prerequisite row). */
export type Zoom = 0 | 1 | 2 | 3

/** The first named size: clicking a mark zooms in onto it. */
export const CARD_ZOOM: Zoom = 2

/** The blank strip at the top: marks never enter it, so crossing wires can detour above every cell. */
const STRIP = 22
/** How far a detouring wire must keep from other marks: marks are 7px wide; this is half of that plus a bit. */
const CLEAR = 5.6
/** The path length charged for grazing one mark; compared on the same scale as the detour distance. */
const LANE_HIT = 24
/** Dot matrix spread over four columns: only the horizontal density changes, vertical stays panoramic. */
const DOTS_COLS = 4
/** The sizes and row pitches of the two card levels. */
export const CARD_GEOM = {
  2: { card: 280, gap: 44, row: 34, pad: 16, full: false },
  3: { card: 340, gap: 52, row: 52, pad: 16, full: true },
} as const

export interface Point {
  readonly x: number
  readonly y: number
  readonly col: number
}

export interface Placed {
  readonly columns: readonly (readonly NodeReading[])[]
  readonly pos: Readonly<Record<string, Point>>
  readonly mark: number
  readonly step: number
  readonly width: number
  readonly height: number
}

export interface Scene {
  readonly placed: Placed
  readonly marks: readonly { readonly node: NodeReading; readonly point: Point; readonly dim: string }[]
  readonly cards: readonly { readonly node: NodeReading; readonly point: Point; readonly lit: boolean; readonly marked: boolean; readonly full: boolean }[]
  readonly edges: readonly { readonly from: string; readonly to: string; readonly d: string; readonly cls: string }[]
}

export function sceneOf(input: {
  readonly graph: GraphReading
  readonly nodes: readonly NodeReading[]
  readonly width: number
  readonly height: number
  readonly zoom: Zoom
  readonly focusId: string | null
  readonly cut: boolean
}): Scene {
  /* Adjacency comes from the edges the reading already carries, not re-derived from dependencies:
     unregistered prerequisites must not block anyone — that skip rule lives in exactly one place,
     the model layer. */
  const deps = new Map<string, string[]>()
  const dependents = new Map<string, string[]>()
  for (const node of input.nodes) {
    deps.set(node.id, [])
    dependents.set(node.id, [])
  }
  for (const edge of input.graph.edges) {
    deps.get(edge.to)?.push(edge.from)
    dependents.get(edge.from)?.push(edge.to)
  }

  const focused = input.focusId === null ? null : input.nodes.find((node) => node.id === input.focusId) ?? null
  /* The lit ones: the selection itself, what it depends on, and what depends on it. Nothing lit without a selection. */
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
  /* At the zoomed levels the whole graph fades to gray until the reader picks one; the dot levels dim others only when something is selected. */
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

/** Which column each cell belongs to and where it sits: one pass on the longest-path tier, then two passes by neighbors' mean height. */
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

/** Reorder one column by its neighbors' mean height; ties keep the record's order. */
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

/** The panoramic level: columns are layers, one shared vertical pitch, the whole graph fits the viewport exactly. */
function assignFit(columns: readonly (readonly NodeReading[])[], width: number, height: number): Placed {
  const rows = rowsOf(columns)
  const room = height - STRIP - 7
  const pitch = rows > 1 ? room / (rows - 1) : 0
  /* Marks may shrink to 5px, but a column must never grow past the bottom of the viewport. */
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

/** The dot level: vertical stays panoramic, column pitch spreads to four columns per screen, so the canvas ends up wider than the viewport. */
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

/** The card level: one card per cell, with a gutter between columns. */
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

/** The focused level: only the lit ring remains; emptied columns and rows no longer take up room. */
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

function levelPlaced(fit: Placed, width: number, height: number, zoom: Zoom): Placed {
  if (zoom === 0) return fit
  if (zoom === 1) return dotPlaced(fit, width, height)
  return cardPlaced(fit.columns, zoom, rowsOf(fit.columns))
}

function rowsOf(columns: readonly (readonly NodeReading[])[]): number {
  return columns.reduce((most, list) => Math.max(most, list.length), 1)
}

/** The heights of the cells in each column, grouped by the current layout's column index. */
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

/** Wires at the dot level: one-adjacent columns get an arc, farther spans take steps. */
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
 * Which gap a detouring wire takes: the one grazing the fewest marks and closest to the straight line.
 *
 * Grazing one mark costs 24px of path, compared on the same scale as the detour distance — counting
 * grazes alone would, once density rises, make every middle gap count as grazed and push all long
 * wires up against the top of the canvas.
 */
function pickLane(a: Point, b: Point, lanes: readonly (readonly number[])[]): number {
  const merged: number[] = []
  for (let col = a.col + 1; col < b.col; col += 1) merged.push(...(lanes[col] ?? []))
  merged.sort((left, right) => left - right)
  /* The topmost gap is empty in every column, so it is always passable. */
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

/** Wires at the card level: out of the source's right gutter, up/down to the target's row, then into the target. */
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

/** One polyline with the corners shaved a little; corners all sit in the gutters between columns, so the shaved bits touch no mark. */
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

/** A wire's current color: whether either end is waited on, whether either is running, and whether the waited-on end has started. */
function edgeInk(from: string, to: string, nodes: readonly NodeReading[]): string {
  const a = nodes.find((node) => node.id === from)
  const b = nodes.find((node) => node.id === to)
  if (a === undefined || b === undefined) return ''
  if (a.state === 'shelved' || b.state === 'shelved') return ' is-shelved'
  if (a.running || b.running) return ' is-running'
  if (b.ready) return ' is-ready'
  return ''
}
