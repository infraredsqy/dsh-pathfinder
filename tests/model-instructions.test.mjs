/* 指令可见性那一段：只锁不变量——哪几句还算数由哪几个字段说了算。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readProject } from '../src/model/index.ts'

const AT = new Date('2026-03-10T12:00:00.000Z')

/** 一条指令；默认取记录里最常见的那种：说出口了、还在生效。 */
function instruction(fields = {}) {
  return { id: 'i1', text: '一句话', scope: 'global', target: 'stage', at: '2026-03-10T09:00:00.000Z', state: 'live', ...fields }
}

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

test('收掉了的句子不算数：一个已经到的收掉时刻，或者一个不是 live 的词', () => {
  const out = read([
    instruction({ id: 'withdrawn', state: 'withdrawn', resolved_at: '2026-03-10T11:00:00.000Z' }),
    instruction({ id: 'closed-while-live', resolved_at: '2026-03-10T11:00:00.000Z' }),
    instruction({ id: 'word-only', state: 'withdrawn' }),
  ])

  assert.deepEqual(out.filter((item) => item.inForce).map((item) => item.id), [])
  assert.ok(out.every((item) => item.standing === false))
  assert.equal(out[2].closedAt, null, '记录里没有收掉的那一刻：这一句不生效由词自己说')
})

test('存量的旧值照「已归档」读：喂进 done / superseded / applied / n/a 都不抛，一律不生效', () => {
  const legacy = ['done', 'superseded', 'applied', 'n/a']
  let out
  assert.doesNotThrow(() => {
    out = read([
      instruction({ id: 'live', state: 'live' }),
      ...legacy.map((state, index) => instruction({ id: `legacy-${index}`, state })),
      ...legacy.map((state, index) => instruction({
        id: `legacy-closed-${index}`,
        state,
        resolved_at: '2026-03-10T11:00:00.000Z',
      })),
    ])
  })

  assert.deepEqual(ids(out.filter((item) => item.inForce)), ['live'])
  assert.equal(out.filter((item) => item.standing).length, 1, '旧值一个都不站着')
  assert.equal(out[1].recordState, 'done', '记录自己写的那个词原样带出来，不折算、不改写')
  assert.equal(out[1].closedAt, null, '旧值不靠一个收掉时刻来判：不是 live 就不生效')
})

test('词表之外、以及没写这个词的：都读作已归档，不替它折算', () => {
  const out = read([
    instruction({ id: 'live', state: 'live' }),
    instruction({ id: 'pending', state: 'pending' }),
    instruction({ id: 'strange', state: '别的写法' }),
    instruction({ id: 'no-word', state: undefined }),
  ])

  assert.deepEqual(ids(out.filter((item) => item.inForce)), ['live'])
  assert.equal(Object.hasOwn(out[3], 'recordState'), false, '没写词就没有词，不补一个')
})

test('收掉的那一刻晚于读到的那一刻：那一刻它还算数', () => {
  const out = read([instruction({ id: 'i1', resolved_at: '2026-03-10T13:00:00.000Z' })])

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
    instruction({ id: 'completed-node', scope: 'node', node: 'n2' }),
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
  assert.deepEqual(ids(out.filter((item) => !item.inScope)), ['out-of-service', 'completed-node'])
})

test('记录里没写的字段就空着，不补一个默认值', () => {
  const out = read([{ id: 'i1', at: '2026-03-10T09:00:00.000Z' }])

  assert.equal(out[0].inForce, false, '没写状态就是没写 live：按已归档读，也不替它补一个词')
  assert.equal(Object.hasOwn(out[0], 'scope'), false)
  assert.equal(Object.hasOwn(out[0], 'recordState'), false)
  assert.equal(Object.hasOwn(out[0], 'text'), false)
})