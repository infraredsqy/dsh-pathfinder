/* 宿主半身那条远端口的单元测试：锁的是「DSH 的网关认不认得出这几个端点」。
 *
 * 这一关的判官在网关那一侧：它按类上那几枚记号认端点，参数是拿方法**源码**切出来
 * 的，于是几件看起来无关的小事会让整条端点在真部署里叫不动——参数带默认值、参数表
 * 末尾多一个逗号，都会被它判成「签名说不清」。这类毛病在本地一跑就过、上了真网关才
 * 现形，所以它值得一条用例守着。
 *
 * 网关与注册表是可选开发依赖：没装就跳过，装了就把五个端点逐个叫一遍。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PathfinderRecordsGateway } from '../src/host/gateway.ts'

/** 五个端点，与 `gateway.ts` 里那张表同一份口径。 */
const ENDPOINTS = ['read', 'archiveInstruction', 'reviveInstruction', 'removeInstruction', 'setCyclePolicy']

/** 装得上那一对可选依赖就先问一声。 */
const wired = await Promise.all([
  import('@deepseek-ai/cordis').then(() => true, () => false),
  import('@deepseek-ai/dsh-api-gateway').then(() => true, () => false),
  import('@deepseek-ai/dsh-typert-registry').then(() => true, () => false),
]).then((flags) => flags.every(Boolean))

/** 造一份最小的记录：四份里各有一点东西，够读数认出来。 */
function syntheticWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'pf-gateway-'))
  mkdirSync(join(root, '.pf', 'issues'), { recursive: true })
  writeFileSync(join(root, '.pf', 'ideas.json'), JSON.stringify({
    nodes: { 'n-1': { id: 'n-1', title: '一格', status: 'todo', created_at: '2026-10-01T00:00:00Z' } },
    edges: [],
  }))
  writeFileSync(join(root, '.pf', 'state.json'), JSON.stringify({
    cycles: [{ id: 'line-1', status: 'active', created_at: '2026-10-01T00:00:00Z', path: [], holding: [] }],
  }))
  writeFileSync(join(root, '.pf', 'instructions.json'), JSON.stringify({
    instructions: [{ id: 'i-1', text: '一句话', scope: 'global', state: 'live', at: '2026-10-01T00:00:00Z' }],
  }))
  writeFileSync(join(root, '.pf', 'issues', 'issues.json'), JSON.stringify({ issues: {} }))
  return root
}

/** 一个装上读取口、网关与注册表的真 cordis 上下文。 */
async function liveGateway(root) {
  const { Context } = await import('@deepseek-ai/cordis')
  const { TypertGatewayService } = await import('@deepseek-ai/dsh-api-gateway')
  const { TypertRegistry } = await import('@deepseek-ai/dsh-typert-registry')

  const ctx = new Context()
  ctx.provide('workspaceFiles', {
    async list(scope, path) {
      const { readdirSync, existsSync } = await import('node:fs')
      const target = join(root, path)
      if (!existsSync(target)) {
        const error = new Error('no entry here')
        error.code = 'workspace-file/not-found'
        throw error
      }
      return {
        path,
        entries: readdirSync(target, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        })),
        truncated: false,
      }
    },
    async read(scope, path, range) {
      const { existsSync, readFileSync } = await import('node:fs')
      const target = join(root, path)
      if (!existsSync(target)) {
        const error = new Error('no entry here')
        error.code = 'workspace-file/not-found'
        throw error
      }
      const lines = readFileSync(target, 'utf8').split('\n')
      const offset = range?.offset ?? 1
      const limit = range?.limit ?? 400
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      return { text: slice.join('\n'), lines: slice.length, eof: offset - 1 + slice.length >= lines.length }
    },
  })
  ctx.provide('sessions', { get: (id) => (id === 's1' ? { header: { cwd: root } } : undefined) })
  ctx.provide('sandboxPolicy', { workspaceRoot: root })
  ctx.provide('subprocess', {
    async resolveExecutable() { return 'pf' },
    spawn() { return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: '' }) } } } },
  })

  new TypertRegistry(ctx)
  const gateway = new TypertGatewayService(ctx)
  ctx.provide('pathfinderRecords', new PathfinderRecordsGateway(ctx))
  const peer = { signal: new AbortController().signal, principal: { kind: 'owner' } }
  return {
    ctx,
    call: async (method, args) => {
      try {
        return { ok: true, value: await gateway.invoke({ namespace: 'pathfinderRecords', method, args, peer }) }
      } catch (error) {
        return { ok: false, code: error?.code, message: error?.message ?? String(error) }
      }
    },
  }
}

test('五个端点在源码模式下逐个叫得动：签名这一关先过，别的错另算', { skip: !wired }, async () => {
  const root = syntheticWorkspace()
  const { ctx, call } = await liveGateway(root)
  try {
    for (const method of ENDPOINTS) {
      const answer = await call(method, {})
      assert.notEqual(answer.code, 'gateway/signature-invalid', `${method} 的签名被网关判成说不清：${String(answer.message)}`)
      assert.notEqual(answer.code, 'gateway/invocation-unavailable', `${method} 没被网关认出来：${String(answer.message)}`)
    }
  } finally {
    await ctx.stop?.()
  }
})

test('取数那一条：网关把那条会话的工作区读成一份真读数', { skip: !wired }, async () => {
  const root = syntheticWorkspace()
  const { ctx, call } = await liveGateway(root)
  try {
    const answer = await call('read', { sessionId: 's1', options: {} })
    assert.equal(answer.ok, true, String(answer.message))
    assert.equal(answer.value.workspaceRoot, root)
    assert.deepEqual(answer.value.sources, { nodes: 'read', cycles: 'read', instructions: 'read', issues: 'read' })
    assert.deepEqual(Object.keys(answer.value.nodes), ['n-1'])
    assert.equal(answer.value.cycles.length, 1)
  } finally {
    await ctx.stop?.()
  }
})

test('三个写端点与那条策略端点：网关也都叫得动', { skip: !wired }, async () => {
  const root = syntheticWorkspace()
  const { ctx, call } = await liveGateway(root)
  try {
    const archived = await call('archiveInstruction', { sessionId: 's1', id: 'i-1' })
    assert.equal(archived.ok, true, String(archived.message))
    const revived = await call('reviveInstruction', { sessionId: 's1', id: 'i-1' })
    assert.equal(revived.ok, true, String(revived.message))
    const removed = await call('removeInstruction', { sessionId: 's1', id: 'i-1' })
    assert.equal(removed.ok, true, String(removed.message))
    const policy = await call('setCyclePolicy', { sessionId: 's1', cycle: 'line-1', key: 'parallel', value: '2' })
    assert.equal(policy.ok, true, String(policy.message))
  } finally {
    await ctx.stop?.()
  }
})