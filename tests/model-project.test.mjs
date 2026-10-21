/* The model layer's reading segment: invariants only — how the four readings are computed, what
 * readings are given at the edges, and what stays blank when the record has no such moment.
 * When a sample changes the assertions follow; no layout and no snapshots are locked.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readProject } from '../src/model/index.ts'

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

function step(id, started, ended, result) {
  return { node: id, started_at: started, ended_at: ended, result }
}

const ids = (list) => list.map((item) => item.id)
const nodesOf = (list) => list.map((item) => item.node)

test('空记录：四个读数都空着，一声不响', () => {
  const reading = readProject(record())

  assert.deepEqual(reading.nodes, [])
  assert.deepEqual(reading.cycles, [])
  assert.deepEqual(reading.instructions, [])
  assert.deepEqual(reading.columns, { completed: [], running: [], shelved: [], todo: [], ready: [], blocked: [] })
})

test('进来的不是一个时刻：当场报出来', () => {
  assert.throws(() => readProject(record({ at: new Date('不是一刻') })), TypeError)
})

test('进行中以线路记录里的持有关系为准：卡片自己的词仍然是未开始', () => {
  const reading = readProject(record({
    nodes: { n1: node() },
    cycles: [cycle({ holding: [{ id: 'n1', since: '2026-03-10T11:00:00.000Z' }] })],
  }))
  const n1 = reading.nodeById.n1

  assert.equal(n1.state, 'todo', '被某条线做着的卡，状态仍然是未开始')
  assert.equal(n1.running, true)
  assert.deepEqual(n1.heldBy, ['c1'])
  assert.deepEqual(ids(reading.columns.running), ['n1'])
  assert.deepEqual(reading.columns.todo, [], '进行中的不在未开始那一栏里')
  assert.equal(n1.heldSince.getTime(), Date.parse('2026-03-10T11:00:00.000Z'))
  assert.equal(n1.startedAt, null, '它那一步还没迈出：记录里没有那一刻')
  assert.equal(n1.elapsedSeconds, null, '没有那一刻就没有时长，不写 0')
})

test('可开工三条判据缺一不可', () => {
  const reading = readProject(record({
    nodes: {
      done: node({ status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }),
      r1: node({ dependencies: ['done'] }),
      s1: node({ status: 'shelved', dependencies: ['done'] }),
      h1: node({ dependencies: ['done'] }),
      w1: node({ dependencies: ['nope'] }),
    },
    cycles: [cycle({ holding: [{ id: 'h1', since: '2026-03-10T11:00:00.000Z' }] })],
  }))

  assert.deepEqual(ids(reading.columns.ready), ['r1'], '依赖都交付、没人握着，这才可开工')
  assert.equal(reading.nodeById.s1.ready, false, '少了第一条：出局等人的不会装成可开工')
  assert.equal(reading.nodeById.h1.ready, false, '少了第三条：别人手里正做的不会装成可开工')
  assert.equal(reading.nodeById.w1.ready, false, '少了第二条：依赖没交付的不可开工')
  assert.deepEqual(reading.nodeById.w1.openDependencies, ['nope'], '记录里没有的那条依赖算没交付')
})

test('只有一个出局等人的节点：等待处理那一栏正好一条，别处都空着', () => {
  const reading = readProject(record({
    nodes: { only: node({ status: 'shelved', updated_at: '2026-03-09T00:00:00.000Z' }) },
  }))
  const only = reading.nodeById.only

  assert.deepEqual(ids(reading.columns.shelved), ['only'])
  assert.deepEqual(reading.columns.completed, [])
  assert.deepEqual(reading.columns.running, [])
  assert.deepEqual(reading.columns.todo, [])
  assert.equal(only.state, 'shelved')
  assert.equal(only.gate.kind, 'shelved', '闸只说是哪一种，叫什么由客户端说')
  assert.equal(only.parkedSince, null, '没有判决那一步，就没有那一刻')
})

test('同一节点先失败后成功：读成已交付，不读出局等人', () => {
  const reading = readProject(record({
    nodes: { n: node({ status: 'completed', completed_at: '2026-03-10T10:00:00.000Z' }) },
    cycles: [cycle({
      path: [
        step('n', '2026-03-09T08:00:00.000Z', '2026-03-09T09:00:00.000Z', 'failed'),
        step('n', '2026-03-10T08:00:00.000Z', '2026-03-10T10:00:00.000Z', 'completed'),
      ],
    })],
  }))
  const n = reading.nodeById.n

  assert.equal(n.state, 'completed')
  assert.equal(n.gate, null, '交付了的自动格不要人')
  assert.deepEqual(ids(reading.columns.completed), ['n'])
  assert.deepEqual(reading.columns.shelved, [], '后面成功过的那一步把它从出局里带回来了')
  assert.equal(n.steps.length, 2)
  assert.equal(n.seconds, 3600, '它自己那一步是记录里最先走的那一步')
})

test('同一节点先失败、重跑那一步以 completed 落停、这一格还没有交付时刻：读作未开始', () => {
  /* `updated_at` is later than the moment of reading, so this word was not written yet at that
   * time: status can only be judged from the steps walked, and the last step to settle brought
   * back completed. */
  const reading = readProject(record({
    nodes: { n: node({ status: 'completed', updated_at: '2026-03-10T13:00:00.000Z' }) },
    cycles: [cycle({
      path: [
        step('n', '2026-03-09T08:00:00.000Z', '2026-03-09T09:00:00.000Z', 'failed'),
        step('n', '2026-03-10T08:00:00.000Z', '2026-03-10T10:00:00.000Z', 'completed'),
      ],
    })],
  }))
  const n = reading.nodeById.n

  assert.equal(n.state, 'todo', '最后落停的那一步带回 completed，这一格就回到了局中')
  assert.equal(n.ready, true, '依赖都交付、没人握着，它可开工')
  assert.equal(n.gate, null, '回到局中的格不要人')
  assert.equal(n.parkedSince, null, '没有搁置这回事，就没有那一刻')
  assert.deepEqual(ids(reading.columns.todo), ['n'])
  assert.deepEqual(reading.columns.shelved, [], '先头那一趟的判决已经被重跑那一趟盖过去')
  assert.deepEqual(ids(reading.columns.ready), ['n'])
})

