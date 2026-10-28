/* The browser-half settings pathway: locks in a few invariants.
 *
 * The panel's own preferences come from a settings document (the field table in
 * `src/host/settings-fields.ts`, with the host building the schema from it). This file measures
 * three things: a settings document reads into the panel's values, the write-back op handed to
 * the settings service carries the right revision, and the source's readings before/after the
 * settings service arrives (no change means no subscriber wake-up — `useSyncExternalStore`
 * depends on it; breaking that means the panel re-renders forever).
 *
 * A second set asks `buildConfig` directly: all four fields present in the host schema, each
 * marked volatile, and the factory defaults and bounds matching the field table's numbers. A
 * field missing the volatile mark simply never appears on the settings page, with no error
 * either — so a stand-in that records every call stands in for schemastery to press that
 * question to the end.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildConfig } from '../src/host/config.ts'
import {
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
  LEGACY_PREF_KEYS,
  prefsFromSection,
  prefsWriteOp,
  VIEW_WORDS,
} from '../src/client/prefs.ts'
import { createLocalePort } from '../src/client/locale.ts'
import { fakeSettingsForm } from './helpers/dsh-standins.mjs'

/* The shared settings-document stand-in, with this file's extra face switched on: every case here
 * reads the write log (and notify / bump) the option adds. */
const fakeForm = (initial) => fakeSettingsForm(initial, { writeLog: true })

/* This Node version exposes `localStorage` as a getter that fires an ExperimentalWarning on every
 * touch, and this pathway consults it the moment the settings form attaches. Pad a minimal
 * stand-in over it: this one covers the whole file; a case that wants to measure local storage
 * itself swaps in its own (the two below do exactly that). */
Object.defineProperty(globalThis, 'localStorage', {
  value: { removeItem() {} },
  configurable: true,
  writable: true,
})

test('字段表就是那几个键，出厂默认那几条与浏览器那侧逐项对得上', () => {
  assert.deepEqual(Object.keys(PANEL_PREF_DEFAULTS).sort(), Object.values(PANEL_PREF_FIELDS).sort())
  /* The words printed on the settings page and the panel: one entry per view. The table holds
   * KEYS, so what has to line up is the key set. */
  assert.deepEqual(Object.keys(VIEW_WORDS).sort(), [...VIEW_IDS].sort())

  /* Each entry RESOLVES to a word through the lookup table: every view still has something to
   * print, and it is the lookup table in force that says it. */
  const t = createLocalePort().getSnapshot().t
  for (const entry of Object.values(VIEW_WORDS)) {
    assert.equal(typeof t(entry), 'string', `${entry} 在随包的词典里没有对应的字`)
    assert.notEqual(t(entry), entry, `${entry} 应当查得到一个词，不能把键本身画出来`)
  }

  /* And the five views. */
  assert.equal(t(VIEW_WORDS.map), '地图')
  assert.equal(t(VIEW_WORDS.detail), '明细')
  assert.equal(t(VIEW_WORDS.notes), '指令')
  assert.equal(t(VIEW_WORDS.issue), '问题')
  assert.equal(t(VIEW_WORDS.config), '设置')

  /* What the table holds is the KEY, not the word: the settings row and the tab row both render it
   * through the same translator, so the two cannot drift apart. */
  assert.equal(VIEW_WORDS.map, 'view.map')
  assert.equal(VIEW_WORDS.notes, 'view.notes')
  assert.notEqual(VIEW_WORDS.map, t(VIEW_WORDS.map))
})

test('一份写全的设置文档读成面板那几个值', () => {
  const prefs = prefsFromSection({
    sideWidth: 200,
    defaultTab: 'detail',
    showArchived: true,
    showOtherStates: true,
  })
  assert.deepEqual(prefs, { sideWidth: 200, tab: 'detail', archived: true, otherStates: true })
})

test('那几节读不懂时各自退到出厂那一份，别的照读', () => {
  assert.deepEqual(prefsFromSection(undefined), DEFAULT_PREFS)
  assert.deepEqual(prefsFromSection(null), DEFAULT_PREFS)
  assert.deepEqual(prefsFromSection('不是一份文档'), DEFAULT_PREFS)
  assert.deepEqual(prefsFromSection({}), DEFAULT_PREFS)
  /* Stored records may still hold words written by older versions: unrecognized ones each fall back, the rest read through. */
  assert.deepEqual(
    prefsFromSection({ defaultTab: 'overview', showArchived: 'yes', sideWidth: 'wide' }),
    DEFAULT_PREFS,
  )
  assert.deepEqual(
    prefsFromSection({ defaultTab: 'issue', showArchived: 1, showOtherStates: 0 }),
    { sideWidth: DEFAULT_PREFS.sideWidth, tab: 'issue', archived: false, otherStates: false },
  )
  /* A field this version no longer has (`infoLevel`, the old cards-per-column tier) is dead weight
   * in an old document: it reads as nothing rather than as a bad value. */
  assert.deepEqual(prefsFromSection({ infoLevel: 'lean' }), DEFAULT_PREFS)
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
  assert.deepEqual(prefsWriteOp(PANEL_PREF_FIELDS.defaultTab, 'map'), {
    op: 'set',
    path: ['defaultTab'],
    value: 'map',
  })
  assert.deepEqual(prefsWriteOp(PANEL_PREF_FIELDS.sideWidth, 216), {
    op: 'set',
    path: ['sideWidth'],
    value: 216,
  })
  /* A fresh object per call: callers mutating it must not leak elsewhere. */
  assert.notEqual(prefsWriteOp(PANEL_PREF_FIELDS.showArchived, true), prefsWriteOp(PANEL_PREF_FIELDS.showArchived, true))
})

