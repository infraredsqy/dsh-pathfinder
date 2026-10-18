/* 浏览器半身设置那一条通路：锁的是几个不变量。
 *
 * 面板自己的偏好从一份设置文档来（`src/host/settings-fields.ts` 那份字段表、宿主那侧照它建
 * schema），这里量三件事：一份设置文档读成面板那几个值、写回交给设置服务的那条动作带哪一个
 * 修订号、那条口子在设置服务到场前后的读数（值没动就不惊动订阅者——`useSyncExternalStore`
 * 靠它，破了就是面板一直重画）。
 *
 * 另有一份照 `buildConfig` 问的：宿主那份 schema 里五个字段都在、个个标了 volatile、出厂
 * 默认与上下限就是字段表里那几个数。漏标 volatile 的字段在设置页里不出现、页面上也不报错，
 * 所以拿一份记下每次调用的替身顶替 schemastery，把这件事问到底。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildConfig } from '../src/host/config.ts'
import {
  INFO_LEVELS,
  PANEL_PREF_DEFAULTS,
  PANEL_PREF_FIELDS,
  SIDE_DEFAULT,
  SIDE_MAX,
  SIDE_MIN,
  VIEW_IDS,
} from '../src/host/settings-fields.ts'
import {
  clampSide,
  createPrefsSource,
  DEFAULT_PREFS,
  dropLegacyPrefs,
  INFO_LABELS,
  LEGACY_PREF_KEYS,
  prefsFromSection,
  prefsWriteOp,
  VIEW_LABELS,
} from '../src/client/prefs.ts'

/* Node 这一版把 `localStorage` 摆成一个一碰就打一条 ExperimentalWarning 的取值器，而这条
 * 通路在接上设置表单那一刻会去问它一次。垫一份最小的替身顶上：这一份管整个文件，哪条用例
 * 要亲手量本地存储，自己再换一份（下面那两条就是这么做的）。 */
Object.defineProperty(globalThis, 'localStorage', {
  value: { removeItem() {} },
  configurable: true,
  writable: true,
})

test('字段表就是那几个键，出厂默认那几条与浏览器那侧逐项对得上', () => {
  assert.deepEqual(PANEL_PREF_FIELDS, {
    sideWidth: 'sideWidth',
    infoLevel: 'infoLevel',
    defaultTab: 'defaultTab',
    showArchived: 'showArchived',
    showOtherStates: 'showOtherStates',
  })
  assert.deepEqual(Object.keys(PANEL_PREF_DEFAULTS).sort(), Object.values(PANEL_PREF_FIELDS).sort())
  assert.deepEqual([...INFO_LEVELS], ['lean', 'three', 'full'])
  assert.deepEqual([...VIEW_IDS], ['now', 'detail', 'notes', 'wires', 'issue', 'config'])
  /* 印在设置页与面板上的那几个字：六个看法与三档信息量各一份。 */
  assert.deepEqual(Object.keys(INFO_LABELS).sort(), [...INFO_LEVELS].sort())
  assert.deepEqual(Object.keys(VIEW_LABELS).sort(), [...VIEW_IDS].sort())
})

test('一份写全的设置文档读成面板那几个值', () => {
  const prefs = prefsFromSection({
    sideWidth: 200,
    infoLevel: 'full',
    defaultTab: 'wires',
    showArchived: true,
    showOtherStates: true,
  })
  assert.deepEqual(prefs, { sideWidth: 200, info: 'full', tab: 'wires', archived: true, otherStates: true })
})

test('那几节读不懂时各自退到出厂那一份，别的照读', () => {
  assert.deepEqual(prefsFromSection(undefined), DEFAULT_PREFS)
  assert.deepEqual(prefsFromSection(null), DEFAULT_PREFS)
  assert.deepEqual(prefsFromSection('不是一份文档'), DEFAULT_PREFS)
  assert.deepEqual(prefsFromSection({}), DEFAULT_PREFS)
  /* 存量记录里可能留着旧版本写下的词：认不出来的那几个各自退回，旁边的照读。 */
  assert.deepEqual(
    prefsFromSection({ infoLevel: 'verbose', defaultTab: 'overview', showArchived: 'yes', sideWidth: 'wide' }),
    DEFAULT_PREFS,
  )
  assert.deepEqual(
    prefsFromSection({ infoLevel: 'lean', defaultTab: 'issue', showArchived: 1, showOtherStates: 0 }),
    { sideWidth: DEFAULT_PREFS.sideWidth, info: 'lean', tab: 'issue', archived: false, otherStates: false },
  )
})

