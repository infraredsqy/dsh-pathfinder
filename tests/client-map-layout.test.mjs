/* The map's placement and its camera (src/client/map-layout.ts): behaviour only — which card comes
 * first, which column a card lands in, where the camera stands, which cards stay in ink. No
 * snapshots, no pixel values beyond the geometry the engine states itself.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readProject } from '../src/model/index.ts'
import {
  CARD_H,
  CARD_W,
  COL_GAP,
  FOCUS_SCALE,
  PAD,
  ROW_GAP,
  TITLE_AT,
  clampView,
  fitView,
  focusView,
  litOf,
  lodOf,
  place,
  rankedOf,
  ringOf,
  wirePath,
  zoomAt,
} from '../src/client/map-layout.ts'

const AT = new Date('2026-03-10T12:00:00.000Z')

/** A record at the fixture's own moment: only the parts a case needs are named. */
function record(parts = {}) {
  return { nodes: {}, cycles: [], instructions: [], issues: {}, ...parts, at: parts.at ?? AT }
}

function node(fields = {}) {
  return { mode: 'auto', status: 'todo', dependencies: [], ...fields }
}

/** The reading a case starts from, cut at the fixture's moment. */
function readingOf(parts) {
  return readProject(record(parts))
}

/** The drawn ids of one placement, column by column. */
const columnsOf = (placement) => placement.columns.map((column) => [...column])

test('分诊：等人那一格先，然后在手、刚落定、可开工、还在等', () => {
  const reading = readingOf({
    nodes: {
      waiting: node({ dependencies: ['pending'] }),
      pending: node(),
      ready: node(),
      done: node({ completed_at: '2026-03-10T09:00:00.000Z' }),
      held: node(),
      gate: node({ mode: 'checkpoint', status: 'completed', completed_at: '2026-03-10T10:00:00.000Z' }),
    },
    cycles: [{ id: 'w', status: 'active', holding: [{ id: 'held', since: '2026-03-10T08:00:00.000Z' }], path: [] }],
  })

  assert.deepEqual(
    rankedOf(reading.nodes).map((item) => item.id),
    ['gate', 'held', 'done', 'pending', 'ready', 'waiting'],
    '人闸先，在手其次，落定的第三，可开工的第四，等的最后',
  )
})

test('空页：一格都没有、或只有一列，当场给出点位，不空转', () => {
  const empty = place({ nodes: [], edges: [] })

  assert.deepEqual(empty.columns, [])
  assert.equal(empty.drawn.length, 0)
  assert.equal(empty.width, PAD * 2 + CARD_W, '空页也有一格的宽度，镜头才有地方落脚')

  const reading = readingOf({ nodes: { only: node() } })
  assert.deepEqual(columnsOf(place({ nodes: reading.nodes, edges: [] })), [['only']])
})

test('分诊：同一档里最近的那一刻先，同一刻按记录自己的次序', () => {
  const reading = readingOf({
    nodes: {
      older: node({ completed_at: '2026-03-10T08:00:00.000Z' }),
      newest: node({ completed_at: '2026-03-10T11:00:00.000Z' }),
      middle: node({ completed_at: '2026-03-10T09:00:00.000Z' }),
      twinA: node(),
      twinB: node(),
    },
  })

  assert.deepEqual(
    rankedOf(reading.nodes).map((item) => item.id),
    ['newest', 'middle', 'older', 'twinA', 'twinB'],
    '落定的按时刻倒排；一刻都没有的那两格保持记录给的次序',
  )
})

test('纵列：一格的深度是它最深的前置再加一层，记录里没有的前置不占一列', () => {
  const reading = readingOf({
    nodes: {
      root: node(),
      deep: node({ dependencies: ['root'] }),
      orphan: node({ dependencies: ['gone', 'root'] }),
    },
  })

  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })
  assert.equal(placement.columns.length, 2, '两条链并排：两列')
  assert.deepEqual(columnsOf(placement), [['root'], ['deep', 'orphan']], '两个都只欠 root，站在第二列')
})

