/* 设置那一格的版面表：锁的是「面板摆哪四行」「行尾那三个词」「那一列能拖到哪儿」。
 *
 * 这一份不锁界面快照：锁的是几件会静默走偏的事——摆出来的行与写面认得的那四个键对不上
 * （第四行就写不进记录）、层签的词与记录里的说法对不上（读者读不出值住在哪一层）、宽窄的
 * 上下限与蓝本那一档对不上、下拉在读数里没有值时一不留神摆出第一档（读者分不出「记录里没有」
 * 与「记录里就是 off / full」）。控件长什么样、按钮怎么排，一条都不在这儿。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clampConfigWidth,
  CONFIG_ROWS,
  CONFIG_WIDTH,
  CONFIG_WIDTH_MAX,
  CONFIG_WIDTH_MIN,
  LAYER_WORDS,
  pickState,
} from '../src/client/config-rows.ts'
import { CONFIG_KEYS } from '../src/host/project-config.ts'

test('四行摆的就是写面认得的那四个键，不多不少', () => {
  assert.deepEqual([...CONFIG_ROWS.map((row) => row.key)].sort(), [...CONFIG_KEYS].sort())
})

test('一行一个控件：下拉那一档带候选值，另外两档不带', () => {
  for (const row of CONFIG_ROWS) {
    assert.ok(row.name.length > 0 && row.caption.length > 0, `${row.key} 缺名字或缺那一句话`)
    if (row.kind === 'pick') {
      assert.ok((row.options ?? []).length > 1, `${row.key} 是下拉，候选值却没摆出来`)
      assert.equal(new Set(row.options).size, row.options?.length, `${row.key} 的候选值里有重样的`)
    } else {
      assert.equal(row.options, undefined, `${row.key} 不是下拉，却带着候选值`)
    }
  }
})

test('下拉的候选值就是工具认得的那几个词', () => {
  const options = Object.fromEntries(CONFIG_ROWS.filter((row) => row.kind === 'pick').map((row) => [row.key, row.options]))

  assert.deepEqual(options['worktree_mode'], ['off', 'fork', 'reuse'])
  assert.deepEqual(options['test_tier'], ['full', 'minimal'])
})

test('层签那三个词：默认 / 本项目 / 全局', () => {
  assert.deepEqual(LAYER_WORDS, { default: '默认', project: '本项目', global: '全局' })
})

test('读数里没有这个键的值时，两枚下拉一档都不落（留空），不摆第一档', () => {
  const picks = CONFIG_ROWS.filter((row) => row.kind === 'pick')
  assert.deepEqual(picks.map((row) => row.key), ['worktree_mode', 'test_tier'])
  for (const row of picks) {
    const options = row.options ?? []
    assert.deepEqual(pickState(undefined, options), { value: '', extra: null }, `${row.key} 没有值时落了一档`)
    /* 留空不是靠往候选表里塞一枚空词办的：表里还是工具认得的那几个词。 */
    assert.ok(!options.includes(''), `${row.key} 的候选表里被塞了空词`)
  }
})

test('读数里有值：在表里就摆它自己，不在表里就把它自己补成一档，都不去摆第一档', () => {
  for (const row of CONFIG_ROWS.filter((one) => one.kind === 'pick')) {
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