test('宽度收进上下限：越界的收回来，量不出来的用出厂那一个', () => {
  assert.equal(clampSide(SIDE_MIN - 1), SIDE_MIN)
  assert.equal(clampSide(SIDE_MAX + 1), SIDE_MAX)
  assert.equal(clampSide(SIDE_DEFAULT), SIDE_DEFAULT)
  assert.equal(clampSide(SIDE_DEFAULT + 0.4), SIDE_DEFAULT)
  assert.equal(prefsFromSection({ sideWidth: SIDE_MAX + 500 }).sideWidth, SIDE_MAX)
  assert.equal(prefsFromSection({ sideWidth: SIDE_MIN - 500 }).sideWidth, SIDE_MIN)
  assert.equal(prefsFromSection({ sideWidth: Number.NaN }).sideWidth, SIDE_DEFAULT)
  assert.equal(prefsFromSection({ sideWidth: Number.POSITIVE_INFINITY }).sideWidth, SIDE_DEFAULT)
})

test('写回是一条顶层 set，路径就是字段表里那个字', () => {
  assert.deepEqual(prefsWriteOp(PANEL_PREF_FIELDS.infoLevel, 'lean'), {
    op: 'set',
    path: ['infoLevel'],
    value: 'lean',
  })
  assert.deepEqual(prefsWriteOp(PANEL_PREF_FIELDS.sideWidth, 216), {
    op: 'set',
    path: ['sideWidth'],
    value: 216,
  })
  /* 每次调用给一份新的：调用方改它不该动到别处。 */
  assert.notEqual(prefsWriteOp(PANEL_PREF_FIELDS.showArchived, true), prefsWriteOp(PANEL_PREF_FIELDS.showArchived, true))
})

function fakeForm(initial) {
  let value = { ...initial }
  let revision = 1
  let refuse = false
  const listeners = new Set()
  const writes = []
  return {
    writes,
    document: () => value,
    getSnapshot: () => ({ status: 'ready', value, revision, writable: true }),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    mutate(ops, expected) {
      writes.push({ ops, expected })
      if (refuse) return Promise.resolve(false)
      if (expected !== undefined && expected !== revision) return Promise.resolve(false)
      for (const op of ops) if (op.op === 'set') value = { ...value, [op.path[0]]: op.value }
      revision += 1
      for (const listener of [...listeners]) listener()
      return Promise.resolve(true)
    },
    /** 值一个字节没动，只叫醒订阅者：量「没变就不通知」那一条。 */
    notify: () => { for (const listener of [...listeners]) listener() },
    /** 别处把文档换了一版（修订号往前走），这一侧还没读到——同一趟往返里踩到的就是它。 */
    bump: () => { revision += 1 },
    /** 这份文档一律不收改动：量「两笔都不作数时不许静默」那一条。 */
    refuse: (on = true) => { refuse = on },
  }
}

test('设置服务还没到场：出厂那几条，写回不作数', async () => {
  const source = createPrefsSource()
  assert.deepEqual(source.getSnapshot(), {
    prefs: DEFAULT_PREFS,
    status: 'unavailable',
    revision: undefined,
    writable: false,
    failure: null,
  })
  assert.equal(await source.write(PANEL_PREF_FIELDS.infoLevel, 'lean'), false)
})

test('挂上表单之后读数就是那一节的值，修订号跟着来', () => {
  const form = fakeForm({ sideWidth: 300, infoLevel: 'lean', defaultTab: 'issue', showArchived: true })
  const source = createPrefsSource()
  source.attach(form)
  const snapshot = source.getSnapshot()
  assert.deepEqual(snapshot.prefs, { sideWidth: 300, info: 'lean', tab: 'issue', archived: true, otherStates: false })
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.revision, 1)
  assert.equal(snapshot.writable, true)
})

