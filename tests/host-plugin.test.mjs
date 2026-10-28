/* The host-half plugin segment: locks in the workspace root resolution order.
 *
 * Three sources settle in order — live session header, stored session header, the sandbox
 * policy's root — none may be shuffled; once a live header exists, the stored one is never
 * consulted. That the root handed to the port is the resolved one is also locked here.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../src/host/index.ts'

const signal = new AbortController().signal

function fakeWorkspaceFiles() {
  const asked = []
  return {
    asked,
    async list(scope, path, signal) {
      asked.push({ kind: 'list', scope, path, signal })
      const error = new Error(`no entry at ${path}`)
      error.code = 'workspace-file/not-found'
      throw error
    },
    async read(scope, path, range, signal) {
      asked.push({ kind: 'read', scope, path, range, signal })
      throw new Error('nothing to read in this test')
    },
  }
}

function fakeContext({ live = {}, stored = {}, sandboxRoot = 'C:\\fallback-root' } = {}) {
  const workspaceFiles = fakeWorkspaceFiles()
  const provided = {}
  const statCalls = []
  const ctx = {
    workspaceFiles,
    sessions: { get: (sessionId) => live[sessionId] },
    sandboxPolicy: { workspaceRoot: sandboxRoot },
    get: (service) =>
      service === 'sessionPersistence'
        ? {
            stat: async (sessionId) => {
              statCalls.push(sessionId)
              return stored[sessionId]
            },
          }
        : undefined,
    provide: (service, value) => {
      provided[service] = value
    },
  }
  return { ctx, provided, asked: workspaceFiles.asked, statCalls }
}

test('插件名与依赖声明就是宿主那三样', () => {
  assert.equal(name, 'pathfinder-records')
  assert.deepEqual(inject, ['workspaceFiles', 'sessions', 'sandboxPolicy'])
})

test('出口面收在插件协议要的那四样上：内部件不再从入口过一遍', async () => {
  const entry = await import('../src/host/index.ts')

  assert.equal(entry.name, 'pathfinder-records')
  assert.deepEqual(entry.inject, ['workspaceFiles', 'sessions', 'sandboxPolicy'])
  assert.equal(typeof entry.apply, 'function')
  assert.ok('Config' in entry, 'Config 要在出口面上：DSH 拿它建那一节的设置命名空间')

  for (const internal of [
    'rootFor',
    'workspaceRootOf',
    'runPf',
    'readReading',
    'readWholeFile',
    'CONFIG_KEYS',
    'parseConfigList',
  ]) {
    assert.equal(entry[internal], undefined, `${internal} 没有外部消费者，不该再从入口出口`)
  }
  /* The gateway class stays on the export surface: the self-check fixture tools/panel-check.mjs builds a fresh gateway from the entry. */
  assert.equal(typeof entry.PathfinderRecordsGateway, 'function')
})

test('活着的会话头说话：它写的 cwd 就是取数的那个根', async () => {
  const { ctx, provided, asked } = fakeContext({
    live: { s1: { header: { cwd: 'C:\\from-the-live-session' } } },
    stored: { s1: { header: { cwd: 'C:\\from-the-stored-header' } } },
  })
  apply(ctx)
  const reading = await provided.pathfinderRecords.read('s1', { signal })

  assert.equal(reading.workspaceRoot, 'C:\\from-the-live-session')
  assert.ok(asked.length > 0)
  for (const call of asked) {
    assert.equal(call.scope.workspaceRoot, 'C:\\from-the-live-session')
    assert.equal(call.scope.sessionId, 's1')
  }
})

test('没有活着的会话时，落盘的会话头说话', async () => {
  const { ctx, provided, asked } = fakeContext({ stored: { s2: { header: { cwd: 'C:\\from-the-stored-header' } } } })
  apply(ctx)
  const reading = await provided.pathfinderRecords.read('s2', { signal })

  assert.equal(reading.workspaceRoot, 'C:\\from-the-stored-header')
  assert.equal(asked[0].scope.workspaceRoot, 'C:\\from-the-stored-header')
})

test('有活着的会话头就不再问落盘的头：它没写 cwd 时落到沙箱策略那个根', async () => {
  const { ctx, provided, asked, statCalls } = fakeContext({
    live: { s4: { header: {} } },
    stored: { s4: { header: { cwd: 'C:\\from-the-stored-header' } } },
    sandboxRoot: 'C:\\sandbox-root-for-tests',
  })
  apply(ctx)
  const reading = await provided.pathfinderRecords.read('s4', { signal })

  assert.equal(reading.workspaceRoot, 'C:\\sandbox-root-for-tests')
  assert.equal(asked[0].scope.workspaceRoot, 'C:\\sandbox-root-for-tests')
  assert.deepEqual(statCalls, [], '活着的会话头在，落盘的头那一路问都不问')
})

test('两个会话头都没写 cwd 时，落到沙箱策略那个根', async () => {
  const { ctx, provided, asked } = fakeContext({
    live: { s3: { header: {} } },
    stored: { s3: { header: {} } },
    sandboxRoot: 'C:\\sandbox-root-for-tests',
  })
  apply(ctx)
  const reading = await provided.pathfinderRecords.read('s3', { signal })

  assert.equal(reading.workspaceRoot, 'C:\\sandbox-root-for-tests')
  assert.equal(asked[0].scope.workspaceRoot, 'C:\\sandbox-root-for-tests')
})

test('整条会话都没人认得时，走的还是沙箱策略那个根，取数不抛', async () => {
  const { ctx, provided } = fakeContext({ sandboxRoot: 'C:\\sandbox-root-for-tests' })
  apply(ctx)
  const reading = await provided.pathfinderRecords.read('nobody-knows-me', { signal })

  assert.equal(reading.workspaceRoot, 'C:\\sandbox-root-for-tests')
  assert.deepEqual(reading.sources, { nodes: 'missing', cycles: 'missing', instructions: 'missing', issues: 'missing' })
  assert.deepEqual(reading.nodes, {})
})

test('服务装在 ctx 上，由调用方给的取消信号转手递给口子', async () => {
  const { ctx, provided, asked } = fakeContext({ sandboxRoot: 'C:\\sandbox-root-for-tests' })
  apply(ctx)
  assert.equal(typeof provided.pathfinderRecords.read, 'function')

  const controlled = new AbortController()
  await provided.pathfinderRecords.read('s9', '', { signal: controlled.signal })
  assert.ok(asked.length > 0, '这一趟要真走到口子上，才谈得上信号到没到')
  for (const call of asked) {
    assert.equal(call.signal, controlled.signal, '口子收到的信号得是调用方递的那一条，不是端点自己新造的')
  }
})