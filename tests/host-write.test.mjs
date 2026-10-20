/* The write-plane segment: locks in "which command one op maps to", plus the argument gate.
 *
 * This layer never touches the records themselves — every write rides on the command line handed
 * outward, so that command line is what gets locked: which `pf` command each of the six endpoints
 * spawns, what inputs the argument gate keeps out, and how the command line is assembled on Windows.
 *
 * "Add an instruction" carries the user's verbatim words, which cannot pass that gate, so it has
 * its own argv: interpreter + `pf.py`, the whole sentence passed as a single argument — `&` stays
 * `&` in that command line, which is why these tests lock it separately.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PathfinderRecordsGateway } from '../src/host/gateway.ts'

function fakeSubprocess({
  executable = 'C:\\tools\\bin\\pf.cmd',
  python = 'C:\\python\\python.exe',
  py = 'C:\\Windows\\py.exe',
  exitCode = 0,
  stdout = '',
  stderr = '',
} = {}) {
  const specs = []
  const found = (name, path) => {
    if (path === null) throw new Error(`${name} 不在 PATH 上`)
    return path
  }
  return {
    specs,
    async resolveExecutable(command) {
      if (command === 'python') return found('python', python)
      if (command === 'py') return found('py', py)
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

/** A minimal host context, enough for this layer: writes go to whatever root the session header points to. */
function fakeContext({ subprocess, workspaceRoot = 'C:\\workspace' } = {}) {
  return {
    workspaceFiles: {},
    sessions: { get: () => ({ header: { cwd: workspaceRoot } }) },
    sandboxPolicy: { workspaceRoot },
    get: (service) => (service === 'subprocess' ? subprocess : undefined),
  }
}

function wordsOf(spec) {
  const line = spec.argv[spec.argv.length - 1]
  return line.split(' ').slice(1)
}

test('归档一条：pf instruction resolve <id> --state withdrawn', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.archiveInstruction('s1', '', 'i-0007')

  assert.equal(outcome.ok, true)
  assert.equal(subprocess.specs.length, 1)
  assert.deepEqual(wordsOf(subprocess.specs[0]), ['instruction', 'resolve', 'i-0007', '--state', 'withdrawn'])
  assert.equal(subprocess.specs[0].cwd, 'C:\\workspace')
})

test('点名一个工作区：命令就跑在那个根上，不看这条会话自己落在哪儿', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  await gateway.reviveInstruction('s1', 'C:\\somewhere\\else', 'i-0007')

  assert.equal(subprocess.specs[0].cwd, 'C:\\somewhere\\else')
  assert.deepEqual(wordsOf(subprocess.specs[0]), ['instruction', 'revive', 'i-0007'])
})

test('复原一条：pf instruction revive <id>', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  await gateway.reviveInstruction('s1', '', 'i-0007')

  assert.deepEqual(wordsOf(subprocess.specs[0]), ['instruction', 'revive', 'i-0007'])
})

test('删一条：pf instruction rm <id>', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  await gateway.removeInstruction('s1', '', 'i-0007')

  assert.deepEqual(wordsOf(subprocess.specs[0]), ['instruction', 'rm', 'i-0007'])
})

test('记下一条：pf instruction add --scope <范围> --text，原话整句作为一个参数', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const said = '先看一眼记录再动手 & 别猜'
  const outcome = await gateway.addInstruction('s1', '', said, 'global', '', '')

  assert.equal(outcome.ok, true)
  assert.deepEqual(
    subprocess.specs[0].argv.slice(-6),
    ['instruction', 'add', '--scope', 'global', '--text', said],
  )
})

test('记下一条：绑哪条线、绑哪一格各自点名，另外那两个范围一个都不带', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  await gateway.addInstruction('s1', '', '跟着这条线走', 'cycle', 'panel-to-plugin', '')
  await gateway.addInstruction('s1', '', '这一格先停下', 'node', '', '3fac279b')

  assert.deepEqual(
    subprocess.specs[0].argv.slice(-8),
    ['instruction', 'add', '--scope', 'cycle', '--cycle', 'panel-to-plugin', '--text', '跟着这条线走'],
  )
  assert.deepEqual(
    subprocess.specs[1].argv.slice(-8),
    ['instruction', 'add', '--scope', 'node', '--node', '3fac279b', '--text', '这一格先停下'],
  )
})

