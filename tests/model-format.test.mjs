/* 格式化那一段：只锁不变量——时长与钟点的写法、没有那一刻的时候给什么。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ago, clock, dayLabel, duration, durationLong, elapsedSince, two } from '../src/model/index.ts'

test('没有那一刻的时候给「没有」的样子，不写 0', () => {
  const at = new Date('2026-03-10T12:00:00.000Z')

  assert.equal(clock(null), '--')
  assert.equal(duration(null), '--')
  assert.equal(durationLong(null), '没有记录')
  assert.equal(elapsedSince(null, at), '--')
  assert.equal(ago(null, at), '')
  assert.equal(dayLabel(null, at), '')
})

test('时长按档位写：秒 / 分钟 / 小时', () => {
  assert.equal(duration(0), '0s', '刚好零秒是一个真读数')
  assert.equal(duration(59), '59s')
  assert.equal(duration(60), '1m')
  assert.equal(duration(3600), '1h')
  assert.equal(duration(3700), '1h02')
  assert.equal(duration(-5), '--', '那一刻还没到：没有时长，也不写一个负的')
})

test('时长的长写法', () => {
  assert.equal(durationLong(45), '45 秒')
  assert.equal(durationLong(300), '5 分钟')
  assert.equal(durationLong(3600), '1 小时')
  assert.equal(durationLong(8040), '2 小时 14 分')
  assert.equal(durationLong(-5), '没有记录')
})

test('钟点走本地的钟点', () => {
  assert.equal(clock(new Date(2026, 2, 10, 9, 5)), '09:05')
  assert.equal(two(7), '07')
  assert.equal(two(31), '31')
})

test('日子按读到的那一刻算', () => {
  const at = new Date(2026, 2, 10, 12, 0)

  assert.equal(dayLabel(new Date(2026, 2, 10, 9, 0), at), '今天')
  assert.equal(dayLabel(new Date(2026, 2, 9, 23, 0), at), '昨天')
  assert.equal(dayLabel(new Date(2026, 2, 8, 23, 0), at), '前天')
  assert.equal(dayLabel(new Date(2026, 2, 1, 0, 0), at), '3月1日')
})

test('过了多久：那一刻在读到的那一刻之后，就没有时长', () => {
  const at = new Date('2026-03-10T12:00:00.000Z')

  assert.equal(elapsedSince(new Date('2026-03-10T11:00:00.000Z'), at), '1h')
  assert.equal(elapsedSince(new Date('2026-03-10T12:30:00.000Z'), at), '--')
})

test('相对这一刻的说法', () => {
  const at = new Date('2026-03-10T12:00:00.000Z')

  assert.equal(ago(new Date('2026-03-10T11:59:50.000Z'), at), '刚刚')
  assert.equal(ago(new Date('2026-03-10T11:30:00.000Z'), at), '30 分钟前')
  assert.equal(ago(new Date('2026-03-10T08:00:00.000Z'), at), '4 小时前')
  assert.equal(ago(new Date('2026-03-09T12:00:00.000Z'), at), '1 天前')
})