test('写回带的是读到的那一个修订号，第二次带最新那一个', async () => {
  const form = fakeForm({})
  const source = createPrefsSource()
  source.attach(form)

  assert.equal(await source.write(PANEL_PREF_FIELDS.infoLevel, 'lean'), true)
  assert.deepEqual(form.writes[0], {
    ops: [{ op: 'set', path: ['infoLevel'], value: 'lean' }],
    expected: 1,
  })
  assert.equal(source.getSnapshot().revision, 2)

  assert.equal(await source.write(PANEL_PREF_FIELDS.defaultTab, 'notes'), true)
  assert.deepEqual(form.writes[1], {
    ops: [{ op: 'set', path: ['defaultTab'], value: 'notes' }],
    expected: 2,
  })
  assert.equal(form.document().infoLevel, 'lean')
  assert.equal(form.document().defaultTab, 'notes')
})

test('同一趟往返里的第二笔：头一笔带着过期修订号被拒，摘掉围栏再走一次就落定', async () => {
  const form = fakeForm({})
  const source = createPrefsSource()
  source.attach(form)
  /* 别处先把文档换了一版，这一侧手里还是 1。 */
  form.bump()

  assert.equal(await source.write(PANEL_PREF_FIELDS.showArchived, true), true)
  assert.equal(form.writes.length, 2)
  assert.deepEqual(form.writes[0], {
    ops: [{ op: 'set', path: ['showArchived'], value: true }],
    expected: 1,
  })
  /* 被拒之后这一笔不带围栏：控制器自己会取当下最新那一个。 */
  assert.deepEqual(form.writes[1], {
    ops: [{ op: 'set', path: ['showArchived'], value: true }],
    expected: undefined,
  })
  assert.equal(form.document().showArchived, true)
  assert.equal(source.getSnapshot().failure, null)
  assert.equal(source.getSnapshot().prefs.archived, true)
})

test('两笔都不作数时不静默：读数里摆出一句话，下一笔写成就把它收回', async () => {
  const form = fakeForm({})
  const source = createPrefsSource()
  source.attach(form)
  form.refuse()

  assert.equal(await source.write(PANEL_PREF_FIELDS.showOtherStates, true), false)
  assert.equal(form.writes.length, 2)
  assert.equal(form.writes[1].expected, undefined)
  const failure = source.getSnapshot().failure
  assert.equal(typeof failure, 'string')
  assert.ok(failure.length > 0)

  /* 写回成功的那一笔把它收回去：那句话说的是「上一笔没落定」。 */
  form.refuse(false)
  assert.equal(await source.write(PANEL_PREF_FIELDS.showOtherStates, true), true)
  assert.equal(source.getSnapshot().failure, null)
})

test('接上设置表单那一刻扫掉旧版那四个键，别人的键不动', () => {
  const held = new Set([...LEGACY_PREF_KEYS, 'somebody-else.key'])
  const storage = {
    keys: () => [...held],
    removeItem(key) { held.delete(key) },
  }
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
  try {
    assert.equal(LEGACY_PREF_KEYS.length, 4)
    const source = createPrefsSource()
    source.attach(fakeForm({}))
    assert.deepEqual(storage.keys(), ['somebody-else.key'])
  } finally {
    if (had === undefined) delete globalThis.localStorage
    else Object.defineProperty(globalThis, 'localStorage', had)
  }
})

test('本地存储不可用时偏好清理安静算了：那条口子照常挂得上', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    value: { removeItem() { throw new Error('这个环境不让删') } },
    configurable: true,
    writable: true,
  })
  try {
    const form = fakeForm({ infoLevel: 'lean' })
    const source = createPrefsSource()
    source.attach(form)
    assert.equal(source.getSnapshot().prefs.info, 'lean')
    assert.equal(source.getSnapshot().status, 'ready')
    assert.equal(dropLegacyPrefs(), 0)
  } finally {
    if (had === undefined) delete globalThis.localStorage
    else Object.defineProperty(globalThis, 'localStorage', had)
  }
})

test('别处翻了一行：订阅者当场收到新读数', () => {
  const form = fakeForm({})
  const source = createPrefsSource()
  let rounds = 0
  source.attach(form)
  source.subscribe(() => { rounds += 1 })

  form.mutate([prefsWriteOp(PANEL_PREF_FIELDS.showArchived, true)], undefined)
  assert.equal(source.getSnapshot().prefs.archived, true)

  /* 值一个字节没动地叫醒一次：读数不换新对象，也不再通知——`useSyncExternalStore`
   * 拿它比前后两次，每读一次都新造一个的话面板会一直重画。 */
  const held = source.getSnapshot()
  const before = rounds
  form.notify()
  assert.equal(source.getSnapshot(), held)
  assert.equal(rounds, before)
})

