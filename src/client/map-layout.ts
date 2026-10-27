/**
 * The map's drawing and its camera, as pure functions: no DOM, no React, no clock of its own.
 *
 * The reading comes in whole (nodes + edges) and one placement comes out: which columns there are,
 * where each card sits, what each card owes and what owes it. The camera is the second half — where
 * the drawing stands in a viewport of a given size — and is likewise arithmetic over a placement,
 * so both halves are measured without a browser.
 *
 * Why a placement rather than a force simulation: the same record must give the same picture on
 * every open. Four barycentre passes over the columns straighten the drawing enough to read; a
 * simulation would drift with every frame, and a reader comparing two sessions would be comparing
 * two layouts.
 */
import type { GraphEdge, NodeReading } from '../model/index.ts'

/** One card's box, in canvas pixels. The sheet draws it from these two numbers, so they are stated once. */
export const CARD_W = 380
export const CARD_H = 96

/** The space between two columns, and between two cards of one column. */
export const COL_GAP = 110
export const ROW_GAP = 52

/** The blank margin around the drawing: without it a card at the edge loses its frame against the page. */
export const PAD = 56

/**
 * How many cards one page draws at most: the triage order's first N, then the focus's own
 * neighbours. A ceiling on what this page can be asked to draw, not on what it can read.
 */
export const CAP = 1000

/**
 * The two sizes at which a card's words can be read, as camera scales. Above the first, the title
 * is legible; above the second, the caption row is too. Below them the card keeps its box and its
 * frame, and the words leave — the same drawing, read from further away.
 */
export const TITLE_AT = 0.62
export const FULL_AT = 0.92

export const SCALE_MIN = 0.1
export const SCALE_MAX = 2.4

/** How close the camera stands to the focus: a card's title lands around 24px on screen. */
export const FOCUS_SCALE = 1.2

/** The margin kept around the focus's ring when it has to be shrunk to fit. */
const RING_MARGIN = 48

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Size {
  readonly w: number
  readonly h: number
}

/** The camera: a scale and where the drawing's origin lands. */
export interface View {
  readonly s: number
  readonly tx: number
  readonly ty: number
}