test('点位：第一列落在左边距上，一格一个格位，列间拉开一格的空', () => {
  const reading = readingOf({ nodes: { a: node(), b: node({ dependencies: ['a'] }) } })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })

  assert.deepEqual(placement.pos['a'], { x: PAD + CARD_W / 2, y: PAD + CARD_H / 2 })
  assert.deepEqual(placement.pos['b'], { x: PAD + CARD_W + COL_GAP + CARD_W / 2, y: PAD + CARD_H / 2 })
  assert.equal(placement.width, PAD * 2 + CARD_W * 2 + COL_GAP)
  assert.equal(placement.height, PAD * 2 + CARD_H)
})

test('点位：短的那一列在自己的高度里居中，不贴着顶排', () => {
  const reading = readingOf({
    nodes: {
      a: node(),
      b: node(),
      c: node(),
      tail: node({ dependencies: ['a'] }),
    },
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })
  const first = placement.pos['tail']
  const middle = placement.pos['b']

  assert.equal(first.y, middle.y, '一列一格，落在三格那一列的正中间')
  assert.ok(first.x > placement.pos['a'].x, '它在右边那一列')
  assert.equal(placement.height, PAD * 2 + CARD_H * 3 + ROW_GAP * 2, '整张图的宽高由最长的那一列定')
})

test('上限：只画得出前 N 格，焦点和它的直接前后永远在图上', () => {
  const reading = readingOf({
    nodes: {
      first: node(),
      second: node(),
      third: node(),
      fourth: node({ dependencies: ['third'] }),
    },
  })
  const capped = place({ nodes: reading.nodes, edges: reading.graph.edges, cap: 2 })
  assert.equal(capped.drawn.length, 2, 'cap 就是画几格的上限')

  const withFocus = place({ nodes: reading.nodes, edges: reading.graph.edges, cap: 1, focus: 'fourth' })
  const ids = withFocus.drawn.map((item) => item.id).sort()
  assert.deepEqual(ids, ['first', 'fourth', 'third'], '上限那一格照画；焦点补进来，它欠的那一格也补进来')
  assert.ok(withFocus.pos['fourth'].x > withFocus.pos['third'].x, '补进来的那一格照样占它自己那一列')
})

test('线：从上一格的右边出，落到下一格的左边', () => {
  const path = wirePath({ x: 100, y: 40 }, { x: 600, y: 90 })
  const pieces = path.split(',')

  assert.match(path, /^M(\d+(\.\d+)?) 40C/u)
  assert.equal(path.slice(1).split(' ')[0], String(100 + CARD_W / 2), '起点是前置那一格的右边缘')
  assert.equal(pieces[pieces.length - 1].trim().split(' ')[0], String(600 - CARD_W / 2), '终点是等它的那一格的左边缘')
})

test('上墨：焦点、它欠的、欠它的，再加命中范围自己那一段', () => {
  const reading = readingOf({
    nodes: {
      before: node({ completed_at: '2026-03-10T09:00:00.000Z' }),
      focus: node({ dependencies: ['before'] }),
      after: node({ dependencies: ['focus'] }),
      elsewhere: node(),
      gate: node({ mode: 'manual', status: 'todo' }),
    },
    cycles: [{ id: 'w', path: [{ node: 'elsewhere', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'completed' }] }],
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })

  assert.deepEqual([...litOf(placement, 'focus', null)].sort(), ['after', 'before', 'focus', 'gate'].sort(),
    '全局这一档点亮的是全工作区的人闸，加上焦点和它的直接前后')
  assert.deepEqual([...litOf(placement, 'focus', 'w')].sort(), ['before', 'elsewhere', 'focus', 'after'].sort(),
    '选中一条线时点亮的是那条线碰过的格子，人闸不再单独点亮')
})

test('一圈：焦点加它的前后合成一个矩形，没画出来的那些不参与', () => {
  const reading = readingOf({
    nodes: { a: node(), b: node({ dependencies: ['a'] }), c: node() },
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })
  const ring = ringOf(placement, 'a')

  assert.ok(ring !== null)
  assert.equal(ring.x0, placement.pos['a'].x - CARD_W / 2)
  assert.equal(ring.x1, placement.pos['b'].x + CARD_W / 2, '欠它的那一格在右边，也进这一圈')
  const lone = ringOf(placement, 'c')
  assert.equal(lone?.x0, placement.pos['c'].x - CARD_W / 2, '既没有前置也没有后继的那一格，一圈就是它自己')
  assert.equal(lone?.x1, placement.pos['c'].x + CARD_W / 2)
  assert.equal(ringOf(placement, null), null)
})

