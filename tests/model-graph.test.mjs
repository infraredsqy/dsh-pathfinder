/* 依赖场那一段的单元测试：只锁不变量——层怎么算出来、边怎么长出来、记录里没有的东西
 * 怎么处置。不锁版面，也不锁快照。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readProject } from '../src/model/index.ts'

const AT = new Date('2026-03-10T12:00:00.000Z')

/** 一份记录：四份都在，想换哪一份就换哪一份。 */
function record(parts = {}) {
  return { nodes: {}, cycles: [], instructions: [], issues: {}, ...parts, at: parts.at ?? AT }
}

/** 一个节点。 */
function node(fields = {}) {
  return { mode: 'auto', status: 'todo', dependencies: [], ...fields }
}

/** 每一层里那几格的身份。 */
const layerIds = (reading) => reading.graph.layers.map((layer) => layer.map((item) => item.id))

test('依赖场：一格的层是它最深的前置再加一层', () => {
  const reading = readProject(record({
    nodes: {
      root: node(),
      deep: node({ dependencies: ['root'] }),
      deeper: node({ dependencies: ['deep'] }),
      /* 这一格既欠 root 又欠 deeper：层取最深的那一条路。 */
      far: node({ dependencies: ['root', 'deeper'] }),
    },
  }))

  assert.equal(reading.graph.maxDepth, 3)
  assert.deepEqual(layerIds(reading), [['root'], ['deep'], ['deeper'], ['far']])
  assert.deepEqual(
    reading.graph.edges.map((edge) => `${edge.from}->${edge.to}:${String(edge.span)}`),
    ['root->deep:1', 'deep->deeper:1', 'root->far:3', 'deeper->far:1'],
  )
})

test('依赖场：同一层里保持记录给的次序', () => {
  const reading = readProject(record({
    nodes: {
      b: node({ dependencies: ['a'] }),
      a: node(),
      c: node({ dependencies: ['a'] }),
      d: node({ dependencies: ['a'] }),
    },
  }))

  assert.deepEqual(layerIds(reading), [['a'], ['b', 'c', 'd']], '先记的在前，不按身份排')
})

test('依赖场：记录里没有那个前置，它就挡不住人', () => {
  const reading = readProject(record({
    nodes: { n1: node({ dependencies: ['gone', 'here'] }), here: node() },
  }))

  assert.equal(reading.nodeById.n1.dependencies.length, 2, '记录里写的依赖一个都不丢')
  assert.deepEqual(reading.graph.edges.map((edge) => edge.from), ['here'], '摆不出来的前置不画成边')
  assert.equal(reading.graph.maxDepth, 1)
})

test('依赖场：数据里绕成一个环，读数照样回得来', () => {
  const reading = readProject(record({
    nodes: { a: node({ dependencies: ['b'] }), b: node({ dependencies: ['a'] }) },
  }))

  assert.equal(reading.graph.layers.length, reading.graph.maxDepth + 1)
  assert.equal(reading.graph.edges.length, 2, '两条边都在，环不吞掉它们')
})

test('依赖场：一个节点都没有的时候，那一份是空的', () => {
  const reading = readProject(record())

  assert.deepEqual(reading.graph.layers, [], '没有的东西不画，也不留一层空壳')
  assert.equal(reading.graph.maxDepth, -1)
  assert.deepEqual(reading.graph.edges, [])
})

test('节点读数带着记录里那个标题', () => {
  const reading = readProject(record({
    nodes: { n1: node({ title: '写静态检查器' }), n2: node() },
  }))

  assert.equal(reading.nodeById.n1.title, '写静态检查器')
  assert.equal(reading.nodeById.n2.title, undefined, '记录没写就没有，不拿身份顶上')
})

test('读一遍依赖场不改递给它的那份记录', () => {
  const input = record({
    nodes: { n1: node({ dependencies: ['n2'] }), n2: node() },
  })
  const snapshot = structuredClone(input)

  readProject(input)

  assert.deepEqual(input, snapshot)
})