/** A rectangle in canvas pixels. */
export interface Rect {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

/** What one page holds once placed: the cards, where they sit, and who owes whom among them. */
export interface Placement {
  /** The cards drawn, in the order the page ranks them. */
  readonly drawn: readonly NodeReading[]
  /** Six columns: one per depth, no column empty. Ids, in the order the column reads. */
  readonly columns: readonly (readonly string[])[]
  /** Where each drawn card's centre sits. */
  readonly pos: Readonly<Record<string, Point>>
  /** The drawing's own box, margin included. */
  readonly width: number
  readonly height: number
  /** Each card's prerequisites, restricted to the drawn set. */
  readonly up: Readonly<Record<string, readonly string[]>>
  /** Each card's dependents, restricted to the drawn set. */
  readonly down: Readonly<Record<string, readonly string[]>>
}

export interface PlaceInput {
  readonly nodes: readonly NodeReading[]
  readonly edges: readonly GraphEdge[]
  /** How many cards to draw at most; {@link CAP} when absent. */
  readonly cap?: number | undefined
  /** The card in focus: it and its direct neighbours are always drawn, capped or not. */
  readonly focus?: string | null | undefined
}

/**
 * Which reading of a card comes first, as a rank: a card that wants a person, then one in someone's
 * hands, then what has just settled, then what may start, then everything still waiting.
 *
 * The order answers one question — where does a reader look first — and nothing else: it is not a
 * priority, and a lower rank means nothing about how important the work is.
 */
export function rankOf(node: NodeReading): number {
  if (node.gate !== null) return 0
  if (node.running) return 1
  if (node.state === 'completed') return 2
  if (node.ready) return 3
  return 4
}

/** The one moment a card speaks of, newest first among the moments it has. */
function momentOf(node: NodeReading): number {
  const when = node.gate?.since ?? node.heldSince ?? node.endedAt ?? node.completedAt ?? node.createdAt
  return when === null ? 0 : when.getTime()
}

/**
 * The triage order: rank first, the more recent moment next, and the record's own order last so
 * that two cards of one rank and one moment never swap places between opens.
 */
export function rankedOf(nodes: readonly NodeReading[]): readonly NodeReading[] {
  const recordOrder = new Map(nodes.map((node, index) => [node.id, index]))
  return [...nodes].sort((left, right) => rankOf(left) - rankOf(right)
    || momentOf(right) - momentOf(left)
    || (recordOrder.get(left.id) ?? 0) - (recordOrder.get(right.id) ?? 0))
}

/** Who owes whom, both ways, over the given edges. */
function neighboursOf(edges: readonly GraphEdge[]): {
  readonly up: Map<string, string[]>
  readonly down: Map<string, string[]>
} {
  const up = new Map<string, string[]>()
  const down = new Map<string, string[]>()
  const push = (into: Map<string, string[]>, key: string, value: string): void => {
    const held = into.get(key)
    if (held === undefined) into.set(key, [value])
    else if (!held.includes(value)) held.push(value)
  }
  for (const edge of edges) {
    push(up, edge.to, edge.from)
    push(down, edge.from, edge.to)
  }
  return { up, down }
}

/**
 * Each card's depth: the longest prerequisite path that stays inside the drawn set.
 *
 * A prerequisite the page is not drawing is skipped rather than counted: the depth answers "how far
 * from the left edge does this stand on this page", and a card that is not here cannot be left of it.
 * A loop back to the card itself stops the walk there instead of recursing forever.
 */
function depthsOf(drawn: readonly NodeReading[], up: Map<string, string[]>): Map<string, number> {
  const inside = new Set(drawn.map((node) => node.id))
  const depth = new Map<string, number>()
  const walking = new Set<string>()

  const walk = (id: string): number => {
    const held = depth.get(id)
    if (held !== undefined) return held
    if (walking.has(id)) return 0
    walking.add(id)
    let deepest = 0
    for (const prerequisite of up.get(id) ?? []) {
      if (!inside.has(prerequisite)) continue
      deepest = Math.max(deepest, walk(prerequisite) + 1)
    }
    walking.delete(id)
    depth.set(id, deepest)
    return deepest
  }

  for (const node of drawn) walk(node.id)
  return depth
}

/**
 * Straighten the columns into a shape: four alternating passes, each re-ordering one column by the
 * mean row of its neighbours in the next one.
 *
 * Alternating matters — two passes in one direction push every column toward the same edge and the
 * drawing slides; alternating lets the drawing settle around its own middle. Ties keep the order the
 * column already had, so the passes converge instead of swapping pairs forever.
 */
function straighten(
  columns: string[][],
  near: Map<string, string[]>,
): string[][] {
  /* Nothing to straighten, and nothing to iterate over: a page with no cards (or one column of
   * them) is already the shape it is. Without this the passes' index arithmetic never reaches its
   * target and the call never returns. */
  if (columns.length < 2) return columns
  const row = new Map<string, number>()
  const sync = (): void => {
    for (const column of columns) {
      column.forEach((id, at) => row.set(id, at))
    }
  }
  sync()

  for (let pass = 0; pass < 4; pass += 1) {
    const forward = pass % 2 === 0
    const from = forward ? 1 : columns.length - 2
    const to = forward ? columns.length : -1
    const step = forward ? 1 : -1
    for (let index = from; index !== to; index += step) {
      const column = columns[index]
      if (column === undefined) continue
      const keyed = column.map((id, at) => {
        let sum = 0
        let count = 0
        for (const other of near.get(id) ?? []) {
          const at2 = row.get(other)
          if (at2 === undefined) continue
          sum += at2
          count += 1
        }
        return { id, key: count > 0 ? sum / count : at, at }
      })
      keyed.sort((left, right) => left.key - right.key || left.at - right.at)
      const next = keyed.map((entry) => entry.id)
      columns[index] = next
      next.forEach((id, at) => row.set(id, at))
    }
  }
  return columns
}

/**
 * Place the drawing.
 *
 * The horizontal axis is one the record really has — a card stands one column right of its deepest
 * prerequisite. The vertical axis is typography: cards are ordered inside their column and centred
 * within the drawing's full height, so a short tail column does not leave the drawing's lower right
 * quarter empty.
 */
export function place(input: PlaceInput): Placement {
  const cap = input.cap ?? CAP
  const focus = input.focus ?? null
  const { up, down } = neighboursOf(input.edges)
  const ranked = rankedOf(input.nodes)

  /* The drawn set: the triage order's first N, then the focus and its direct neighbours — a card in
   * focus whose prerequisite is outside the cap would otherwise hang on nothing. */
  const drawn: NodeReading[] = ranked.slice(0, cap)
  const have = new Set(drawn.map((node) => node.id))
  if (focus !== null && !have.has(focus)) {
    const held = input.nodes.find((node) => node.id === focus)
    if (held !== undefined) {
      drawn.unshift(held)
      have.add(held.id)
    }
  }
  if (focus !== null) {
    for (const id of [...(up.get(focus) ?? []), ...(down.get(focus) ?? [])]) {
      if (have.has(id)) continue
      const held = input.nodes.find((node) => node.id === id)
      if (held === undefined) continue
      drawn.unshift(held)
      have.add(held.id)
    }
  }

  const depth = depthsOf(drawn, up)
  const buckets = new Map<number, string[]>()
  for (const node of drawn) {
    const level = depth.get(node.id) ?? 0
    const held = buckets.get(level)
    if (held === undefined) buckets.set(level, [node.id])
    else held.push(node.id)
  }

  /* The rank decides where a card starts inside its column; the passes then let the drawing move
   * it. Done in the triage order, a column opens on the card that wants a person rather than on
   * whichever happened to be written first. */
  const rank = new Map(ranked.map((node, index) => [node.id, index]))
  const columns: string[][] = [...buckets.keys()]
    .sort((left, right) => left - right)
    .map((level) => (buckets.get(level) ?? []).sort((left, right) => (rank.get(left) ?? 0) - (rank.get(right) ?? 0)))
  straighten(columns, up)

  let rows = 1
  for (const column of columns) rows = Math.max(rows, column.length)

  const width = columns.length === 0
    ? PAD * 2 + CARD_W
    : PAD * 2 + columns.length * CARD_W + (columns.length - 1) * COL_GAP
  const height = PAD * 2 + rows * CARD_H + (rows - 1) * ROW_GAP

  const pos: Record<string, Point> = {}
  columns.forEach((column, index) => {
    const off = (rows - column.length) / 2
    column.forEach((id, at) => {
      pos[id] = {
        x: PAD + index * (CARD_W + COL_GAP) + CARD_W / 2,
        y: PAD + (at + off) * (CARD_H + ROW_GAP) + CARD_H / 2,
      }
    })
  })

  return {
    drawn,
    columns,
    pos,
    width,
    height,
    /* Restricted to what is drawn: the emphasis set and the wire set are both read off this. */
    up: Object.fromEntries([...up].filter(([id]) => pos[id] !== undefined).map(([id, list]) => [id, list.filter((other) => pos[other] !== undefined)])),
    down: Object.fromEntries([...down].filter(([id]) => pos[id] !== undefined).map(([id, list]) => [id, list.filter((other) => pos[other] !== undefined)])),
  }
}

/** One wire: from the right edge of a prerequisite to the left edge of what waits on it. */
export function wirePath(from: Point, to: Point): string {
  const x1 = from.x + CARD_W / 2
  const x2 = to.x - CARD_W / 2
  const bend = Math.max(36, (x2 - x1) * 0.5)
  return `M${String(x1)} ${String(from.y)}C${String(x1 + bend)} ${String(from.y)},${String(x2 - bend)} ${String(to.y)},${String(x2)} ${String(to.y)}`
}

/**
 * The cards to keep in ink: the focus, what it owes and what owes it, plus the scope's own reading —
 * every gate when the scope is the whole workspace, every card one line has touched when it is that
 * line. Wires are drawn in ink only when both of their ends are lit.
 */
export function litOf(placement: Placement, focus: string | null, scope: string | null): ReadonlySet<string> {
  const lit = new Set<string>()
  if (focus !== null && placement.pos[focus] !== undefined) {
    lit.add(focus)
    for (const id of placement.up[focus] ?? []) lit.add(id)
    for (const id of placement.down[focus] ?? []) lit.add(id)
  }
  for (const node of placement.drawn) {
    if (scope === null ? node.gate !== null : node.cycleIds.includes(scope)) lit.add(node.id)
  }
  return lit
}

/** The focus, its prerequisites and its dependents, as one rectangle; `null` when none of them is drawn. */
export function ringOf(placement: Placement, focus: string | null): Rect | null {
  if (focus === null) return null
  const ids = [focus, ...(placement.up[focus] ?? []), ...(placement.down[focus] ?? [])]
  const xs: number[] = []
  const ys: number[] = []
  for (const id of ids) {
    const at = placement.pos[id]
    if (at === undefined) continue
    xs.push(at.x)
    ys.push(at.y)
  }
  if (xs.length === 0) return null
  return {
    x0: Math.min(...xs) - CARD_W / 2,
    y0: Math.min(...ys) - CARD_H / 2,
    x1: Math.max(...xs) + CARD_W / 2,
    y1: Math.max(...ys) + CARD_H / 2,
  }
}

/**
 * The camera that keeps the drawing inside the viewport: a drawing smaller than the viewport is
 * centred on it, a larger one is held against its edges.
 *
 * Without this, a focus near the drawing's edge leaves half the viewport showing nothing, and a
 * reader who sees an empty ground concludes the drawing is gone.
 */
export function clampView(view: View, size: Size, placement: Placement): View {
  const width = placement.width * view.s
  const height = placement.height * view.s
  const tx = width <= size.w ? (size.w - width) / 2 : Math.min(0, Math.max(size.w - width, view.tx))
  const ty = height <= size.h ? (size.h - height) / 2 : Math.min(0, Math.max(size.h - height, view.ty))
  return tx === view.tx && ty === view.ty ? view : { s: view.s, tx, ty }
}

/** The whole drawing, small enough to fit: the overview. */
export function fitView(size: Size, placement: Placement): View {
  const s = Math.max(SCALE_MIN, Math.min(1, Math.min(size.w / placement.width, size.h / placement.height) * 0.96))
  return clampView({ s, tx: (size.w - placement.width * s) / 2, ty: (size.h - placement.height * s) / 2 }, size, placement)
}

/**
 * The camera at the focus: the focus and its ring centred, at {@link FOCUS_SCALE} when that fits.
 *
 * A ring wider than the viewport is shrunk until it fits, but no further than the scale at which a
 * title stops being readable — a card reduced to a frame is not a card the reader came to look at.
 */
export function focusView(size: Size, placement: Placement, focus: string | null): View {
  const ring = ringOf(placement, focus)
  let s = FOCUS_SCALE
  if (ring !== null) {
    const fit = Math.min((size.w - RING_MARGIN) / (ring.x1 - ring.x0), (size.h - RING_MARGIN) / (ring.y1 - ring.y0))
    s = Math.max(FOCUS_SCALE * 0.62, Math.min(FOCUS_SCALE, Number.isFinite(fit) ? fit : FOCUS_SCALE))
  }
  const cx = ring === null ? placement.width / 2 : (ring.x0 + ring.x1) / 2
  const cy = ring === null ? placement.height / 2 : (ring.y0 + ring.y1) / 2
  return clampView({ s, tx: size.w / 2 - cx * s, ty: size.h / 2 - cy * s }, size, placement)
}

/**
 * Zoom one step around a point of the viewport: the ground under that point stays under it.
 *
 * Zooming around the viewport's centre instead would slide whatever the reader was looking at out
 * from under the pointer, which is the one thing a wheel is expected not to do.
 */
export function zoomAt(view: View, at: Point, next: number): View {
  const s = Math.max(SCALE_MIN, Math.min(SCALE_MAX, next))
  return {
    s,
    tx: at.x - (at.x - view.tx) * (s / view.s),
    ty: at.y - (at.y - view.ty) * (s / view.s),
  }
}

/** Which words a card shows at this camera scale. */
export type Lod = 'dot' | 'mid' | 'full'

export function lodOf(s: number): Lod {
  if (s < TITLE_AT) return 'dot'
  if (s < FULL_AT) return 'mid'
  return 'full'
}