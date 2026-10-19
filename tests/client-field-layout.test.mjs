/* 依赖那一格的布局引擎（src/client/field-layout.ts）：只锁行为——列怎么排、格摆在哪、线怎么走、
 * 颜色跟谁走、抠出来留谁。不锁界面快照；量的都是引擎算出来的场景，与 field.tsx 怎么渲染无关。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { CARD_ZOOM, sceneOf } from '../src/client/field-layout.ts'
import { readProject } from '../src/model/index.ts'

const AT = new Date('2026-03-10T12:00:00.000Z')

function record(parts = {}) {
  return { nodes: {}, cycles: [], instructions: [], issues: {}, ...parts, at: parts.at ?? AT }
}

function node(fields = {}) {
  return { mode: 'auto', status: 'todo', dependencies: [], ...fields }
}

function reading(parts) {
  return readProject(record(parts))
}

/** 引擎的口子：1280×720 的地界，全景那一档，没有选中、没抠出来；给了的就盖上。 */
function layout(part, over = {}) {
  return sceneOf({
    graph: part.graph,
    nodes: part.nodes,
    width: 1280,
    height: 720,
    zoom: 0,
    focusId: null,
    cut: false,
    ...over,
  })
}

const ids = (list) => list.map((one) => one.id)
const markIds = (marks) => marks.map((mark) => mark.node.id)
const cardIds = (cards) => cards.map((card) => card.node.id)

/** 四层各一格，最长路那条从 root 直达 far。 */
function chain4() {
  return reading({
    nodes: {
      root: node(),
      deep: node({ dependencies: ['root'] }),
      deeper: node({ dependencies: ['deep'] }),
      far: node({ dependencies: ['root', 'deeper'] }),
    },
  })
}

test('一个节点都没有：场景里什么都没有，也不炸', () => {
  const s = layout(reading())
  assert.deepEqual(s.placed.columns, [])
  assert.deepEqual(s.marks, [])
  assert.deepEqual(s.cards, [])
  assert.deepEqual(s.edges, [])
})

test('全景那一档：列就是层，整张图正好装进地界，谁也不跑出边界', () => {
  const s = layout(chain4())
  assert.deepEqual(s.placed.columns.map(ids), [['root'], ['deep'], ['deeper'], ['far']])
  assert.equal(s.placed.width, 1280)
  assert.equal(s.placed.height, 720)
  for (const col of s.placed.columns) {
    for (const one of col) {
      const point = s.placed.pos[one.id]
      assert.equal(point.x, s.placed.step * (point.col + 0.5), `${one.id} 的横坐标跟列距走`)
      assert.ok(point.x > 0 && point.x < 1280, `${one.id} 的横坐标越了界：${String(point.x)}`)
      assert.ok(point.y > 0 && point.y < 720, `${one.id} 的纵坐标越了界：${String(point.y)}`)
    }
  }
  assert.deepEqual(markIds(s.marks).sort(), ['deep', 'deeper', 'far', 'root'], '全景档画的是记号')
  assert.deepEqual(s.cards, [])
  for (const mark of s.marks) {
    assert.deepEqual(mark.point, s.placed.pos[mark.node.id], `${mark.node.id} 的记号就落在它那一格`)
    assert.equal(mark.dim, '', '没选中就一个都不压暗')
  }
})

test('全景那一档：顶上留一条线能绕的空白，单行的列落在余下那块的中央', () => {
  const s = layout(chain4())
  assert.equal(s.placed.pos.root.y, (720 + 22) / 2, '顶上那 22px 留白让上下各让一半')
  assert.equal(s.placed.mark, 5, '行距怎么量，单行的记号都在最小的那一档')
})

test('列里的次序：先看它欠的、再看欠它的，各过一趟，把邻居挪近', () => {
  const part = reading({
    nodes: {
      p: node(),
      q: node(),
      x: node({ dependencies: ['q'] }),
      y: node({ dependencies: ['p'] }),
    },
  })
  assert.deepEqual(part.graph.layers[1].map((one) => one.id), ['x', 'y'], '记录给的次序是 x 在前')
  const s = layout(part)
  assert.deepEqual(s.placed.columns[1].map((one) => one.id), ['y', 'x'], 'p 在上，欠 p 的 y 就该挪到欠 q 的 x 前面')
})

test('列里的次序：邻居高度一样时保持记录给的次序', () => {
  const part = reading({
    nodes: {
      a: node(),
      b: node({ dependencies: ['a'] }),
      c: node({ dependencies: ['a'] }),
    },
  })
  const s = layout(part)
  assert.deepEqual(s.placed.columns[1].map((one) => one.id), ['b', 'c'])
})

