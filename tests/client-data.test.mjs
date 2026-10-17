/* 浏览器半身那条通路的数据面：锁的是「从哪一层接上、递出去的是哪一条端点」。
 *
 * 面板不自己取数——它把「哪条会话」交给这一层，这一层按装好的远程命名空间、或者
 * 载体那一层，叫到同一个端点上。锁的就是这两条路的名字与参数形状：命名空间一改、
 * 端点名一改、参数次序一改，这几条就红。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPanelPort } from '../src/client/data.ts'

/** 一份记下了每一次调用的远程命名空间替身；回的都是 `{ ok, value }` 那一副脸。 */
function fakeNamespace(answer = { ok: true, value: { workspaceRoot: 'C:\\ws' } }) {
  const calls = []
  const namespace = {}
  for (const method of ['read', 'archiveInstruction', 'reviveInstruction', 'removeInstruction', 'setCyclePolicy']) {
    namespace[method] = async (...values) => {
      calls.push({ method, values })
      return answer
    }
  }
  return { calls, namespace }
}

/** 一份记下了每一次调用的载体替身。 */
function fakeCarrier(answer = { ok: true, value: { workspaceRoot: 'C:\\ws' } }) {
  const calls = []
  return {
    calls,
    carrier: {
      rpc: {
        call: async (path, endpoint, payload, signal) => {
          calls.push({ path, endpoint, payload, signal })
          return answer
        },
      },
    },
  }
}

test('装好了远程命名空间：走它，取数是 read(sessionId, {})', async () => {
  const { calls, namespace } = fakeNamespace()
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinderRecords' ? namespace : undefined) })

  assert.equal(port.source, 'remote')
  const reading = await port.read('s1')
  assert.equal(reading.workspaceRoot, 'C:\\ws')
  assert.deepEqual(calls[0], { method: 'read', values: ['s1', {}] })
})

test('命名空间挂在 remote 下面一层也认', async () => {
  const { calls, namespace } = fakeNamespace()
  const port = createPanelPort({ get: (name) => (name === 'remote' ? { pathfinderRecords: namespace } : undefined) })

  assert.equal(port.source, 'remote')
  await port.read('s1')
  assert.equal(calls.length, 1)
})

test('远程那条路上，三个写动作各叫哪一个端点', async () => {
  const { calls, namespace } = fakeNamespace({ ok: true, value: { ok: true, text: '' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinderRecords' ? namespace : undefined) })

  await port.write('archive', 's1', 'i-1')
  await port.write('revive', 's1', 'i-1')
  await port.write('remove', 's1', 'i-1')
  await port.setPolicy('s1', 'panel-to-plugin', 'parallel', '3')

  assert.deepEqual(calls.map((call) => call.method), [
    'archiveInstruction',
    'reviveInstruction',
    'removeInstruction',
    'setCyclePolicy',
  ])
  assert.deepEqual(calls[0].values, ['s1', 'i-1'])
  assert.deepEqual(calls[3].values, ['s1', 'panel-to-plugin', 'parallel', '3'])
})

test('远程那一层说没成：写面把它的话带回来，不假装成了', async () => {
  const { namespace } = fakeNamespace({ ok: false, error: { code: 'gateway/internal', message: '工具拒了' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinderRecords' ? namespace : undefined) })
  const outcome = await port.write('archive', 's1', 'i-1')

  assert.equal(outcome.ok, false)
  assert.match(outcome.text, /gateway\/internal: 工具拒了/u)
})

test('远程那一层取数失败：读数照抛，不编一份空的', async () => {
  const { namespace } = fakeNamespace({ ok: false, error: { message: '读不动' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinderRecords' ? namespace : undefined) })

  await assert.rejects(() => port.read('s1'), /读不动/u)
})

test('命名空间没装上：退到载体那一层，端点与参数都指名道姓', async () => {
  const { calls, carrier } = fakeCarrier()
  const port = createPanelPort({ get: (name) => (name === 'connection' ? carrier : undefined) })

  assert.equal(port.source, 'carrier')
  const reading = await port.read('s1')
  assert.equal(reading.workspaceRoot, 'C:\\ws')
  assert.equal(calls[0].path, '/api')
  assert.equal(calls[0].endpoint, 'pathfinderRecords/read')
  assert.deepEqual(calls[0].payload, { args: { sessionId: 's1', options: {} } })

  await port.write('remove', 's1', 'i-1')
  assert.equal(calls[1].endpoint, 'pathfinderRecords/removeInstruction')
  assert.deepEqual(calls[1].payload, { args: { sessionId: 's1', id: 'i-1' } })

  await port.setPolicy('s1', 'panel-to-plugin', 'parallel', '3')
  assert.equal(calls[2].endpoint, 'pathfinderRecords/setCyclePolicy')
  assert.deepEqual(calls[2].payload, { args: { sessionId: 's1', cycle: 'panel-to-plugin', key: 'parallel', value: '3' } })
})

test('两条都没接上：口子说实话，读不出来就是读不出来', async () => {
  const port = createPanelPort({ get: () => undefined })

  assert.equal(port.source, 'none')
  await assert.rejects(() => port.read('s1'), /没接上/u)
  const outcome = await port.write('archive', 's1', 'i-1')
  assert.equal(outcome.ok, false)
})