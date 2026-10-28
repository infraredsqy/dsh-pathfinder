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
import { fakeContext, fakeSubprocess as sharedSubprocess, wordsOf } from './helpers/host-fixtures.mjs'

/** The shared subprocess stand-in wearing this file's own interpreter defaults: the two names
 * `pf.py` can be launched through, each overridable per case (pass `null` to take it off PATH). */
function fakeSubprocess({ python = 'C:\\python\\python.exe', py = 'C:\\Windows\\py.exe', ...rest } = {}) {
  return sharedSubprocess({ ...rest, interpreters: { python, py } })
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

  assert.deepEqual(outcome, { ok: false, code: 'no-interpreter' }, '没有解释器时报这个码，句子留给面板去说')
  assert.deepEqual(subprocess.specs, [])
})

test('记下一条：空话与不认识的范围当场说清，命令一条都不递', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const blank = await gateway.addInstruction('s1', '', '   ', 'global', '', '')
  const odd = await gateway.addInstruction('s1', '', '一句话', 'everywhere', '', '')

  assert.deepEqual(blank, { ok: false, code: 'empty-text' }, '空话没有可记的东西')
  assert.deepEqual(odd, { ok: false, code: 'scope-unknown', detail: 'everywhere' }, '不认识的范围把它本身放在 detail 里')
  assert.deepEqual(subprocess.specs, [])
})

test('参数闸：命令行元字符进不去，命令也就不递', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const id = 'i-1 & del /s C:\\'
  const outcome = await gateway.archiveInstruction('s1', '', id)

  assert.deepEqual(outcome, { ok: false, code: 'arg-not-allowed', detail: id }, '被闸住的那个参数原样放进 detail')
  assert.deepEqual(subprocess.specs, [])
})

test('工具非零退出：读数里那个数一个都不改，ok 是假', async () => {
  const subprocess = fakeSubprocess({ exitCode: 1, stderr: '没有 i-0007 这一条' })
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.archiveInstruction('s1', '', 'i-0007')

  assert.deepEqual(
    outcome,
    { ok: false, code: 'tool-refused', detail: '没有 i-0007 这一条' },
    '工具自己说了原因：原因原样放进 detail，不替它翻译',
  )
})

test('宿主没有进程通道：如实说这次写入没法落笔', async () => {
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess: undefined }))
  const outcome = await gateway.removeInstruction('s1', '', 'i-0007')

  assert.deepEqual(outcome, { ok: false, code: 'no-subprocess' }, '没有进程通道就没有写入，报的是这个码')
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

  assert.deepEqual(
    outcome,
    { ok: false, code: 'pf-path-unsafe', detail: 'C:\\Program Files\\pf\\pf.cmd' },
    '拼不出一条 cmd 认得的命令行时，把那条路径原样报出来',
  )
  assert.deepEqual(subprocess.specs, [])
})