test('列里的次序：回头那一趟（看欠它的）也真在动，把没欠人的格子挤到后面', () => {
  const part = reading({
    nodes: {
      n6: node({ dependencies: ['n1', 'n0'] }),
      n8: node(),
      n4: node({ dependencies: ['n1', 'n3'] }),
      n7: node({ dependencies: ['n2'] }),
      n5: node(),
      n9: node(),
      n3: node({ dependencies: ['n1'] }),
      n1: node({ dependencies: ['n0'] }),
      n2: node({ dependencies: ['n0', 'n1'] }),
      n10: node(),
      n0: node(),
    },
  })
  const s = layout(part)
  assert.deepEqual(s.placed.columns.map((col) => col.map((one) => one.id)), [
    ['n8', 'n5', 'n9', 'n0', 'n10'],
    ['n1'],
    ['n3', 'n6', 'n2'],
    ['n4', 'n7'],
  ], 'n0 欠它的都在前头，没欠人的 n10 只好殿后')
})

test('点阵那一档：列距摊到四列一屏，画布因此比地界宽，纵向跟全景同一套', () => {
  const part = reading({
    nodes: {
      a: node(),
      b: node({ dependencies: ['a'] }),
      c: node({ dependencies: ['b'] }),
      d: node({ dependencies: ['c'] }),
      e: node({ dependencies: ['d'] }),
      f: node({ dependencies: ['e'] }),
    },
  })
  const fit = layout(part)
  const dots = layout(part, { zoom: 1 })
  assert.equal(dots.placed.step, 1280 / 4)
  assert.equal(dots.placed.width, (1280 / 4) * 6, '六列摊不进一屏')
  assert.ok(dots.placed.width > 1280)
  for (const col of dots.placed.columns) {
    for (const one of col) {
      assert.equal(dots.placed.pos[one.id].y, fit.placed.pos[one.id].y, `${one.id} 的纵向没动`)
      assert.equal(dots.placed.pos[one.id].x, dots.placed.step * (dots.placed.pos[one.id].col + 0.5))
    }
  }
  assert.equal(dots.placed.mark, fit.placed.mark, '记号还是全景量出来的那一颗')
})

test('不在册的前置：邻接跟着读数自己那条边走，没有这条边也不点亮', () => {
  const part = reading({
    nodes: {
      a: node(),
      b: node({ dependencies: ['a', 'ghost'] }),
    },
  })
  const s = layout(part, { zoom: 1, focusId: 'b' })
  assert.deepEqual(s.edges.map((edge) => `${edge.from}->${edge.to}`), ['a->b'], 'ghost 不在册，边就没有这一条')
  assert.deepEqual(markIds(s.marks), ['a', 'b'], '场景里只有两个节点，ghost 根本不在')
  assert.ok(s.marks.every((mark) => mark.dim === ' is-lit'), '亮的是选中的与它在册的前置')
})

test('点阵那一档：隔一列的拉弧，隔得远的走阶梯，从记号之间的缝里绕', () => {
  const part = reading({
    nodes: {
      a: node(),
      m1: node({ dependencies: ['a'] }),
      m2: node({ dependencies: ['a'] }),
      m3: node({ dependencies: ['a'] }),
      m4: node({ dependencies: ['a'] }),
      m5: node({ dependencies: ['a'] }),
      z: node({ dependencies: ['a', 'm1'] }),
    },
  })
  const s = layout(part, { zoom: 1 })
  const near = s.edges.find((edge) => edge.from === 'a' && edge.to === 'm3')
  assert.ok(near.d.includes('C') && !near.d.includes('L'), '隔一列的拉一条弧')
  /* 中间那列五格把 y=371 那条缝堵死了：直线上下最近的两条缝等远，取先数到的那条（284.75）。 */
  const far = s.edges.find((edge) => edge.from === 'a' && edge.to === 'z')
  assert.equal(far.d, 'M164 371L320 371L320 284.75L640 284.75L640 371L796 371')
})

test('卡片那一档：一格一张卡，记号收走，画布改成卡片那套尺寸', () => {
  const s = layout(chain4(), { zoom: 2 })
  assert.deepEqual(s.marks, [])
  assert.deepEqual(cardIds(s.cards), ['root', 'deep', 'deeper', 'far'])
  assert.equal(s.placed.width, 16 * 2 + 4 * 280 + 3 * 44)
  assert.equal(s.placed.height, 16 * 2 + 34)
  const rootCard = s.cards.find((card) => card.node.id === 'root')
  assert.deepEqual(rootCard.point, { x: 16 + 140, y: 16 + 17, col: 0 })
  assert.equal(rootCard.full, false)

  const full = layout(chain4(), { zoom: 3 })
  const fullRoot = full.cards.find((card) => card.node.id === 'root')
  assert.equal(fullRoot.full, true)
  assert.deepEqual(fullRoot.point, { x: 16 + 170, y: 16 + 26, col: 0 })
})

