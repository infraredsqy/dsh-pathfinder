/* 面板落到字面之前的两个判定：四份来源的结局、一条线的明细收哪些格。
 *
 * 这两条原本住在画画的文件里，Node 进不来、单测锁不住；搬进模型层之后锁的是判据本身——
 * 空集不算「全都在」、走过它的与被它握着的都算、已交付按交付时刻新的在前。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { everySourceIs, nodesOf, readProject } from '../src/model/index.ts'

const AT = new Date('2026-03-10T12:00:00.000Z')

function record(parts = {}) {
  return { nodes: {}, cycles: [], instructions: [], issues: {}, ...parts, at: parts.at ?? AT }
}

function node(fields = {}) {
  return { mode: 'auto', status: 'todo', dependencies: [], ...fields }
}

function cycle(fields = {}) {
  return { id: 'c1', status: 'active', holding: [], path: [], ...fields }
}

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
