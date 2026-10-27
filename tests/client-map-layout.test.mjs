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
  FOCUS_AT_EARLY,
  FOCUS_AT_LATE,
  FOCUS_SCALE,
  PAD,
  ROW_GAP,
  TITLE_AT,
  clampView,
  emphasisOf,
  fitView,
  focusView,
  lodOf,
  panBounds,
  panView,
  place,
  rankedOf,
  rubberView,
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
  const global = emphasisOf(placement, 'focus', null)

  assert.deepEqual([...global.lit].sort(), ['after', 'before', 'focus', 'gate'].sort(),
    '全局这一档点亮的是全工作区的人闸，加上焦点和它的直接前后')
  assert.equal(global.ahead.size, 0, '全局没有「未来的节点」这一档')

  const scoped = emphasisOf(placement, 'focus', 'w')
  assert.deepEqual([...scoped.lit].sort(), ['focus', 'elsewhere'].sort(),
    '选中一条线时点亮的是那条线碰过的格子，加上读者自己按过的那一格；人闸和前后不再单独点亮')
})

test('上墨：选中一条线，线上的全亮，没有线的低一档，别的线一档都不占', () => {
  const reading = readingOf({
    nodes: {
      mine: node(),
      future: node(),
      other: node(),
      gate: node({ mode: 'manual', status: 'todo' }),
    },
    cycles: [
      { id: 'w', path: [{ node: 'mine', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'completed' }] },
      { id: 'v', path: [
        { node: 'other', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'completed' },
        { node: 'gate', started_at: '2026-03-10T09:00:00.000Z', ended_at: '2026-03-10T10:00:00.000Z', result: 'completed' },
      ] },
    ],
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })
  const emphasis = emphasisOf(placement, 'mine', 'w')

  assert.ok(emphasis.lit.has('mine'), '这条线上的格子全在墨里')
  assert.ok(emphasis.ahead.has('future'), '哪条线都还没碰过的，是这条线的未来：低一档')
  assert.ok(!emphasis.lit.has('other') && !emphasis.ahead.has('other'), '别的线上的格子两档都不占')
  assert.ok(!emphasis.lit.has('gate') && !emphasis.ahead.has('gate'), '别的线的人闸不因为它是人闸就亮起来')
  assert.ok(emphasisOf(placement, 'mine', null).lit.has('gate'), '退回全局，人闸又回到墨里')
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

test('平移：图边上那一格也能被拖到视口正中，上下两头都到得了', () => {
  const reading = readingOf({
    nodes: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`n${String(index)}`, node()])),
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })
  const size = { w: 900, h: 700 }
  const box = panBounds(size, placement, 1)
  const top = panView({ s: 1, tx: 0, ty: size.h / 2 - placement.pos['n0'].y }, size, placement)
  const bottom = panView({ s: 1, tx: 0, ty: size.h / 2 - placement.pos['n9'].y }, size, placement)

  assert.ok(placement.height > size.h, '这张图比视口高：旧规则下边上的格子永远到不了正中')
  assert.ok(Math.abs(placement.pos['n0'].y + top.ty - size.h / 2) < 1e-9, '最上面那一格站在正中')
  assert.ok(Math.abs(placement.pos['n9'].y + bottom.ty - size.h / 2) < 1e-9, '最下面那一格也站在正中')
  assert.ok(top.ty <= box.maxY && bottom.ty >= box.minY, '这两个位置都在平移范围里，不用越过边界')
})

test('平移：横向同理，左右两头的格子都到得了正中；再往外的位置被夹住', () => {
  const { placement } = chainOf(6)
  const size = { w: 900, h: 640 }
  const first = panView({ s: 1, tx: size.w / 2 - placement.pos['n0'].x, ty: 0 }, size, placement)
  const last = panView({ s: 1, tx: size.w / 2 - placement.pos['n5'].x, ty: 0 }, size, placement)
  const beyond = panView({ s: 1, tx: 99999, ty: -99999 }, size, placement)
  const box = panBounds(size, placement, 1)

  assert.ok(Math.abs(placement.pos['n0'].x + first.tx - size.w / 2) < 1e-9, '第一格站到正中')
  assert.ok(Math.abs(placement.pos['n5'].x + last.tx - size.w / 2) < 1e-9, '最后一格站到正中')
  assert.equal(beyond.tx, box.maxX, '往外拖，停在平移范围的头上')
  assert.equal(beyond.ty, box.minY, '往上拖，停在平移范围的头上')
})

