/**
 * 时长与钟点：把读数上的时刻与秒数写成一行字。
 *
 * 这两样跟别的读数一样，取值也来自记录：同一个时长在哪儿都按同一种写法。没有那一刻的
 * 时候给的是「没有」的样子（`--` / 空 / 没有记录），这里不留一个 `0` 让人误读成「刚好是零」。
 *
 * 一切以调用方给的那一刻为准，这里自己不取当前时间：同一份输入，同一份输出。
 *
 * @module dsh-pathfinder/model/format
 */

/** 一位数前面补一个 0。 */
export function two(n: number): string {
  return (n < 10 ? '0' : '') + String(n)
}

/**
 * 钟点：`HH:MM`。
 * @param moment - 那一刻；没有就给 `--`（不编一个钟点）。
 */
export function clock(moment: Date | null): string {
  return moment ? `${two(moment.getHours())}:${two(moment.getMinutes())}` : '--'
}

/**
 * 日子的叫法：今天 / 昨天 / 前天 / `N月N日`。
 * @param moment - 那一刻；没有就是空。
 * @param at - 读到哪一刻：今天昨天前天的参照是它那一天。
 */
export function dayLabel(moment: Date | null, at: Date): string {
  if (!moment) return ''
  const today = new Date(at.getFullYear(), at.getMonth(), at.getDate())
  const then = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate())
  const diff = Math.round((today.getTime() - then.getTime()) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff === 2) return '前天'
  return `${moment.getMonth() + 1}月${moment.getDate()}日`
}

/**
 * 时长的紧凑写法：`41s` / `24m` / `2h14` / `3h`。
 * @param seconds - 多少秒；没有就是 `--`，是负数（那一刻还没到）也给 `--`。
 */
export function duration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return '--'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h${two(rest)}` : `${hours}h`
}

/**
 * 时长的长写法：`3 秒` / `5 分钟` / `2 小时 14 分`。
 * @param seconds - 多少秒；没有就是「没有记录」，是负数也给「没有记录」。
 */
export function durationLong(seconds: number | null): string {
  if (seconds === null || seconds < 0) return '没有记录'
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!rest) return `${hours} 小时`
  return `${hours} 小时 ${rest} 分`
}

/**
 * 从那一刻到 `at` 过了多久，紧凑写法。
 * @param moment - 那一刻；没有就是 `--`。
 * @param at - 读到哪一刻。
 */
export function elapsedSince(moment: Date | null, at: Date): string {
  return moment === null ? '--' : duration(Math.round((at.getTime() - moment.getTime()) / 1000))
}

/**
 * 相对这一刻的说法：刚刚 / `N 分钟前` / `N 小时前` / `N 天前`。
 * @param moment - 那一刻；没有就是空。
 * @param at - 读到哪一刻。
 */
export function ago(moment: Date | null, at: Date): string {
  if (!moment) return ''
  const minutes = Math.round((at.getTime() - moment.getTime()) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}