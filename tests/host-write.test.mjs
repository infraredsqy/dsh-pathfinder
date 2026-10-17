/* 写面那一段的单元测试：锁的是「一条动作对应哪一条命令」，以及那道参数闸。
 *
 * 这一层不碰记录本身，落笔全靠递出去的那条命令行——所以锁住的就是那条命令行：
 * 五个端点各起哪一条 `pf` 命令、参数闸把什么样的输入挡在外面、Windows 上那条
 * 命令行拼成什么样。命令行的名字与次序是工具那一侧的口径，它们一改，这几条就红。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PathfinderRecordsGateway } from '../src/host/gateway.ts'

/** 一份记下了「被递出去的是哪条命令行」的起进程替身。 */
function fakeSubprocess({ executable = 'C:\\tools\\bin\\pf.cmd', exitCode = 0, stdout = '', stderr = '' } = {}) {
  const specs = []
  return {
    specs,
    async resolveExecutable() {
      return executable
    },
    spawn(spec) {
      specs.push(spec)
      return {
        done: Promise.resolve({ exitCode }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: stderr }) },
        },
      }
    },
  }
}

/** 一份够这一层用的最小宿主上下文：会话头指着哪个根就写到哪个根。 */
function fakeContext({ subprocess, workspaceRoot = 'C:\\workspace' } = {}) {
  return {
    workspaceFiles: {},
    sessions: { get: () => ({ header: { cwd: workspaceRoot } }) },
    sandboxPolicy: { workspaceRoot },
    get: (service) => (service === 'subprocess' ? subprocess : undefined),
  }
}

/** 一条命令行里 `pf` 后面那几个词。 */
function wordsOf(spec) {
  const line = spec.argv[spec.argv.length - 1]
  return line.split(' ').slice(1)
}

test('归档一条：pf instruction resolve <id> --state withdrawn', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.archiveInstruction('s1', 'i-0007')

  assert.equal(outcome.ok, true)
  assert.equal(subprocess.specs.length, 1)
  assert.deepEqual(wordsOf(subprocess.specs[0]), ['instruction', 'resolve', 'i-0007', '--state', 'withdrawn'])
  assert.equal(subprocess.specs[0].cwd, 'C:\\workspace')
})

test('复原一条：pf instruction revive <id>', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  await gateway.reviveInstruction('s1', 'i-0007')

  assert.deepEqual(wordsOf(subprocess.specs[0]), ['instruction', 'revive', 'i-0007'])
})

test('删一条：pf instruction rm <id>', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  await gateway.removeInstruction('s1', 'i-0007')

  assert.deepEqual(wordsOf(subprocess.specs[0]), ['instruction', 'rm', 'i-0007'])
})

test('一个策略数：pf cycle policy <线> <键> <值>', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  await gateway.setCyclePolicy('s1', 'panel-to-plugin', 'test_seconds_limit', '90')

  assert.deepEqual(wordsOf(subprocess.specs[0]), ['cycle', 'policy', 'panel-to-plugin', 'test_seconds_limit', '90'])
})

test('不认得的策略键：不递命令，直接拒', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.setCyclePolicy('s1', 'panel-to-plugin', 'spawner', 'dsh')

  assert.equal(outcome.ok, false)
  assert.deepEqual(subprocess.specs, [])
})

test('参数闸：命令行元字符进不去，命令也就不递', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.archiveInstruction('s1', 'i-1 & del /s C:\\')

  assert.equal(outcome.ok, false)
  assert.deepEqual(subprocess.specs, [])
  assert.match(outcome.text, /不能进命令/u)
})

test('工具非零退出：读数里那个数一个都不改，ok 是假', async () => {
  const subprocess = fakeSubprocess({ exitCode: 1, stderr: '没有 i-0007 这一条' })
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.archiveInstruction('s1', 'i-0007')

  assert.equal(outcome.ok, false)
  assert.match(outcome.text, /没有 i-0007 这一条/u)
})

test('没有起进程的口子：如实说这一手落不了笔', async () => {
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess: undefined }))
  const outcome = await gateway.removeInstruction('s1', 'i-0007')

  assert.equal(outcome.ok, false)
  assert.match(outcome.text, /起进程/u)
})

test('Windows 上那条命令行：解释器 + 一条命令，`pf` 那条路径不带引号', { skip: process.platform !== 'win32' }, async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  await gateway.reviveInstruction('s1', 'i-0007')
  const spec = subprocess.specs[0]

  assert.deepEqual(spec.argv.slice(0, 4), [process.env['ComSpec'] ?? 'cmd.exe', '/d', '/s', '/c'])
  assert.match(spec.argv[4], /^C:\\tools\\bin\\pf\.cmd instruction revive i-0007$/u)
})

test('Windows 上路径带空格：宁可不落笔，不硬拼一条会被 cmd 认错的命令行', { skip: process.platform !== 'win32' }, async () => {
  const subprocess = fakeSubprocess({ executable: 'C:\\Program Files\\pf\\pf.cmd' })
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.reviveInstruction('s1', 'i-0007')

  assert.equal(outcome.ok, false)
  assert.deepEqual(subprocess.specs, [])
  assert.match(outcome.text, /cmd 处理不了的字符/u)
})

test('端点的名字与数量：网关在源码模式下认的就是这五个', () => {
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess: fakeSubprocess() }))

  assert.equal(gateway.typertRemote.namespace, 'pathfinderRecords')
  assert.equal(gateway.typertRemote.serviceKey, 'pathfinderRecords')
  assert.equal(gateway.typertRemote.service, gateway)
})