test('老一版的持有关系写法：线路上那个单值 current_node / current_started_at 也读', () => {
  const old = readProject(record({
    nodes: { n1: node() },
    cycles: [cycle({ current_node: 'n1', current_started_at: '2026-03-10T11:00:00.000Z' })],
  }))
  const n1 = old.nodeById.n1

  assert.equal(n1.state, 'todo', '卡片自己的词仍然是未开始')
  assert.equal(n1.running, true)
  assert.deepEqual(n1.heldBy, ['c1'])
  assert.equal(n1.heldSince.getTime(), Date.parse('2026-03-10T11:00:00.000Z'))
  assert.deepEqual(old.cycleById.c1.holding, [{ nodeId: 'n1', since: new Date('2026-03-10T11:00:00.000Z') }])
  assert.deepEqual(ids(old.columns.running), ['n1'])

  /* That moment has not been picked up yet: the record writes it later on. */
  const later = readProject(record({
    nodes: { n1: node() },
    cycles: [cycle({ current_node: 'n1', current_started_at: '2026-03-10T13:00:00.000Z' })],
  }))

  assert.equal(later.nodeById.n1.running, false)
  assert.deepEqual(later.nodeById.n1.heldBy, [])
  assert.equal(later.nodeById.n1.heldSince, null, '记录里没有那一刻：空着，不编一个')
  assert.deepEqual(later.cycleById.c1.holding, [])
})

