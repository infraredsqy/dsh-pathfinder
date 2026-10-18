/* 设置那一格的两条端点：锁的是「工具印的那几行读成什么」与「写的那一条命令长什么样」。
 *
 * 这一格不自己判一个值合不合法（那是工具那一侧的 `parse_value`），也不自己拼 `.pf` 底下的
 * 路径：读是把 `pf config list` 印出来的几行读开，写是把一条 `config set` 递出去。所以这里
 * 锁的就是这两样——印出来的那一行长什么样、递出去的 argv 是哪几个词、工作目录在哪儿。
 * 工具的印法一改、键表一改、命令的次序一改，这几条就红。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PathfinderRecordsGateway } from '../src/host/gateway.ts'
import { CONFIG_KEYS, parseConfigList } from '../src/host/project-config.ts'

/** 本机 `pf config list` 印的那四行，原样。 */
const LISTED = [
  'max_agents    = 1（项目 .pf/config.json）',
  'test_tier     = full（项目 .pf/config.json）',
  'worktree_mode = off（项目 .pf/config.json）',
  'issue_repair  = on（出厂默认）',
].join('\n')

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

/** 一份够这一层用的最小宿主上下文：会话头指着哪个根，命令就跑在哪个根上。 */
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
  return spec.argv[spec.argv.length - 1].split(' ').slice(1)
}

test('工具印的四行：值与它住哪一层都读出来', () => {
  const entries = parseConfigList(LISTED)

  assert.deepEqual(Object.keys(entries).sort(), [...CONFIG_KEYS].sort())
  assert.deepEqual(entries['max_agents'], { value: '1', layer: 'project' })
  assert.deepEqual(entries['test_tier'], { value: 'full', layer: 'project' })
  assert.deepEqual(entries['worktree_mode'], { value: 'off', layer: 'project' })
  assert.deepEqual(entries['issue_repair'], { value: 'on', layer: 'default' })
})

test('全局那一层：工具印的是家目录那份，读作 global', () => {
  const entries = parseConfigList('issue_repair  = off（全局 ~/.pf/config.json）')

  assert.deepEqual(entries['issue_repair'], { value: 'off', layer: 'global' })
})

test('不认得的层名：那一行留着，层签留空——不替工具编一个它没说的层', () => {
  const entries = parseConfigList('test_tier     = minimal（这一层谁都不认得）')

  assert.deepEqual(entries['test_tier'], { value: 'minimal', layer: null })
})

test('不是设置行的都不收：工具另印的提醒、空行、没有值的那一行', () => {
  const entries = parseConfigList([
    "Warning: C:\\ws\\.pf\\config.json 里的 'spawner' 不是可配的键，已跳过（可配的：issue_repair, max_agents）",
    '',
    'max_agents    = 2（项目 .pf/config.json）',
    'test_tier     = （项目 .pf/config.json）',
  ].join('\n'))

  assert.deepEqual(Object.keys(entries), ['max_agents'])
})

test('读一趟：跑的就是 config list，跑在这个工作区的根上', async () => {
  const subprocess = fakeSubprocess({ stdout: LISTED })
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const reading = await gateway.readConfig('s1', '')

  assert.equal(reading.ok, true)
  assert.equal(reading.project, 'C:\\workspace')
  assert.equal(reading.entries['max_agents']?.value, '1')
  assert.equal(reading.entries['issue_repair']?.layer, 'default')
  assert.deepEqual(wordsOf(subprocess.specs[0]), ['config', 'list'])
  assert.equal(subprocess.specs[0].cwd, 'C:\\workspace')
})

test('读那一趟没成：如实说它没成，一行都不编', async () => {
  const subprocess = fakeSubprocess({ exitCode: 1, stderr: 'pf: python not found on PATH' })
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const reading = await gateway.readConfig('s1', '')

  assert.equal(reading.ok, false)
  assert.match(reading.text, /python not found/u)
  assert.deepEqual(reading.entries, {})
})

test('写一条：pf config set <键> <值>，落的是项目那一层（不带 --global）', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.setConfig('s1', '', 'worktree_mode', 'reuse')

  assert.equal(outcome.ok, true)
  assert.deepEqual(wordsOf(subprocess.specs[0]), ['config', 'set', 'worktree_mode', 'reuse'])
  assert.equal(subprocess.specs[0].cwd, 'C:\\workspace')
})

test('无法识别的键：不递命令，直接拒', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.setConfig('s1', '', 'spawner', 'dsh')

  assert.equal(outcome.ok, false)
  assert.deepEqual(subprocess.specs, [])
  assert.match(outcome.text, /无法识别的设置键/u)
})

test('值合不合法由工具判：面板这一手照递，回来的是它那一句话', async () => {
  const subprocess = fakeSubprocess({ exitCode: 1, stderr: "Error: max_agents 要一个正整数，读到的是 '0'" })
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.setConfig('s1', '', 'max_agents', '0')

  assert.equal(outcome.ok, false)
  assert.match(outcome.text, /要一个正整数/u)
  assert.deepEqual(wordsOf(subprocess.specs[0]), ['config', 'set', 'max_agents', '0'])
})