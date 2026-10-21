/* Layout table for the config section: locks in how rows grow out of readings, how known keys are
 * described, and where that column can be dragged to.
 *
 * The tool is the single source of truth for config keys; this side never declares "which keys the
 * tool has": rows grow out of `pf config list` readings, registered keys render per the table, and
 * unregistered ones fall back to raw key name + text input. No UI snapshots are locked; instead a
 * few things that could silently drift are: a key present in the reading losing its row, a
 * dropdown settling on its first option when the reading has no value, and out-of-table candidate
 * values being silently snapped back to the first option.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clampConfigWidth,
  CONFIG_WIDTH,
  CONFIG_WIDTH_MAX,
  CONFIG_WIDTH_MIN,
  configRowsOf,
  KNOWN_CONFIG_ROWS,
  LAYER_WORDS,
  pickState,
  rowWords,
} from '../src/client/config-rows.ts'
import { createLocalePort } from '../src/client/locale.ts'

/** The zh translator the panel itself stands on before any language service attaches: the words a reader actually sees. */
const t = createLocalePort().getSnapshot().t

/** A synthetic reading: key names are arbitrary — the rendering only cares "one row per printed key". */
function entry(value, layer = 'project') {
  return { value, layer }
}

test('已知的四个键都有说法：中文名、那一句话、控件形态一件不缺', () => {
  assert.deepEqual([...Object.keys(KNOWN_CONFIG_ROWS)].sort(), ['issue_repair', 'max_agents', 'test_tier', 'worktree_mode'])
  for (const row of Object.values(KNOWN_CONFIG_ROWS)) {
    const words = rowWords(t, row)
    assert.ok(words.name.length > 0 && words.caption.length > 0, `${row.key} 缺名字或缺那一句话`)
  }
})

test('行从读数长出来：读数里有的键才有行；已知的照表序摆，不跟着工具印的次序晃', () => {
  /* The reading is deliberately given in the tool's print order: the rendered order is still the table's (mock) order. */
  const rows = configRowsOf({
    max_agents: entry('1'),
    test_tier: entry('full'),
    worktree_mode: entry('off'),
    issue_repair: entry('on', 'default'),
  })

  assert.deepEqual(rows.map((row) => row.key), ['worktree_mode', 'test_tier', 'max_agents', 'issue_repair'])
  /* If the tool ever stops printing a key, its row disappears with it — nothing is drawn for what doesn't exist; this repo does not backfill rows. */
  assert.deepEqual(configRowsOf({ max_agents: entry('1') }).map((row) => row.key), ['max_agents'])
})

test('没登记的键：照键名直显 + 文本框，跟在已知的行后面，一行都不丢', () => {
  const rows = configRowsOf({
    max_agents: entry('1'),
    spawner: entry('dsh'),
    test_tier: entry('full'),
    worktree_mode: entry('off'),
    issue_repair: entry('on', 'default'),
  })

  assert.deepEqual(rows.map((row) => row.key), ['worktree_mode', 'test_tier', 'max_agents', 'issue_repair', 'spawner'])
  const stranger = rows[4]
  assert.equal(stranger.name, null, '没登记的键没有可翻的名字，表里留空')
  assert.equal(rowWords(t, stranger).name, 'spawner', '没登记的键照键名直显，不编名字')
  assert.equal(stranger.kind, 'text', '没登记的键给文本框，不猜控件形态')
  assert.equal(stranger.options, undefined)
  assert.ok(rowWords(t, stranger).caption.length > 0, '没登记的键也有一句话说值由谁判')
})

test('登记过的键照表描：读数里的键落在表里就用表里那一行', () => {
  const rows = configRowsOf({ worktree_mode: entry('fork') })

  assert.deepEqual(rows[0], KNOWN_CONFIG_ROWS['worktree_mode'])
})

test('一行一个控件：下拉那一档带候选值，另外三档不带', () => {
  for (const row of Object.values(KNOWN_CONFIG_ROWS)) {
    if (row.kind === 'pick') {
      assert.ok((row.options ?? []).length > 1, `${row.key} 是下拉，候选值却没摆出来`)
      assert.equal(new Set(row.options).size, row.options?.length, `${row.key} 的候选值里有重样的`)
    } else {
      assert.equal(row.options, undefined, `${row.key} 不是下拉，却带着候选值`)
    }
  }
})

test('下拉的候选值抄本就是工具在 config --help 里说的那几个词', () => {
  assert.deepEqual(KNOWN_CONFIG_ROWS['worktree_mode'].options, ['off', 'fork', 'reuse'])
  assert.deepEqual(KNOWN_CONFIG_ROWS['test_tier'].options, ['full', 'minimal'])
})

test('层签那三个词：默认 / 本项目 / 全局', () => {
  /* 表里存的是字典键：同一份记录在哪种语言下都读得出来。 */
  assert.deepEqual(LAYER_WORDS, {
    default: 'config.layer.default',
    project: 'config.layer.project',
    global: 'common.global',
  })
  assert.deepEqual(
    {
      default: t(LAYER_WORDS.default),
      project: t(LAYER_WORDS.project),
      global: t(LAYER_WORDS.global),
    },
    { default: '默认', project: '本项目', global: '全局' },
    '中文下这三个键印出来仍是那三个词',
  )
})

test('读数里没有这个键的值时，两枚下拉一档都不落（留空），不摆第一档', () => {
  const picks = Object.values(KNOWN_CONFIG_ROWS).filter((row) => row.kind === 'pick')
  assert.deepEqual(picks.map((row) => row.key), ['worktree_mode', 'test_tier'])
  for (const row of picks) {
    const options = row.options ?? []
    assert.deepEqual(pickState(undefined, options), { value: '', extra: null }, `${row.key} 没有值时落了一档`)
    /* Leaving empty is not done by stuffing an empty word into the candidates: the table keeps only the words the tool recognizes. */
    assert.ok(!options.includes(''), `${row.key} 的候选表里被塞了空词`)
  }
})

test('读数里有值：在表里就摆它自己，不在表里就把它自己补成一档，都不去摆第一档', () => {
  for (const row of Object.values(KNOWN_CONFIG_ROWS).filter((one) => one.kind === 'pick')) {
    const options = row.options ?? []
    assert.deepEqual(pickState({ value: options[1], layer: 'project' }, options), { value: options[1], extra: null })
    assert.deepEqual(pickState({ value: 'partial', layer: 'project' }, options), { value: 'partial', extra: 'partial' })
  }
})

test('那一列的宽窄：默认 720，横向收在 480–960，落点是整数', () => {
  assert.equal(CONFIG_WIDTH, 720)
  assert.equal(clampConfigWidth(CONFIG_WIDTH), 720)
  assert.equal(clampConfigWidth(1), CONFIG_WIDTH_MIN)
  assert.equal(clampConfigWidth(100000), CONFIG_WIDTH_MAX)
  assert.equal(clampConfigWidth(720.4), 720)
  assert.equal(clampConfigWidth(719.6), 720)
  assert.ok(CONFIG_WIDTH_MIN < CONFIG_WIDTH && CONFIG_WIDTH < CONFIG_WIDTH_MAX)
})