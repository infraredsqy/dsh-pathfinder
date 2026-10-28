/* Two judgments the panel makes before it touches literals: the four sources' outcomes, and which
 * cells a cycle's detail collects.
 *
 * What is locked are the criteria themselves — an empty set does not count as "all present", both
 * walked-by and held-by count, and the delivered section orders newest completion first.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { bucketOf, everySourceIs, nodesOf, readProject } from '../src/model/index.ts'
import { cycle, node, record } from './helpers/record-fixtures.mjs'

function readingWithSources(sources) {
  return { sources: Object.fromEntries(['nodes', 'cycles', 'instructions', 'issues'].map((key) => [key, sources[key] ?? sources.all])) }
}

test('四份来源都落在同一个结局上才算；一份都没有的时候不算「全都在」', () => {
  assert.equal(everySourceIs(readingWithSources({ all: 'missing' }), 'missing'), true)
  assert.equal(everySourceIs(readingWithSources({ all: 'unusable' }), 'unusable'), true)
  assert.equal(everySourceIs(readingWithSources({ all: 'read' }), 'read'), true)

  assert.equal(everySourceIs(readingWithSources({ nodes: 'missing', cycles: 'unusable' }), 'missing'), false, '混着的不是「全都在」')
  assert.equal(everySourceIs(readingWithSources({ nodes: 'read', cycles: 'missing' }), 'missing'), false, '有一份读到了就不是「都没有」')

  assert.equal(everySourceIs({ sources: {} }, 'missing'), false, '一份来源都没列到：还没读，不是「全都在」')
  assert.equal(everySourceIs(readingWithSources({ all: 'missing' }), 'unusable'), false, '问的结局对不上就是不对上')
})

test('明细收格：走过它的算，它此刻正握着的也算', () => {
  const reading = readProject(record({
    nodes: {
      walked: node({ status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }),
      held: node({ dependencies: [] }),
      other: node({ dependencies: [] }),
    },
    cycles: [
      cycle({
        holding: [{ id: 'held', since: '2026-03-10T11:00:00.000Z' }],
        path: [{ node: 'walked', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'completed' }],
      }),
      cycle({ id: 'c2', holding: [{ id: 'walked', since: '2026-03-10T11:30:00.000Z' }] }),
    ],
  }))
  const c1 = reading.cycleById.c1
  const idsOf = (key) => nodesOf(key, c1, reading).map((one) => one.id)

  assert.deepEqual(idsOf('done'), ['walked'], '走过它的算它名下的，哪怕此刻被别的线握着')
  assert.deepEqual(idsOf('run'), ['held'], '它此刻握着的那一格算进行中那段')
  assert.deepEqual(idsOf('shelved'), [])
  assert.deepEqual(idsOf('ready'), [])
  assert.deepEqual(idsOf('wait'), [])
})

test('明细收格：已交付那段按交付时刻新的在前', () => {
  const reading = readProject(record({
    nodes: {
      early: node({ status: 'completed', completed_at: '2026-03-10T07:00:00.000Z' }),
      late: node({ status: 'completed', completed_at: '2026-03-10T10:00:00.000Z' }),
    },
    cycles: [
      cycle({
        path: [
          { node: 'early', started_at: '2026-03-10T06:00:00.000Z', ended_at: '2026-03-10T07:00:00.000Z', result: 'completed' },
          { node: 'late', started_at: '2026-03-10T09:00:00.000Z', ended_at: '2026-03-10T10:00:00.000Z', result: 'completed' },
        ],
      }),
    ],
  }))

  assert.deepEqual(
    nodesOf('done', reading.cycleById.c1, reading).map((one) => one.id),
    ['late', 'early'],
  )
})

test('桶读数：要人的那一格先落闸，哪怕线正握着它', () => {
  const reading = readProject(record({
    nodes: {
      gated: node({ mode: 'manual' }),
      busyGate: node({ mode: 'manual' }),
      checkpoint: node({ mode: 'checkpoint', status: 'completed', completed_at: '2026-03-10T10:00:00.000Z' }),
    },
    cycles: [cycle({ holding: [{ id: 'busyGate', since: '2026-03-10T11:00:00.000Z' }] })],
  }))

  assert.equal(bucketOf(reading.nodeById.gated), 'gate', '手动闸的未开始一格落人闸')
  assert.equal(bucketOf(reading.nodeById.busyGate), 'gate', '人闸压过进行中：握着它的线改不了这一桶')
  assert.equal(bucketOf(reading.nodeById.checkpoint), 'gate', '交付了还没批过的检查点落人闸')
})

test('桶读数：出局的判决自己一桶，余下按在手与格子自己的状态', () => {
  const reading = readProject(record({
    nodes: {
      parked: node({ status: undefined }),
      busy: node(),
      idle: node(),
      done: node({ status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }),
    },
    cycles: [
      cycle({
        holding: [{ id: 'busy', since: '2026-03-10T11:00:00.000Z' }],
        path: [{ node: 'parked', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'failed' }],
      }),
    ],
  }))

  assert.equal(bucketOf(reading.nodeById.parked), 'shelved', '判决失败的出局等人，落等待那一桶')
  assert.equal(bucketOf(reading.nodeById.busy), 'run')
  assert.equal(bucketOf(reading.nodeById.idle), 'todo')
  assert.equal(bucketOf(reading.nodeById.done), 'done')
})