test('时刻切法：记录自己的词在那一刻写下来了才算数', () => {
  const nodes = { n: node({ status: 'todo', updated_at: '2026-03-10T11:30:00.000Z' }) }
  const cycles = [cycle({ path: [step('n', '2026-03-10T09:00:00.000Z', '2026-03-10T10:00:00.000Z', 'failed')] })]

  const early = readProject(record({ nodes, cycles, at: new Date('2026-03-10T11:00:00.000Z') }))
  const late = readProject(record({ nodes, cycles }))

  assert.equal(early.nodeById.n.state, 'shelved', '那一刻「未开始」这个词还没写下来，按判决那一步读')
  assert.equal(early.nodeById.n.parkedSince.getTime(), Date.parse('2026-03-10T10:00:00.000Z'))
  assert.equal(late.nodeById.n.state, 'todo', '词写下来了：记录说它已经回到局中')
})

test('交付看它自己的那一刻：那一刻还没到就是还没交付', () => {
  const early = readProject(record({
    nodes: { n: node({ status: 'completed', completed_at: '2026-03-10T13:00:00.000Z' }) },
    at: new Date('2026-03-10T12:00:00.000Z'),
  }))
  const word = readProject(record({ nodes: { n: node({ status: 'completed' }) } }))

  assert.equal(early.nodeById.n.state, 'todo')
  assert.equal(early.nodeById.n.completedAt, null, '那一刻还没到，读数里就没有那一刻')
  assert.equal(word.nodeById.n.state, 'completed', '记录里根本没有交付时刻时，它自己那个词才算数')
})

test('人闸：一个词 + 那一刻，不要人的格没有这个词', () => {
  const shelved = readProject(record({
    nodes: { s: node({ status: 'shelved', updated_at: '2026-03-10T11:00:00.000Z' }) },
    cycles: [cycle({ path: [step('s', '2026-03-10T09:00:00.000Z', '2026-03-10T10:00:00.000Z', 'stopped')] })],
  }))
  assert.deepEqual(shelved.nodeById.s.gate, {
    kind: 'shelved', since: new Date('2026-03-10T10:00:00.000Z'),
  })

  /* That word was not written yet at that moment (its last modification is later than the moment
   * of reading): read from the verdict step. */
  const bySteps = readProject(record({
    nodes: { s: node({ updated_at: '2026-03-10T13:00:00.000Z' }) },
    cycles: [cycle({ path: [step('s', '2026-03-10T09:00:00.000Z', '2026-03-10T10:00:00.000Z', 'failed')] })],
  }))
  assert.equal(bySteps.nodeById.s.state, 'shelved')
  assert.equal(bySteps.nodeById.s.gate.kind, 'shelved')
  assert.equal(bySteps.nodeById.s.gate.since.getTime(), Date.parse('2026-03-10T10:00:00.000Z'))

  const manual = readProject(record({
    nodes: { m: node({ mode: 'manual' }) },
    cycles: [cycle({ path: [step('m', '2026-03-10T09:00:00.000Z', null, null)] })],
  }))
  assert.equal(manual.nodeById.m.gate.kind, 'manual')
  assert.equal(Object.hasOwn(manual.nodeById.m.gate, 'word'), false, '闸不再带词：是哪一种只看 kind')
  assert.equal(manual.nodeById.m.gate.since.getTime(), Date.parse('2026-03-10T09:00:00.000Z'))

  const hand = readProject(record({ nodes: { m: node({ mode: 'manual' }) } }))
  assert.equal(hand.nodeById.m.gate.kind, 'manual')
  assert.equal(hand.nodeById.m.gate.since, null, '记录里没有那一刻：空着，不编一个')

  const checkpoint = readProject(record({
    nodes: { cp: node({ mode: 'checkpoint', status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }) },
    cycles: [cycle({ path: [step('cp', '2026-03-10T08:00:00.000Z', '2026-03-10T09:00:00.000Z', 'completed')] })],
  }))
  assert.equal(checkpoint.nodeById.cp.gate.kind, 'checkpoint')
  assert.equal(Object.hasOwn(checkpoint.nodeById.cp.gate, 'word'), false, '闸不再带词：是哪一种只看 kind')
  assert.equal(checkpoint.nodeById.cp.gate.since.getTime(), Date.parse('2026-03-10T09:00:00.000Z'))

  const moved = readProject(record({
    nodes: {
      cp: node({ mode: 'checkpoint', status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }),
      after: node({ status: 'completed', completed_at: '2026-03-10T10:30:00.000Z' }),
    },
    cycles: [cycle({
      path: [
        step('cp', '2026-03-10T08:00:00.000Z', '2026-03-10T09:00:00.000Z', 'completed'),
        step('after', '2026-03-10T10:00:00.000Z', '2026-03-10T10:30:00.000Z', 'completed'),
      ],
    })],
  }))
  assert.equal(moved.nodeById.cp.gate, null, '这条线又往前走了：那一拍已经过去')
  assert.equal(moved.nodeById.after.gate, null, '自动格不要人')

  const running = readProject(record({
    nodes: { cp: node({ mode: 'checkpoint' }) },
  }))
  assert.equal(running.nodeById.cp.gate, null, '还没交付的检查点，闸不在它这儿')
})