test('卡片那一档：线从卡片右缘出、进目标左缘，转角上削掉一点', () => {
  const s = layout(chain4(), { zoom: 2 })
  const wire = s.edges.find((edge) => edge.from === 'root' && edge.to === 'deep')
  assert.ok(wire.d.startsWith('M296 33L'), `从源头卡片的右缘出：${wire.d}`)
  assert.ok(wire.d.endsWith('L340 33'), `进目标卡片的左缘：${wire.d}`)
  assert.ok(wire.d.includes('Q'), '转角削圆')
})

test('线的颜色跟两头走：等的那头可开工的是 is-ready，放下的是 is-shelved，有人握着的是 is-running', () => {
  const part = reading({
    nodes: {
      done: node({ status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }),
      ready1: node({ dependencies: ['done'] }),
      shel: node({ status: 'shelved', updated_at: '2026-03-10T09:00:00.000Z' }),
      blocked: node({ dependencies: ['shel'] }),
      held: node({ dependencies: ['ready1'] }),
    },
    cycles: [
      { id: 'w', status: 'active', holding: [{ id: 'held', since: '2026-03-10T08:00:00.000Z' }], path: [] },
    ],
  })
  const s = layout(part)
  const cls = (from, to) => s.edges.find((edge) => edge.from === from && edge.to === to).cls
  assert.equal(cls('done', 'ready1'), ' is-ready')
  assert.equal(cls('shel', 'blocked'), ' is-shelved')
  assert.equal(cls('ready1', 'held'), ' is-running')
})

test('点阵那一档选中一格：亮的是它自己、它欠的、欠它的，其余压暗，线也跟着暗', () => {
  const s = layout(chain4(), { zoom: 1, focusId: 'deep' })
  const dim = (id) => s.marks.find((mark) => mark.node.id === id).dim
  assert.equal(dim('deep'), ' is-lit')
  assert.equal(dim('root'), ' is-lit', '欠的')
  assert.equal(dim('deeper'), ' is-lit', '欠它的')
  assert.equal(dim('far'), ' is-dim')
  const farWire = s.edges.find((edge) => edge.to === 'far' && edge.from === 'root')
  assert.ok(farWire.cls.endsWith(' is-dim'), '两头没全亮的线压暗')
  const nearWire = s.edges.find((edge) => edge.from === 'deep' && edge.to === 'deeper')
  assert.ok(!nearWire.cls.includes(' is-dim'), '两头都亮的线不压暗')
})

test('没选中就一个都不压暗', () => {
  const s = layout(chain4(), { zoom: 1 })
  assert.ok(s.marks.every((mark) => mark.dim === ''))
  assert.ok(s.edges.every((edge) => !edge.cls.includes(' is-dim')))
})

test('卡片那两档整张图退成灰：没选中时每一条线都压暗', () => {
  const s = layout(chain4(), { zoom: 2 })
  assert.ok(s.edges.every((edge) => edge.cls.endsWith(' is-dim')))
})

test('抠出来看（点阵那一档）：只留亮着的那一圈，空掉的列不再占地方', () => {
  const part = reading({
    nodes: {
      a: node(),
      b: node({ dependencies: ['a'] }),
      c: node({ dependencies: ['b'] }),
      d: node({ dependencies: ['c'] }),
      e: node({ dependencies: ['d'] }),
    },
  })
  const s = layout(part, { zoom: 1, focusId: 'b', cut: true })
  assert.deepEqual(markIds(s.marks), ['a', 'b', 'c'], 'd、e 不在这一圈里')
  assert.ok(s.marks.every((mark) => mark.dim === ' is-lit'), '留下来的全亮')
  assert.deepEqual(s.edges.map((edge) => `${edge.from}->${edge.to}`), ['a->b', 'b->c'])
  const step = 1280 / 3
  assert.equal(s.placed.step, step)
  assert.equal(s.placed.pos.b.x, step * 1.5, '留下的三列重新摊')
  assert.equal(s.placed.pos.d, undefined)
})

test('抠出来看（卡片那一档）：画布改成留出来那几列的卡片尺寸', () => {
  const part = reading({
    nodes: {
      a: node(),
      b: node({ dependencies: ['a'] }),
      c: node({ dependencies: ['b'] }),
      d: node({ dependencies: ['c'] }),
      e: node({ dependencies: ['d'] }),
    },
  })
  const s = layout(part, { zoom: CARD_ZOOM, focusId: 'b', cut: true })
  assert.deepEqual(cardIds(s.cards), ['a', 'b', 'c'])
  assert.equal(s.cards.find((card) => card.node.id === 'b').marked, true, '选中的那格带着记号')
  assert.deepEqual(cardIds(s.cards.filter((card) => card.lit)), ['a', 'b', 'c'], '一圈全亮')
  assert.equal(s.placed.width, 16 * 2 + 3 * 280 + 2 * 44)
})