test('全览：整张图放进视口，小的那一边留出余量，图上屏是居中的', () => {
  const reading = readingOf({
    nodes: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`n${String(index)}`, node()])),
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })
  const size = { w: 1200, h: 760 }
  const view = fitView(size, placement)

  assert.ok(view.s <= 1, '全览不放大')
  assert.ok(placement.width * view.s <= size.w + 0.5 && placement.height * view.s <= size.h + 0.5, '整张图在视口里')
  assert.equal(view.tx, (size.w - placement.width * view.s) / 2, '小的那边居中：左边与右边一样宽')
  assert.equal(view.ty, (size.h - placement.height * view.s) / 2)
})

test('相机不越出图：图比视口大的方向被夹在边上，比视口小的方向居中', () => {
  const reading = readingOf({
    nodes: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`n${String(index)}`, node()])),
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })
  const size = { w: 400, h: 300 }
  const wide = clampView({ s: 1, tx: 999, ty: 999 }, size, placement)

  assert.equal(wide.tx, 0, '拖到最左边就是图的左边贴住视口')
  assert.equal(wide.ty, 0)
  assert.equal(clampView({ s: 1, tx: -9999, ty: -9999 }, size, placement).tx, size.w - placement.width * 1)
  assert.equal(clampView({ s: 0.01, tx: 500, ty: 500 }, size, placement).tx,
    (size.w - placement.width * 0.01) / 2, '缩到比视口还小就居中')
})

test('滚轮：缩放之后，指针底下那一点还是原来那一点', () => {
  const before = { s: 0.8, tx: 40, ty: 12 }
  const at = { x: 220, y: 140 }
  const canvasBefore = { x: (at.x - before.tx) / before.s, y: (at.y - before.ty) / before.s }
  const after = zoomAt(before, at, before.s * 1.5)

  assert.ok(Math.abs((at.x - after.tx) / after.s - canvasBefore.x) < 1e-9)
  assert.ok(Math.abs((at.y - after.ty) / after.s - canvasBefore.y) < 1e-9)
  assert.equal(zoomAt(before, at, 100).s, 2.4, '放大有上限')
  assert.equal(zoomAt(before, at, 0.0001).s, 0.1, '缩小有下限')
})

test('对准焦点：焦点那一圈居中；圈比视口宽就收小，但不收到标题读不出以下的极限再往下', () => {
  const reading = readingOf({
    nodes: {
      a: node(),
      b: node({ dependencies: ['a'] }),
      c: node({ dependencies: ['b'] }),
    },
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })
  const size = { w: 1600, h: 980 }
  const roomy = focusView(size, placement, 'b')

  assert.ok(roomy.s <= FOCUS_SCALE && roomy.s >= FOCUS_SCALE * 0.62, '焦距那一档是上限，收也收不过地面')
  assert.equal(roomy.tx, clampView({ s: roomy.s, tx: size.w / 2 - placement.pos['b'].x * roomy.s, ty: roomy.ty }, size, placement).tx)
  const wide = focusView({ w: 2400, h: 980 }, placement, 'b')
  assert.equal(wide.s, FOCUS_SCALE, '放得下的时候就是焦距那一档')
  assert.equal(wide.tx, 2400 / 2 - placement.pos['b'].x * FOCUS_SCALE, '焦点落在视口正中')

  /* A ring wider than the viewport: the scale gives way, and stops at the floor rather than at a
   * card reduced to a frame. */
  const tight = focusView({ w: 120, h: 980 }, placement, 'b')
  assert.ok(tight.s < FOCUS_SCALE)
  assert.equal(tight.s, FOCUS_SCALE * 0.62, '圈再宽，也不低于「标题还读得出」的那一档')
})

test('字号：缩到哪一档就读哪一档，两档的界就是那两个数', () => {
  assert.equal(lodOf(0.3), 'dot')
  assert.equal(lodOf(TITLE_AT), 'mid')
  assert.equal(lodOf(0.8), 'mid')
  assert.equal(lodOf(0.92), 'full')
})