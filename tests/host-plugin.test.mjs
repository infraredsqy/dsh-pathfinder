/* 宿主半身插件那一段：锁的是工作区根的解析次序。
 *
 * 三个来源按活着的会话头 → 落盘的会话头 → 沙箱策略那个根的顺序落定，一项都不许乱；
 * 有活着的会话头就不再问落盘的头。递进口子的那个根是不是解析出来的那一个，也在这里锁住。
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
    async list(scope, path) {
      asked.push({ kind: 'list', scope, path })
      const error = new Error(`no entry at ${path}`)
      error.code = 'workspace-file/not-found'
      throw error
    },
    async read(scope, path, range) {
      asked.push({ kind: 'read', scope, path, range })
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
  await provided.pathfinderRecords.read('s9', { signal: controlled.signal })
  assert.ok(asked.length > 0)
})