test('表单换一份、或收回去：读数跟着换，收回去就回到出厂那几条', () => {
  const first = fakeForm({ infoLevel: 'lean' })
  const second = fakeForm({ infoLevel: 'full', showOtherStates: true })
  const source = createPrefsSource()
  const off = source.attach(first)
  assert.equal(source.getSnapshot().prefs.info, 'lean')

  source.attach(second)
  assert.equal(source.getSnapshot().prefs.info, 'full')
  assert.equal(source.getSnapshot().prefs.otherStates, true)
  first.notify()
  assert.equal(source.getSnapshot().prefs.info, 'full')

  off()
  /* `off` 说的是「还是我那一份就摘掉」；此时站着的已经是第二份，所以读数不动。 */
  assert.equal(source.getSnapshot().prefs.info, 'full')
  source.attach(null)
  assert.deepEqual(source.getSnapshot().prefs, DEFAULT_PREFS)
  assert.equal(source.getSnapshot().status, 'unavailable')
})

function fakeSchemastery() {
  const made = []
  const field = (kind, extra = {}) => {
    const node = {
      kind,
      extra,
      marks: [],
      defaults: [],
      volatile() { this.marks.push('volatile'); return this },
      default(value) { this.defaults.push(value); return this },
      min(value) { this.extra.min = value; return this },
      max(value) { this.extra.max = value; return this },
    }
    made.push(node)
    return node
  }
  return {
    made,
    boolean: () => field('boolean'),
    number: () => field('number'),
    union: (values) => field('union', { values: [...values] }),
    object: (dict) => ({ kind: 'object', dict }),
  }
}

test('宿主那份 schema：五个字段都在，个个标了 volatile', () => {
  const z = fakeSchemastery()
  const schema = buildConfig(z)
  assert.deepEqual(Object.keys(schema.dict), Object.values(PANEL_PREF_FIELDS))
  /* 一个一个问过去：漏标 volatile 的字段在设置页里不出现，页面上也不报错。 */
  for (const [name, node] of Object.entries(schema.dict)) {
    assert.ok(node.marks.includes('volatile'), `${name} 那一个字段漏标了 volatile`)
  }
})

test('宿主那份 schema：字段的种类、出厂默认与上下限就是字段表里那几个数', () => {
  const z = fakeSchemastery()
  const dict = buildConfig(z).dict
  const read = (name) => {
    const node = dict[name]
    return { kind: node.kind, defaults: node.defaults, extra: node.extra }
  }

  assert.deepEqual(read(PANEL_PREF_FIELDS.sideWidth), {
    kind: 'number',
    defaults: [PANEL_PREF_DEFAULTS.sideWidth],
    extra: { min: SIDE_MIN, max: SIDE_MAX },
  })
  assert.deepEqual(read(PANEL_PREF_FIELDS.infoLevel), {
    kind: 'union',
    defaults: [PANEL_PREF_DEFAULTS.infoLevel],
    extra: { values: [...INFO_LEVELS] },
  })
  assert.deepEqual(read(PANEL_PREF_FIELDS.defaultTab), {
    kind: 'union',
    defaults: [PANEL_PREF_DEFAULTS.defaultTab],
    extra: { values: [...VIEW_IDS] },
  })
  assert.deepEqual(read(PANEL_PREF_FIELDS.showArchived), {
    kind: 'boolean',
    defaults: [PANEL_PREF_DEFAULTS.showArchived],
    extra: {},
  })
  assert.deepEqual(read(PANEL_PREF_FIELDS.showOtherStates), {
    kind: 'boolean',
    defaults: [PANEL_PREF_DEFAULTS.showOtherStates],
    extra: {},
  })
})

/* 这一条只问「模块 import 得动、名字还在」；断言 `host.Config === undefined` 锁的是本机
   node_modules 那一刻的样子（`package.json` 已把它列进 peerDependencies），下一次 install
   就会判红，所以那一支得让解析确定性地失败才量得准。 */
test('这一行没有设置表单也装得上：模块 import 得动，名字还在', async () => {
  const host = await import('../src/host/index.ts')
  assert.equal(host.name, 'pathfinder-records')
})