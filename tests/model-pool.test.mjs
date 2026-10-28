/* The issue pool segment: invariants only — where the weight table and policy line come from,
 * at what moment an issue counts as on the books, how weights add up, how the four piles are
 * ordered. No layout and no snapshots are locked.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readLine, readPool, readProject, readWeights } from '../src/model/index.ts'
import { AT, cycle, issue, record } from './helpers/record-fixtures.mjs'

/** The maintenance chore that carries the weight table. */
const CARRIER = { title: '清理问题池', description: '各等级按 P3/P2/P1/P0 = 1/2/4/8 折算成重量。' }

test('重量表：从记录里那条维护活儿自己的说明里取', () => {
  assert.deepEqual(readWeights({ n1: CARRIER }), { P3: 1, P2: 2, P1: 4, P0: 8 })
  assert.equal(readWeights({ n1: { title: '别的活' } }), null, '记录里没写就没有表')
  assert.equal(readWeights({}), null)
})

test('策略线：哪条线自己立了那个数', () => {
  assert.equal(readLine([cycle({ policies: { parallel: 1 } })]), null, '没有一条线立过就没有线')
  assert.equal(readLine([cycle({ policies: { parallel: 1 } }), cycle({ id: 'c2', policies: { issue_pool_weight_limit: 40 } })]), 40)
})

test('池子的重量：按重量表把还欠着的那几条加起来，判成 external 的掉出这个和', () => {
  const reading = readPool(
    { n1: CARRIER },
    [cycle({ policies: { issue_pool_weight_limit: 40 } })],
    {
      a: issue({ id: 'a', severity: 'P0' }),
      b: issue({ id: 'b', severity: 'P2', status: 'acknowledged', decision: 'external' }),
      c: issue({ id: 'c', severity: 'P1', status: 'resolved', updated_at: '2026-03-05T00:00:00.000Z' }),
      d: issue({ id: 'd', severity: 'P3', decision: 'autofix' }),
      e: issue({ id: 'e', severity: 'P3', decision: 'unknown' }),
    },
    AT,
  )

  assert.equal(reading.line, 40)
  assert.deepEqual(reading.weights, { P3: 1, P2: 2, P1: 4, P0: 8 })
  /* `a` is undecided (counts as unknown) and `d` is autofix: both still enter the sum; `b` is
   * external and `c` is settled: neither enters. */
  assert.equal(reading.weight, 10, '8 + 1 + 1：判成 external 的与放下的那两条不进这个和')
  assert.equal(reading.rows.find((row) => row.id === 'b')?.payable, false, '判成 external 的那一条：读数自己就说不压线')
  assert.equal(reading.rows.find((row) => row.id === 'a')?.payable, true, '没判的那一条照旧压线')
  assert.equal(
    reading.groups.find((group) => group.key === 'acknowledged')?.weight,
    0,
    '已承认那一堆只有一条、判成 external：它不进这一堆的加权和',
  )
  assert.deepEqual(reading.standing.map((row) => row.id), ['a', 'd', 'e', 'b'], '判成 external 的那一条还在还欠着的这几条里：条数照旧算它')
  assert.deepEqual(reading.census, { total: 5, standing: 4, open: 3, acknowledged: 1, rejected: 0, resolved: 1 })
})

test('池子的重量：重量表取不到就不读数，也不拿 0 顶上', () => {
  const reading = readPool({}, [], { a: issue({ severity: 'P0' }) }, AT)

  assert.equal(reading.weights, null)
  assert.equal(reading.line, null)
  assert.equal(reading.weight, null, '记录里没有那份表，这个数就不存在')
  assert.equal(reading.census.open, 1, '登记的条数照旧数得出来')
})

test('一条问题在哪一刻算在册：还没发现的不在册', () => {
  const reading = readPool({}, [], {
    early: issue({ id: 'early', discovered: '2026-03-01T00:00:00.000Z' }),
    late: issue({ id: 'late', discovered: '2026-03-20T00:00:00.000Z' }),
    unknown: issue({ id: 'unknown', discovered: null }),
  }, AT)

  assert.deepEqual(reading.rows.map((row) => row.id), ['early'])
})

test('记录自己那个词属于写它的那一刻：那一刻还没到就按还没结掉读', () => {
  const reading = readPool({}, [], {
    settled: issue({ id: 'settled', status: 'resolved', updated_at: '2026-03-05T00:00:00.000Z' }),
    settledLater: issue({ id: 'settledLater', status: 'resolved', updated_at: '2026-03-20T00:00:00.000Z' }),
    neverTouched: issue({ id: 'neverTouched', status: 'rejected', updated_at: null }),
    strange: issue({ id: 'strange', status: 'carried-over' }),
  }, AT)

  assert.equal(reading.rows.find((row) => row.id === 'settled').status, 'resolved')
  assert.equal(reading.rows.find((row) => row.id === 'settledLater').status, 'open', '那一刻那个词还没写下来')
  assert.equal(reading.rows.find((row) => row.id === 'neverTouched').status, 'rejected', '没记最后改动，那个词就算数')
  assert.equal(reading.rows.find((row) => row.id === 'strange').status, 'open', '不认得的词按没人结掉读')
})