test('记下一条：Windows 上那一次起的是解释器，不经过 cmd', { skip: process.platform !== 'win32' }, async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  await gateway.addInstruction('s1', '', '有 & 的一句', 'global', '', '')

  assert.deepEqual(
    subprocess.specs[0].argv,
    ['C:\\python\\python.exe', '-X', 'utf8', 'C:\\tools\\bin\\pf.py', 'instruction', 'add', '--scope', 'global', '--text', '有 & 的一句'],
  )
})

test('记下一条：`python` 不在就换 `py -3`，两条路都留着', { skip: process.platform !== 'win32' }, async () => {
  const subprocess = fakeSubprocess({ python: null })
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.addInstruction('s1', '', '一句话', 'global', '', '')

  assert.equal(outcome.ok, true)
  assert.deepEqual(
    subprocess.specs[0].argv.slice(0, 5),
    ['C:\\Windows\\py.exe', '-3', '-X', 'utf8', 'C:\\tools\\bin\\pf.py'],
  )
})

test('记下一条：两种叫法都不在这台机器上，宁可不落笔，如实说', async () => {
  const subprocess = fakeSubprocess({ python: null, py: null })
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.addInstruction('s1', '', '一句话', 'global', '', '')

  assert.equal(outcome.ok, false)
  assert.deepEqual(subprocess.specs, [])
  assert.match(outcome.text, /解释器/u)
})

test('记下一条：空话与不认识的范围当场说清，命令一条都不递', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const blank = await gateway.addInstruction('s1', '', '   ', 'global', '', '')
  const odd = await gateway.addInstruction('s1', '', '一句话', 'everywhere', '', '')

  assert.equal(blank.ok, false)
  assert.equal(odd.ok, false)
  assert.match(odd.text, /无法识别的范围/u)
  assert.deepEqual(subprocess.specs, [])
})

test('一个策略数：pf cycle policy <线> <键> <值>', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  await gateway.setCyclePolicy('s1', '', 'panel-to-plugin', 'test_seconds_limit', '90')

  assert.deepEqual(wordsOf(subprocess.specs[0]), ['cycle', 'policy', 'panel-to-plugin', 'test_seconds_limit', '90'])
})

test('无法识别的策略键：不递命令，直接拒', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.setCyclePolicy('s1', '', 'panel-to-plugin', 'spawner', 'dsh')

  assert.equal(outcome.ok, false)
  assert.deepEqual(subprocess.specs, [])
})

test('参数闸：命令行元字符进不去，命令也就不递', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.archiveInstruction('s1', '', 'i-1 & del /s C:\\')

  assert.equal(outcome.ok, false)
  assert.deepEqual(subprocess.specs, [])
  assert.match(outcome.text, /不能进入命令/u)
})

test('工具非零退出：读数里那个数一个都不改，ok 是假', async () => {
  const subprocess = fakeSubprocess({ exitCode: 1, stderr: '没有 i-0007 这一条' })
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.archiveInstruction('s1', '', 'i-0007')

  assert.equal(outcome.ok, false)
  assert.match(outcome.text, /没有 i-0007 这一条/u)
})

test('宿主没有进程通道：如实说这次写入没法落笔', async () => {
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess: undefined }))
  const outcome = await gateway.removeInstruction('s1', '', 'i-0007')

  assert.equal(outcome.ok, false)
  assert.match(outcome.text, /进程通道/u)
})

test('Windows 上那条命令行：解释器 + 一条命令，`pf` 那条路径不带引号', { skip: process.platform !== 'win32' }, async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  await gateway.reviveInstruction('s1', '', 'i-0007')
  const spec = subprocess.specs[0]

  assert.deepEqual(spec.argv.slice(0, 4), [process.env['ComSpec'] ?? 'cmd.exe', '/d', '/s', '/c'])
  assert.match(spec.argv[4], /^C:\\tools\\bin\\pf\.cmd instruction revive i-0007$/u)
})

test('Windows 上路径带空格：宁可不落笔，不硬拼一条会被 cmd 认错的命令行', { skip: process.platform !== 'win32' }, async () => {
  const subprocess = fakeSubprocess({ executable: 'C:\\Program Files\\pf\\pf.cmd' })
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.reviveInstruction('s1', '', 'i-0007')

  assert.equal(outcome.ok, false)
  assert.deepEqual(subprocess.specs, [])
  assert.match(outcome.text, /cmd 无法处理的字符/u)
})