test('橡皮筋：越界只让出一小截，越拉越短，松手的落点就是边界', () => {
  const { placement } = chainOf(6)
  const size = { w: 900, h: 640 }
  const box = panBounds(size, placement, 1)
  const pull = (by) => rubberView({ s: 1, tx: box.maxX + by, ty: box.minY - by }, size, placement)
  const small = pull(120)
  const large = pull(1200)
  const reachX = size.w * 0.22

  assert.ok(small.tx > box.maxX && small.tx < box.maxX + 120, '越界之后还在动，但没有指针走得快')
  assert.ok(large.tx > small.tx, '拉得越远让得越多')
  assert.ok(large.tx - box.maxX < reachX, '让出的那一截有上限，图不会被整张拖出视口')
  assert.ok(large.ty < box.minY && box.minY - large.ty < size.h * 0.22, '两个方向同一套阻尼')
  assert.deepEqual(panView({ s: 1, tx: small.tx, ty: small.ty }, size, placement),
    { s: 1, tx: box.maxX, ty: box.minY }, '松手回到边界上')
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

/** One chain of `length` cards, each owing the one before it: the simplest drawing with many columns. */
function chainOf(length) {
  const ids = Array.from({ length }, (_, index) => `n${String(index)}`)
  const reading = readingOf({
    nodes: Object.fromEntries(ids.map((id, index) => [id, node(index === 0 ? {} : { dependencies: [ids[index - 1]] })])),
  })
  return { ids, placement: place({ nodes: reading.nodes, edges: reading.graph.edges }) }
}

test('对准焦点：这一格按它在图上站的位置落座——一开始的靠左一点，末尾的靠右一点，正中间的就在正中间', () => {
  const { placement } = chainOf(12)
  const size = { w: 900, h: 980 }
  const screenX = (focus) => {
    const view = focusView(size, placement, focus)
    return placement.pos[focus].x * view.s + view.tx
  }
  const spot = (index) => (FOCUS_AT_EARLY + (FOCUS_AT_LATE - FOCUS_AT_EARLY) * (index / (placement.columns.length - 1))) * size.w

  assert.equal(placement.columns.length, 12, '这一条链是十二列')
  assert.ok(Math.abs(screenX('n1') - spot(1)) < 1e-6, '一开始过去一点的那一格落在分位上')
  assert.ok(Math.abs(screenX('n5') - spot(5)) < 1e-6, '正中间那一格落在正中间')
  assert.ok(Math.abs(screenX('n10') - spot(10)) < 1e-6, '靠末尾那一格落在右边那个分位上')
  assert.ok(screenX('n1') < screenX('n5') && screenX('n5') < screenX('n10'), '沿着一列列往后，镜头跟着往右')

  /* The drawing's own edge is the harder truth: there is nothing left of the first column. */
  assert.equal(focusView(size, placement, 'n0').tx, 0, '第一列贴着视口的左边，不再往左留空')
  assert.ok(screenX('n0') < spot(0), '想站的位置在图外，站不上')
})

test('对准焦点：镜头对准这一格自己，圈的正中偏在一边', () => {
  const reading = readingOf({
    nodes: {
      root: node(),
      one: node({ dependencies: ['root'] }),
      two: node({ dependencies: ['root'] }),
      three: node({ dependencies: ['root'] }),
      after: node({ dependencies: ['one'] }),
    },
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })
  const size = { w: 900, h: 980 }
  const view = focusView(size, placement, 'root')
  const at = placement.pos['root'].x * view.s + view.tx
  /* The ring is root and the three cards it feeds: its middle stands a whole column to the right. */
  const middle = ((placement.pos['root'].x - CARD_W / 2) + (placement.pos['one'].x + CARD_W / 2)) / 2 * view.s + view.tx

  assert.ok(middle - at > CARD_W * 0.5, '圈的正中在它右边大半格：对着那里，这一格就站不在自己的分位上')
})

test('对准焦点：视口装不下一整格的时候，镜头收到这一格整整齐齐地放得下', () => {
  const { placement } = chainOf(3)
  const narrow = focusView({ w: 300, h: 260 }, placement, 'n2')
  const short = focusView({ w: 1200, h: 100 }, placement, 'n2')

  assert.equal(narrow.s, (300 - 48) / CARD_W, '窄的那一边收的正好是整格加上它自己的余量')
  assert.equal(short.s, (100 - 48) / CARD_H, '矮的那一边同理')
  assert.ok(narrow.s < FOCUS_SCALE && short.s < FOCUS_SCALE, '都比焦距那一档小')
  assert.deepEqual(focusView({ w: 1200, h: 700 }, placement, null), fitView({ w: 1200, h: 700 }, placement), '一格都没对准，退回全览')
})

test('字号：缩到哪一档就读哪一档，两档的界就是那两个数', () => {
  assert.equal(lodOf(0.3), 'dot')
  assert.equal(lodOf(TITLE_AT), 'mid')
  assert.equal(lodOf(0.8), 'mid')
  assert.equal(lodOf(0.92), 'full')
})