test('四个状态的词面只在模型层一份：空堆不进组，词照旧问得到', () => {
  /* The pool holds one still-outstanding issue: the settled piles are empty piles and form no
   * groups, yet which pile each of the four is still comes from this one reading. */
  const reading = readPool({}, [], { a: issue() }, AT)

  assert.deepEqual(reading.groups.map((group) => group.key), ['open'])
  assert.equal(reading.groups[0]?.standing, true, '还欠着的那一堆算站着')
  assert.equal(reading.groups[0]?.count, 1)
  assert.equal(Object.hasOwn(reading.groups[0], 'label'), false, '堆头不再由模型给词：是哪一堆看 key')
})

test('读数上的可选字段：记录里写了才出场，没写的不拿空串顶位', () => {
  const reading = readPool({}, [], {
    full: issue({
      id: 'full',
      module: 'src/model',
      source: 'scan',
      decision: 'autofix',
      description: '现象',
      suggestion: '修法',
      reason: '理由',
      plan_path: '.tmp/plan.md',
    }),
    bare: issue({ id: 'bare', title: '', severity: null, module: null, status: null }),
  }, AT)
  const optional = ['title', 'severity', 'recordStatus', 'module', 'source', 'decision', 'description', 'suggestion', 'reason', 'planPath']

  const full = reading.rows.find((row) => row.id === 'full')
  for (const key of optional) assert.equal(key in full, true, `${key} 写了就该出场`)

  const bare = reading.rows.find((row) => row.id === 'bare')
  for (const key of optional) assert.equal(key in bare, false, `${key} 没写就不出场`)
})

test('四堆：空的不收，还欠着的重的在前、搁得久的在前，放下的新的在前', () => {
  const reading = readPool({ n1: CARRIER }, [], {
    light: issue({ id: 'light', severity: 'P3', discovered: '2026-03-01T00:00:00.000Z' }),
    heavyOld: issue({ id: 'heavyOld', severity: 'P0', discovered: '2026-03-02T00:00:00.000Z' }),
    heavyNew: issue({ id: 'heavyNew', severity: 'P0', discovered: '2026-03-03T00:00:00.000Z' }),
    carried: issue({ id: 'carried', severity: 'P2', status: 'acknowledged' }),
    closedOld: issue({ id: 'closedOld', severity: 'P1', status: 'resolved', updated_at: '2026-03-04T00:00:00.000Z' }),
    closedNew: issue({ id: 'closedNew', severity: 'P1', status: 'resolved', updated_at: '2026-03-08T00:00:00.000Z' }),
  }, AT)

  assert.deepEqual(reading.groups.map((group) => group.key), ['open', 'acknowledged', 'resolved'], '已驳回那一堆一条都没有，不收')
  assert.deepEqual(reading.groups.map((group) => group.standing), [true, true, false], '还欠着的两堆算站着，放下的那堆不算')
  assert.equal(reading.groups.every((group) => !Object.hasOwn(group, 'label')), true, '堆头不再由模型给词：是哪一堆看 key')
  assert.deepEqual(reading.groups[0].entries.map((row) => row.id), ['heavyOld', 'heavyNew', 'light'])
  assert.deepEqual(reading.groups[1].entries.map((row) => row.id), ['carried'])
  assert.deepEqual(reading.groups[2].entries.map((row) => row.id), ['closedNew', 'closedOld'])
  assert.equal(reading.groups[0].weight, 17, '8 + 8 + 1')
  assert.equal(reading.groups[2].standing, false)
})

test('项目读数把依赖场与问题池一并读出来', () => {
  const reading = readProject(record({
    nodes: { n1: { ...CARRIER, dependencies: [] }, n2: { mode: 'auto', status: 'todo', dependencies: ['n1'] } },
    cycles: [cycle({ policies: { issue_pool_weight_limit: 7 } })],
    issues: { a: issue({ severity: 'P1' }) },
  }))

  assert.equal(reading.graph.maxDepth, 1)
  assert.equal(reading.pool.line, 7)
  assert.equal(reading.pool.weight, 4)
})

test('读一遍问题池不改递给它的那份记录', () => {
  const input = record({
    nodes: { n1: CARRIER },
    cycles: [cycle({ policies: { issue_pool_weight_limit: 40 } })],
    issues: { a: issue({ files: ['a.ts'] }) },
  })
  const snapshot = structuredClone(input)

  readProject(input)

  assert.deepEqual(input, snapshot)
})