test('线路：握着谁、走过哪几步、名下谁在等人', () => {
  const reading = readProject(record({
    nodes: {
      held: node(),
      walked: node({ status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }),
      open: node(),
      parked: node(),
    },
    cycles: [cycle({
      holding: [{ id: 'held', since: '2026-03-10T11:00:00.000Z' }],
      path: [
        step('walked', '2026-03-10T08:00:00.000Z', '2026-03-10T09:00:00.000Z', 'completed'),
        step('open', '2026-03-10T11:30:00.000Z', null, null),
        step('parked', '2026-03-10T13:00:00.000Z', '2026-03-10T13:30:00.000Z', 'failed'),
      ],
    })],
  }))
  const c1 = reading.cycleById.c1

  assert.equal(c1.inService, true)
  assert.deepEqual(c1.holding, [{ nodeId: 'held', since: new Date('2026-03-10T11:00:00.000Z') }])
  assert.deepEqual(nodesOf(c1.path), ['walked'], '那一刻还没落停的那一步不算走过')
  assert.equal(c1.lastStep.node, 'walked')
  assert.deepEqual(c1.parked, [], '那一刻还没有谁出局')
})

test('数据桥递进来的那份载荷能直接当输入', () => {
  const payload = {
    workspaceRoot: 'C:\\workspace-for-tests',
    recordPath: '.pf',
    sources: { nodes: 'read', cycles: 'read', instructions: 'read', issues: 'missing' },
    nodes: { n1: node() },
    cycles: [cycle()],
    instructions: [],
    issues: {},
  }
  const reading = readProject({ ...payload, at: AT })

  assert.equal(reading.nodeById.n1.state, 'todo')
  assert.deepEqual(reading.cycles.map((item) => item.id), ['c1'])
})

test('记录本体上写着会话的那一版：会话原样带出来，没写的格没有这个字段', () => {
  const reading = readProject(record({
    nodes: {
      n1: node({ dsh_session: 'session-7' }),
      n2: node({ dsh_session: '' }),
      n3: node(),
    },
  }))

  assert.equal(reading.nodeById.n1.session, 'session-7')
  assert.equal(reading.nodeById.n2.session, undefined)
  assert.equal(reading.nodeById.n3.session, undefined)
})

test('读一遍不改递给它的那份记录', () => {
  const input = record({
    nodes: { n1: node({ dependencies: ['n2'] }), n2: node({ status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }) },
    cycles: [cycle({ holding: [{ id: 'n1', since: '2026-03-10T11:00:00.000Z' }], path: [step('n2', '2026-03-10T08:00:00.000Z', '2026-03-10T09:00:00.000Z', 'completed')] })],
  })
  const snapshot = structuredClone(input)

  readProject(input)

  assert.deepEqual(input, snapshot, '四份记录与那一刻都不能被改动')
})