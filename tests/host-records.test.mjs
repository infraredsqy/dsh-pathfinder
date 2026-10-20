/* The host-half reading segment: invariants only — reads correctly, missing files do not throw,
 * a refused page shrinks and retries, and the whole thing is read-only.
 *
 * No snapshots: what is compared is "the entries in the payload are the same thing as the record's
 * own copy". What a record looks like is decided by the samples below; when a sample changes the
 * assertions follow — never the other way around.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readReading, readWholeFile } from '../src/host/records.ts'

const scope = { sessionId: 'session-for-tests', workspaceRoot: 'C:\\workspace-for-tests' }
const signal = new AbortController().signal

/** The code the port gives when the target does not exist; only it counts as "not in the workspace". */
function missing(path) {
  const error = new Error(`no entry at ${path}`)
  error.code = 'workspace-file/not-found'
  return error
}

/** The two codes the port gives when it refuses a page: the page's byte count over the cap, or the requested lines over its tier. */
function refused(code) {
  const error = new Error(code)
  error.code = code
  return error
}

/** A stand-in port: directories inferred from file names, reads paged by line, paging semantics
 * matching the real port (lines end with `\n`; the trailing `\n` terminates the last line and does
 * not start an empty one; `maxLines` caps a page's lines, `maxBytes` caps its bytes, breaches get
 * the real port's two codes, nothing is truncated). It only has `list` and `read`; any write
 * attempt fails on the spot. */
function fakeWorkspace(files, { pageLines = 2, maxBytes = Infinity } = {}) {
  const calls = []
  const refusals = []
  const port = {
    async list(_scope, dir) {
      calls.push(['list', dir])
      const prefix = dir === '' ? '' : `${dir}/`
      const found = new Map()
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue
        const [head, ...tail] = path.slice(prefix.length).split('/')
        if (head.length === 0) continue
        found.set(head, { name: head, type: tail.length === 0 ? 'file' : 'directory' })
      }
      if (found.size === 0) throw missing(dir)
      return { path: dir, entries: [...found.values()], truncated: false }
    },
    async read(_scope, path, range) {
      calls.push(['read', path, range.offset, range.limit])
      const text = files[path]
      if (text === undefined) throw missing(path)
      const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
      const offset = range.offset ?? 1
      if (range.limit !== undefined && range.limit > pageLines) {
        refusals.push({ path, offset, limit: range.limit, code: 'gateway/bad-request' })
        throw refused('gateway/bad-request')
      }
      const size = Math.min(range.limit ?? pageLines, pageLines)
      const page = lines.slice(offset - 1, offset - 1 + size)
      const bytes = page.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0) + Math.max(page.length - 1, 0)
      if (bytes > maxBytes) {
        refusals.push({ path, offset, limit: range.limit, code: 'workspace-file/too-large' })
        throw refused('workspace-file/too-large')
      }
      return { text: page.join('\n'), lines: page.length, eof: offset - 1 + page.length >= lines.length }
    },
  }
  return { port, calls, refusals }
}

const json = (value) => JSON.stringify(value, null, 2) + '\n'