test('设置服务还没到场：出厂那几条，写回不作数', async () => {
  const source = createPrefsSource()
  assert.deepEqual(source.getSnapshot(), {
    prefs: DEFAULT_PREFS,
    status: 'unavailable',
    revision: undefined,
    writable: false,
    refused: false,
  })
  assert.equal(await source.write(PANEL_PREF_FIELDS.defaultTab, 'detail'), false)
})

test('挂上表单之后读数就是那一节的值，修订号跟着来', () => {
  const form = fakeForm({ sideWidth: 300, defaultTab: 'issue', showArchived: true })
  const source = createPrefsSource()
  source.attach(form)
  const snapshot = source.getSnapshot()
  assert.deepEqual(snapshot.prefs, { sideWidth: 300, tab: 'issue', archived: true, otherStates: false })
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.revision, 1)
  assert.equal(snapshot.writable, true)
})

test('写回带的是读到的那一个修订号，第二次带最新那一个', async () => {
  const form = fakeForm({})
  const source = createPrefsSource()
  source.attach(form)

  assert.equal(await source.write(PANEL_PREF_FIELDS.defaultTab, 'detail'), true)
  assert.deepEqual(form.writes[0], {
    ops: [{ op: 'set', path: ['defaultTab'], value: 'detail' }],
    expected: 1,
  })
  assert.equal(source.getSnapshot().revision, 2)

  assert.equal(await source.write(PANEL_PREF_FIELDS.defaultTab, 'notes'), true)
  assert.deepEqual(form.writes[1], {
    ops: [{ op: 'set', path: ['defaultTab'], value: 'notes' }],
    expected: 2,
  })
  assert.equal(form.document().defaultTab, 'notes')
})

test('同一趟往返里的第二笔：头一笔带着过期修订号被拒，摘掉围栏再走一次就落定', async () => {
  const form = fakeForm({})
  const source = createPrefsSource()
  source.attach(form)
  /* Someone else bumped the document first; this side still holds 1. */
  form.bump()

  assert.equal(await source.write(PANEL_PREF_FIELDS.showArchived, true), true)
  assert.equal(form.writes.length, 2)
  assert.deepEqual(form.writes[0], {
    ops: [{ op: 'set', path: ['showArchived'], value: true }],
    expected: 1,
  })
  /* After the rejection this write carries no fence: the controller picks up the latest revision itself. */
  assert.deepEqual(form.writes[1], {
    ops: [{ op: 'set', path: ['showArchived'], value: true }],
    expected: undefined,
  })
  assert.equal(form.document().showArchived, true)
  assert.equal(source.getSnapshot().refused, false)
  assert.equal(source.getSnapshot().prefs.archived, true)
})

test('两笔都不作数时不静默：读数里摆出「被拒」这一事实，下一笔写成就把它收回', async () => {
  const form = fakeForm({})
  const source = createPrefsSource()
  source.attach(form)
  form.refuse()

  assert.equal(await source.write(PANEL_PREF_FIELDS.showOtherStates, true), false)
  assert.equal(form.writes.length, 2)
  assert.equal(form.writes[1].expected, undefined)
  /* Two attempts, neither accepted: the reading says so. A fact, not a sentence — which words say
   * it is the panel's business, because the language is the reader's. */
  assert.equal(source.getSnapshot().refused, true, '两笔都不作数这件事要摆进读数里，不能静默')
  assert.equal(source.getSnapshot().failure, undefined, '读数里不再摆句子，只摆「被拒」这个事实')

  /* A successful write clears it: the fact is about "the previous write did not land". */
  form.refuse(false)
  assert.equal(await source.write(PANEL_PREF_FIELDS.showOtherStates, true), true)
  assert.equal(source.getSnapshot().refused, false)
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
    const form = fakeForm({ defaultTab: 'detail' })
    const source = createPrefsSource()
    source.attach(form)
    assert.equal(source.getSnapshot().prefs.tab, 'detail')
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

  /* One wake-up with the value untouched: the snapshot is not replaced and no further notification
   * happens — `useSyncExternalStore` compares it across reads; a fresh object per read would make
   * the panel re-render forever. */
  const held = source.getSnapshot()
  const before = rounds
  form.notify()
  assert.equal(source.getSnapshot(), held)
  assert.equal(rounds, before)
})

test('表单换一份、或收回去：读数跟着换，收回去就回到出厂那几条', () => {
  const first = fakeForm({ defaultTab: 'detail' })
  const second = fakeForm({ defaultTab: 'notes', showOtherStates: true })
  const source = createPrefsSource()
  const off = source.attach(first)
  assert.equal(source.getSnapshot().prefs.tab, 'detail')

  source.attach(second)
  assert.equal(source.getSnapshot().prefs.tab, 'notes')
  assert.equal(source.getSnapshot().prefs.otherStates, true)
  first.notify()
  assert.equal(source.getSnapshot().prefs.tab, 'notes')

  off()
  /* `off` means "detach only if it is still my instance"; the second form is the one attached now, so the reading stays. */
  assert.equal(source.getSnapshot().prefs.tab, 'notes')
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

test('宿主那份 schema：四个字段都在，个个标了 volatile', () => {
  const z = fakeSchemastery()
  const schema = buildConfig(z)
  assert.deepEqual(Object.keys(schema.dict), Object.values(PANEL_PREF_FIELDS))
  /* Asked one by one: a field missing the volatile mark never appears on the settings page, and the page raises no error either. */
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

test('prefs 不再带 POLICY_KEYS：那份与宿主逐字重复的策略键清单已撤', async () => {
  const prefs = await import('../src/client/prefs.ts')

  assert.equal(prefs.POLICY_KEYS, undefined, '策略键只留 host/gateway.ts 的 CYCLE_POLICY_KEYS 一份')
})