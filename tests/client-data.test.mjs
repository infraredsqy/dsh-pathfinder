/* 浏览器半身那条通路的数据面：锁的是「从哪一层接上、递出去的是哪一条端点」。
 *
 * 面板不自己取数：它把「哪条会话、哪个工作区」交给这一层，这一层按装好的远程命名空间、
 * 或者载体那一层，叫到同一个端点上。锁的就是两条路的名字与参数形状：命名空间一改、端点名
 * 一改、参数次序一改，这几条就红。
 *
 * 面板顶上那枚工作区选择器挑中的那个根是第二个参数、次序就在会话身份后面：参数是按位置
 * 递出去的，挪一个位置就会把路径当成 id 递给工具，所以每一处都写死它。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPanelPort } from '../src/client/data.ts'

function fakeNamespace(answer = { ok: true, value: { workspaceRoot: 'C:\\ws' } }) {
  const calls = []
  const namespace = {}
  for (const method of ['read', 'readSessions', 'addInstruction', 'archiveInstruction', 'reviveInstruction', 'removeInstruction', 'setCyclePolicy', 'readConfig', 'setConfig']) {
    namespace[method] = async (...values) => {
      calls.push({ method, values })
      return answer
    }
  }
  return { calls, namespace }
}

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

test('装好了远程命名空间：走它，取数是 read(sessionId, 工作区根, {})', async () => {
  const { calls, namespace } = fakeNamespace()
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinderRecords' ? namespace : undefined) })

  assert.equal(port.source, 'remote')
  const reading = await port.read('s1', 'C:\\picked')
  assert.equal(reading.workspaceRoot, 'C:\\ws')
  assert.deepEqual(calls[0], { method: 'read', values: ['s1', 'C:\\picked', {}] })
})

test('没挑工作区：那个位置递一个空字符串，由宿主按会话身份定根', async () => {
  const { calls, namespace } = fakeNamespace()
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinderRecords' ? namespace : undefined) })

  await port.read('s1', '')
  assert.deepEqual(calls[0], { method: 'read', values: ['s1', '', {}] })
})

test('命名空间挂在 remote 下面一层也认', async () => {
  const { calls, namespace } = fakeNamespace()
  const port = createPanelPort({ get: (name) => (name === 'remote' ? { pathfinderRecords: namespace } : undefined) })

  assert.equal(port.source, 'remote')
  await port.read('s1', '')
  assert.equal(calls.length, 1)
})

test('远程那条路上，三个写动作各叫哪一个端点', async () => {
  const { calls, namespace } = fakeNamespace({ ok: true, value: { ok: true, text: '' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinderRecords' ? namespace : undefined) })

  await port.write('archive', 's1', 'C:\\picked', 'i-1')
  await port.write('revive', 's1', 'C:\\picked', 'i-1')
  await port.write('remove', 's1', 'C:\\picked', 'i-1')
  await port.setPolicy('s1', 'C:\\picked', 'panel-to-plugin', 'parallel', '3')

  assert.deepEqual(calls.map((call) => call.method), [
    'archiveInstruction',
    'reviveInstruction',
    'removeInstruction',
    'setCyclePolicy',
  ])
  assert.deepEqual(calls[0].values, ['s1', 'C:\\picked', 'i-1'])
  assert.deepEqual(calls[3].values, ['s1', 'C:\\picked', 'panel-to-plugin', 'parallel', '3'])
})

test('远程那条路上，设置那两条各叫哪一个端点', async () => {
  const { calls, namespace } = fakeNamespace({ ok: true, value: { project: 'C:\\ws', ok: true, text: '', entries: {} } })
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinderRecords' ? namespace : undefined) })

  const reading = await port.readConfig('s1', 'C:\\picked')
  await port.setConfig('s1', 'C:\\picked', 'test_tier', 'minimal')

  assert.equal(reading.project, 'C:\\ws')
  assert.deepEqual(calls.map((call) => call.method), ['readConfig', 'setConfig'])
  assert.deepEqual(calls[0].values, ['s1', 'C:\\picked'])
  assert.deepEqual(calls[1].values, ['s1', 'C:\\picked', 'test_tier', 'minimal'])
})

test('记下一条那一条口子：端点叫 addInstruction，原话与范围按位置递出去', async () => {
  const { calls, namespace } = fakeNamespace({ ok: true, value: { ok: true, text: 'INSTRUCTION i-0003' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinderRecords' ? namespace : undefined) })

  const outcome = await port.say('s1', 'C:\\picked', '先看一眼记录再动手', 'cycle', 'panel-to-plugin', '')

  assert.equal(outcome.text, 'INSTRUCTION i-0003')
  assert.deepEqual(calls, [{
    method: 'addInstruction',
    values: ['s1', 'C:\\picked', '先看一眼记录再动手', 'cycle', 'panel-to-plugin', ''],
  }])
})

test('远程那一层说没成：写面把它的话带回来，不假装成了', async () => {
  const { namespace } = fakeNamespace({ ok: false, error: { code: 'gateway/internal', message: '工具拒了' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinderRecords' ? namespace : undefined) })
  const outcome = await port.write('archive', 's1', '', 'i-1')

  assert.equal(outcome.ok, false)
  assert.match(outcome.text, /gateway\/internal: 工具拒了/u)
})

test('远程那一层取数失败：读数照抛，不编一份空的', async () => {
  const { namespace } = fakeNamespace({ ok: false, error: { message: '读不动' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinderRecords' ? namespace : undefined) })

  await assert.rejects(() => port.read('s1', ''), /读不动/u)
})

test('会话笔记那一条：端点叫 readSessions(sessionId, 工作区根)，解出来的表原样带回来', async () => {
  const { calls, namespace } = fakeNamespace({ ok: true, value: { project: 'C:\\ws', recordPath: '.pf/meta/sessions', state: 'read', sessions: { 'n-1': 'session-7' } } })
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinderRecords' ? namespace : undefined) })

  const reading = await port.readSessions('s1', 'C:\\picked')
  assert.deepEqual(reading.sessions, { 'n-1': 'session-7' })
  assert.deepEqual(calls, [{ method: 'readSessions', values: ['s1', 'C:\\picked'] }])
})

test('命名空间没装上：退到载体那一层，端点与参数都指名道姓', async () => {
  const { calls, carrier } = fakeCarrier()
  const port = createPanelPort({ get: (name) => (name === 'connection' ? carrier : undefined) })

  assert.equal(port.source, 'carrier')
  const reading = await port.read('s1', 'C:\\picked')
  assert.equal(reading.workspaceRoot, 'C:\\ws')
  assert.equal(calls[0].path, '/api')
  assert.equal(calls[0].endpoint, 'pathfinderRecords/read')
  assert.deepEqual(calls[0].payload, { args: { sessionId: 's1', workspaceRoot: 'C:\\picked', options: {} } })

  await port.write('remove', 's1', 'C:\\picked', 'i-1')
  assert.equal(calls[1].endpoint, 'pathfinderRecords/removeInstruction')
  assert.deepEqual(calls[1].payload, { args: { sessionId: 's1', workspaceRoot: 'C:\\picked', id: 'i-1' } })

  await port.setPolicy('s1', 'C:\\picked', 'panel-to-plugin', 'parallel', '3')
  assert.equal(calls[2].endpoint, 'pathfinderRecords/setCyclePolicy')
  assert.deepEqual(calls[2].payload, { args: { sessionId: 's1', workspaceRoot: 'C:\\picked', cycle: 'panel-to-plugin', key: 'parallel', value: '3' } })

  await port.readConfig('s1', '')
  assert.equal(calls[3].endpoint, 'pathfinderRecords/readConfig')
  assert.deepEqual(calls[3].payload, { args: { sessionId: 's1', workspaceRoot: '' } })

  await port.setConfig('s1', '', 'issue_repair', 'off')
  assert.equal(calls[4].endpoint, 'pathfinderRecords/setConfig')
  assert.deepEqual(calls[4].payload, { args: { sessionId: 's1', workspaceRoot: '', key: 'issue_repair', value: 'off' } })

  await port.readSessions('s1', '')
  assert.equal(calls[5].endpoint, 'pathfinderRecords/readSessions')
  assert.deepEqual(calls[5].payload, { args: { sessionId: 's1', workspaceRoot: '' } })

  await port.say('s1', 'C:\\picked', '先看一眼记录再动手', 'node', '', '3fac279b')
  assert.equal(calls[6].endpoint, 'pathfinderRecords/addInstruction')
  assert.deepEqual(calls[6].payload, {
    args: { sessionId: 's1', workspaceRoot: 'C:\\picked', text: '先看一眼记录再动手', scope: 'node', cycle: '', node: '3fac279b' },
  })
})

test('两条都没接上：口子说实话，读不出来就是读不出来', async () => {
  const port = createPanelPort({ get: () => undefined })

  assert.equal(port.source, 'none')
  await assert.rejects(() => port.read('s1', ''), /未连接寻路记录服务/u)
  await assert.rejects(() => port.readConfig('s1', ''), /未连接寻路记录服务/u)
  await assert.rejects(() => port.readSessions('s1', ''), /未连接寻路记录服务/u)
  const outcome = await port.write('archive', 's1', '', 'i-1')
  assert.equal(outcome.ok, false)
  const said = await port.say('s1', '', '一句话', 'global', '', '')
  assert.equal(said.ok, false)
  const refused = await port.setConfig('s1', '', 'test_tier', 'minimal')
  assert.equal(refused.ok, false)
})