const NODES = {
  n1: {
    title: 'first',
    description: 'the first node',
    tags: ['t0'],
    mode: 'auto',
    weight: 'w1',
    dsh_session: 'sess-1',
    status: 'completed',
    created_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-02T00:00:00.000Z',
    updated_at: '2026-01-03T00:00:00.000Z',
    dependencies: [],
  },
  // The second node deliberately carries no weight and no dsh_session: absent in the record, absent in the payload.
  n2: {
    title: 'second',
    description: 'the second node',
    tags: [],
    mode: 'manual',
    status: 'todo',
    created_at: '2026-01-04T00:00:00.000Z',
    updated_at: '2026-01-05T00:00:00.000Z',
    dependencies: ['n1'],
  },
}
const CYCLES = [
  {
    id: 'c1',
    title: 'a line',
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-06T00:00:00.000Z',
    policies: { issue_pool_weight_limit: 8 },
    holding: [{ id: 'n2', since: '2026-01-06T00:00:00.000Z' }],
    path: [{ node: 'n1', started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-02T00:00:00.000Z', result: 'delivered' }],
  },
]
const INSTRUCTIONS = [
  { id: 'i1', text: 'a sentence the user said', scope: 'global', target: 'stage', state: 'live', cycle: null, said_by: 'user', at: '2026-01-07T00:00:00.000Z', resolved_at: null, note: 'a note' },
]
const ISSUES = {
  p1: {
    id: 'p1',
    title: 'a case',
    severity: 'P1',
    status: 'open',
    module: 'mod-a',
    source: 'review',
    decision: 'fix',
    discovered: '2026-01-08T00:00:00.000Z',
    updated_at: '2026-01-09T00:00:00.000Z',
    check_count: 2,
    files: ['a.ts'],
    description: 'what went wrong',
    suggestion: 'what to do',
    reason: 'why',
  },
}

const record = () => ({
  '.pf/ideas.json': json({ nodes: NODES }),
  '.pf/state.json': json({ cycles: CYCLES }),
  '.pf/instructions.json': json({ instructions: INSTRUCTIONS }),
  '.pf/issues/issues.json': json({ version: 1, issues: ISSUES }),
})

test('每一份来源都读到了，条目就是记录里那一份（含 weight / description / dsh_session 原样）', async () => {
  const { port } = fakeWorkspace(record(), { pageLines: 500 })
  const reading = await readReading(port, scope, signal)

  assert.deepEqual(reading.sources, { nodes: 'read', cycles: 'read', instructions: 'read', issues: 'read' })
  assert.equal(reading.recordPath, '.pf')
  assert.equal(reading.workspaceRoot, scope.workspaceRoot)
  assert.deepEqual(reading.nodes, NODES)
  assert.deepEqual(reading.cycles, CYCLES)
  assert.deepEqual(reading.instructions, INSTRUCTIONS)
  assert.deepEqual(reading.issues, ISSUES)

  assert.equal(reading.nodes.n1.weight, 'w1')
  assert.equal(reading.nodes.n1.description, 'the first node')
  assert.equal(reading.nodes.n1.dsh_session, 'sess-1')
  assert.equal(reading.nodes.n1.created_at, '2026-01-01T00:00:00.000Z')
  assert.equal(Object.hasOwn(reading.nodes.n2, 'dsh_session'), false)
  assert.equal(Object.hasOwn(reading.nodes.n2, 'weight'), false)
  assert.equal(reading.cycles[0].path[0].result, 'delivered')
})

test('一份记录跨好几页也拼得回来', async () => {
  const many = {}
  for (let i = 1; i <= 20; i++) {
    many[`n${i}`] = { ...NODES.n2, title: `node ${i}`, description: `description ${i}`, dependencies: [`n${i - 1}`] }
  }
  const files = record()
  files['.pf/ideas.json'] = json({ nodes: many })
  const { port, calls } = fakeWorkspace(files, { pageLines: 3 })
  const reading = await readReading(port, scope, signal)

  assert.deepEqual(reading.nodes, many)
  assert.ok(calls.filter(([kind]) => kind === 'read').length > 3, '这一份要跨好几页才读得完')
})

test('工作区里没有那份记录：返回空读数，一声不响', async () => {
  const { port } = fakeWorkspace({})
  const reading = await readReading(port, scope, signal)

  assert.deepEqual(reading.sources, { nodes: 'missing', cycles: 'missing', instructions: 'missing', issues: 'missing' })
  assert.deepEqual(reading.nodes, {})
  assert.deepEqual(reading.cycles, [])
  assert.deepEqual(reading.instructions, [])
  assert.deepEqual(reading.issues, {})
})

test('记录在、少一份文件：只有那一份报 missing，其余照读', async () => {
  const files = record()
  delete files['.pf/state.json']
  const { port } = fakeWorkspace(files, { pageLines: 500 })
  const reading = await readReading(port, scope, signal)

  assert.deepEqual(reading.sources, { nodes: 'read', cycles: 'missing', instructions: 'read', issues: 'read' })
  assert.deepEqual(reading.cycles, [])
  assert.deepEqual(reading.nodes, NODES)
})

test('读不动的那一份报 unusable，读数照常回来', async () => {
  const files = record()
  files['.pf/state.json'] = '{ this line is not JSON\n'
  files['.pf/instructions.json'] = json({ instructions: { not: 'a list' } })
  const { port } = fakeWorkspace(files, { pageLines: 500 })
  const reading = await readReading(port, scope, signal)

  assert.deepEqual(reading.sources, { nodes: 'read', cycles: 'unusable', instructions: 'unusable', issues: 'read' })
  assert.deepEqual(reading.cycles, [])
  assert.deepEqual(reading.instructions, [])
  assert.deepEqual(reading.nodes, NODES)
})

test('取数只走 list 与 read 两个动作，也不改动递进来的那份文件表', async () => {
  const files = record()
  const snapshot = structuredClone(files)
  const { port, calls } = fakeWorkspace(files, { pageLines: 500 })

  await readReading(port, scope, signal)

  assert.ok(calls.length > 0)
  assert.deepEqual([...new Set(calls.map(([kind]) => kind))].sort(), ['list', 'read'])
  assert.deepEqual(files, snapshot)
})

test('一页不肯往前走的回复不会转不出来', async () => {
  let reads = 0
  const port = {
    async read() {
      reads += 1
      return { text: '', lines: 0, eof: false }
    },
  }
  assert.equal(await readWholeFile(port, scope, '.pf/anything.json', signal), '')
  assert.equal(reads, 1)
})

test('一页的字节数超上限时把这一页收小重取：整份照样读全', async () => {
  const many = {}
  for (let i = 1; i <= 400; i++) {
    many[`n${i}`] = { ...NODES.n2, title: `node ${i}`, description: 'd'.repeat(300) }
  }
  const files = record()
  files['.pf/ideas.json'] = json({ nodes: many })
  // The whole record fits within 500 lines, but a page's byte count breaches the cap: the byte side is what gets hit.
  const { port, calls, refusals } = fakeWorkspace(files, { pageLines: 500, maxBytes: 4096 })
  const reading = await readReading(port, scope, signal)

  assert.deepEqual(reading.sources, { nodes: 'read', cycles: 'read', instructions: 'read', issues: 'read' })
  assert.deepEqual(reading.nodes, many)

  assert.ok(refusals.length > 0, '这一份要先把口子的字节上限撞一次')
  assert.deepEqual([...new Set(refusals.map(({ code }) => code))], ['workspace-file/too-large'])
  const limits = calls.filter(([kind, path]) => kind === 'read' && path === '.pf/ideas.json').map(([, , , limit]) => limit)
  assert.equal(limits[0], undefined, '第一页问的是口子默认档')
  assert.ok(limits.slice(1).every((limit) => typeof limit === 'number' && limit < 500), '被拒之后每一页都带着收小过的行数')
})

test('请求的行数超过口子那一档时也照样收小重取：整份照样读全', async () => {
  const many = {}
  for (let i = 1; i <= 40; i++) {
    many[`n${i}`] = { ...NODES.n2, title: `node ${i}`, description: 'd'.repeat(3000) }
  }
  const files = record()
  files['.pf/ideas.json'] = json({ nodes: many })
  // A page holds only 40 lines and the byte cap is 8192: after the cap is hit, the shrunk tier must first fit within 40 lines.
  const { port, refusals } = fakeWorkspace(files, { pageLines: 40, maxBytes: 8192 })
  const reading = await readReading(port, scope, signal)

  assert.deepEqual(reading.sources, { nodes: 'read', cycles: 'read', instructions: 'read', issues: 'read' })
  assert.deepEqual(reading.nodes, many)
  assert.ok(
    refusals.some(({ code }) => code === 'gateway/bad-request'),
    '收小的档高过口子那一档时，它给的是 bad-request，这一条也要接着往下收',
  )
})

test('单行本身就超上限时，这一份才是真的读不动', async () => {
  const files = record()
  files['.pf/ideas.json'] = json({ nodes: { n1: { ...NODES.n2, description: 'd'.repeat(9000) } } })
  const { port } = fakeWorkspace(files, { pageLines: 500, maxBytes: 4096 })
  const reading = await readReading(port, scope, signal)

  // That line cannot pass even as a page of its own; shrinking pages cannot save it.
  assert.deepEqual(reading.sources, { nodes: 'unusable', cycles: 'read', instructions: 'read', issues: 'read' })
  assert.deepEqual(reading.nodes, {})
})