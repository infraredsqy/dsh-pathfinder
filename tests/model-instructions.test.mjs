/* 指令可见性那一段的单元测试：只锁不变量——哪几句还算数由哪几个字段说了算。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readProject } from '../src/model/index.ts'

const AT = new Date('2026-03-10T12:00:00.000Z')

/** 一条指令，只写这一步要说的字段。 */
function instruction(fields = {}) {
  return { id: 'i1', text: '一句话', scope: 'global', target: 'stage', at: '2026-03-10T09:00:00.000Z', ...fields }
}

/** 读一份记录里的指令。 */
function read(instructions, parts = {}) {
  const input = { nodes: {}, cycles: [], issues: {}, ...parts, instructions, at: parts.at ?? AT }
  return readProject(input).instructions
}

const ids = (list) => list.map((item) => item.id)

test('那一刻还没说出口的句子不在这份读数里', () => {
  const out = read([
    instruction({ id: 'said' }),
    instruction({ id: 'later', at: '2026-03-10T13:00:00.000Z' }),
    instruction({ id: 'never', at: null }),
  ])

  assert.deepEqual(ids(out), ['said'])
  assert.equal(out[0].inForce, true)
})

test('收掉了的句子不算数：终局词，或者一个已经到的收掉时刻', () => {
  const out = read([
    instruction({ id: 'done', state: 'done', resolved_at: '2026-03-10T11:00:00.000Z' }),
    instruction({ id: 'applied', state: 'applied', resolved_at: '2026-03-10T11:00:00.000Z' }),
    instruction({ id: 'na', state: 'n/a', resolved_at: '2026-03-10T11:00:00.000Z' }),
    instruction({ id: 'withdrawn', state: 'withdrawn', resolved_at: '2026-03-10T11:00:00.000Z' }),
    instruction({ id: 'superseded', state: 'superseded', resolved_at: '2026-03-10T11:00:00.000Z' }),
    instruction({ id: 'word-only', state: 'done' }),
  ])

  assert.deepEqual(out.filter((item) => item.inForce).map((item) => item.id), [])
  assert.ok(out.every((item) => item.standing === false))
  assert.equal(out[5].closedAt, null, '记录里没有收掉的那一刻时，它自己那个终局词才算数')
})

test('别的写法都还算数：在生效、没写、还没结论的、这里不认识的', () => {
  const out = read([
    instruction({ id: 'live', state: 'live' }),
    instruction({ id: 'none' }),
    instruction({ id: 'pending', state: 'pending', resolved_at: null }),
    instruction({ id: 'strange', state: '别的写法' }),
  ])

  assert.deepEqual(ids(out.filter((item) => item.inForce)), ['live', 'none', 'pending', 'strange'])
})

test('收掉的那一刻晚于读到的那一刻：那一刻它还算数', () => {
  const out = read([instruction({ id: 'i1', state: 'done', resolved_at: '2026-03-10T13:00:00.000Z' })])

  assert.equal(out[0].standing, true)
  assert.equal(out[0].inForce, true)
  assert.equal(out[0].closedAt, null, '那一刻还没收掉：读数里就没有那一刻')
})

test('范围：绑的线不在服务里就不算数，绑的那一格交付了就不算数', () => {
  const out = read([
    instruction({ id: 'global', scope: 'global' }),
    instruction({ id: 'in-service', scope: 'cycle', cycle: 'c1' }),
    instruction({ id: 'out-of-service', scope: 'cycle', cycle: 'c2' }),
    instruction({ id: 'gone-cycle', scope: 'cycle', cycle: 'c9' }),
    instruction({ id: 'open-node', scope: 'node', node: 'n1' }),
    instruction({ id: 'done-node', scope: 'node', node: 'n2' }),
    instruction({ id: 'gone-node', scope: 'node', node: 'n9' }),
    instruction({ id: 'no-binding', scope: 'cycle' }),
    instruction({ id: 'no-scope' }),
    instruction({ id: 'other-scope', scope: '别处' }),
  ], {
    nodes: {
      n1: { mode: 'auto', status: 'todo', dependencies: [] },
      n2: { mode: 'auto', status: 'completed', dependencies: [], completed_at: '2026-03-10T09:00:00.000Z' },
    },
    cycles: [
      { id: 'c1', status: 'active', holding: [], path: [] },
      { id: 'c2', status: 'inactive', holding: [], path: [] },
    ],
  })

  assert.deepEqual(
    ids(out.filter((item) => item.inForce)),
    ['global', 'in-service', 'gone-cycle', 'open-node', 'gone-node', 'no-binding', 'no-scope', 'other-scope'],
    '量不着的一律算：绑的线或那一格记录里已经没有了的，也念',
  )
  assert.deepEqual(ids(out.filter((item) => !item.inScope)), ['out-of-service', 'done-node'])
})

test('记录里没写的字段就空着，不补一个默认值', () => {
  const out = read([{ id: 'i1', at: '2026-03-10T09:00:00.000Z' }])

  assert.equal(out[0].inForce, true)
  assert.equal(Object.hasOwn(out[0], 'scope'), false)
  assert.equal(Object.hasOwn(out[0], 'recordState'), false)
  assert.equal(Object.hasOwn(out[0], 'text'), false)
})