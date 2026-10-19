/**
 * 时长与钟点：把读数上的时刻与秒数写成一行字。
 *
 * 同样的取值在哪儿都按同一种写法；没有那一刻的时候给「没有」的样子（`--` / 空 / 没有记录），
 * 不留一个 `0` 让人误读成「刚好是零」。一切以调用方给的那一刻为准，这里自己不取当前时间。
 */
import { secondsBetween } from './fields.ts'

export function two(n: number): string {
  return (n < 10 ? '0' : '') + String(n)
}

/**
 * 钟点：`HH:MM`。
 */
export function clock(moment: Date | null): string {
  return moment ? `${two(moment.getHours())}:${two(moment.getMinutes())}` : '--'
}

/**
 * 日子的叫法：今天 / 昨天 / 前天 / `N月N日`。
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

/** 折秒的分段：不足一分钟的归秒档，折出分、不足一小时的归分档，再往上归时档；没有时长（或那一刻还没到）不分段。 */
function splitSeconds(seconds: number | null): { readonly unit: 'seconds' | 'minutes' | 'hours'; readonly value: number; readonly rest: number } | null {
  if (seconds === null || seconds < 0) return null
  if (seconds < 60) return { unit: 'seconds', value: seconds, rest: 0 }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return { unit: 'minutes', value: minutes, rest: 0 }
  return { unit: 'hours', value: Math.floor(minutes / 60), rest: minutes % 60 }
}

/**
 * 时长的紧凑写法：`41s` / `24m` / `2h14` / `3h`。
 */
export function duration(seconds: number | null): string {
  const parts = splitSeconds(seconds)
  if (parts === null) return '--'
  if (parts.unit === 'seconds') return `${parts.value}s`
  if (parts.unit === 'minutes') return `${parts.value}m`
  return parts.rest > 0 ? `${parts.value}h${two(parts.rest)}` : `${parts.value}h`
}

/**
 * 时长的长写法：`3 秒` / `5 分钟` / `2 小时 14 分`。
 */
export function durationLong(seconds: number | null): string {
  const parts = splitSeconds(seconds)
  if (parts === null) return '没有记录'
  if (parts.unit === 'seconds') return `${parts.value} 秒`
  if (parts.unit === 'minutes') return `${parts.value} 分钟`
  return parts.rest > 0 ? `${parts.value} 小时 ${parts.rest} 分` : `${parts.value} 小时`
}

/**
 * 从那一刻到 `at` 过了多久，紧凑写法。
 */
export function elapsedSince(moment: Date | null, at: Date): string {
  return moment === null ? '--' : duration(secondsBetween(moment, at))
}

/**
 * 相对这一刻的说法：刚刚 / `N 分钟前` / `N 小时前` / `N 天前`。
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