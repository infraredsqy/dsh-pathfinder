/**
 * Durations and clock times: turn the readings' moments and seconds into one
 * line of text.
 *
 * The same value is spelled the same way everywhere; when the moment is
 * absent, an "absent" shape is given (`--` / empty / no record) rather than a
 * `0` that reads as "exactly zero". Everything is based on the moment the
 * caller provides; this module never takes the current time itself.
 */
import { secondsBetween } from './fields.ts'

export function two(n: number): string {
  return (n < 10 ? '0' : '') + String(n)
}

/**
 * Clock time: `HH:MM`.
 */
export function clock(moment: Date | null): string {
  return moment ? `${two(moment.getHours())}:${two(moment.getMinutes())}` : '--'
}

/**
 * The day's label: today / yesterday / the day before / a month-and-day date.
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

/** Bucketing for folding seconds: under a minute goes to the seconds bucket, a whole minute but under an hour to the minutes bucket, beyond that to the hours bucket; no duration (or the moment not yet reached) gets no bucket. */
function splitSeconds(seconds: number | null): { readonly unit: 'seconds' | 'minutes' | 'hours'; readonly value: number; readonly rest: number } | null {
  if (seconds === null || seconds < 0) return null
  if (seconds < 60) return { unit: 'seconds', value: seconds, rest: 0 }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return { unit: 'minutes', value: minutes, rest: 0 }
  return { unit: 'hours', value: Math.floor(minutes / 60), rest: minutes % 60 }
}

/**
 * Compact spelling of a duration: `41s` / `24m` / `2h14` / `3h`.
 */
export function duration(seconds: number | null): string {
  const parts = splitSeconds(seconds)
  if (parts === null) return '--'
  if (parts.unit === 'seconds') return `${parts.value}s`
  if (parts.unit === 'minutes') return `${parts.value}m`
  return parts.rest > 0 ? `${parts.value}h${two(parts.rest)}` : `${parts.value}h`
}

/**
 * Long spelling of a duration, in seconds / minutes / hours and minutes.
 */
export function durationLong(seconds: number | null): string {
  const parts = splitSeconds(seconds)
  if (parts === null) return '没有记录'
  if (parts.unit === 'seconds') return `${parts.value} 秒`
  if (parts.unit === 'minutes') return `${parts.value} 分钟`
  return parts.rest > 0 ? `${parts.value} 小时 ${parts.rest} 分` : `${parts.value} 小时`
}

/**
 * How long from that moment to `at`, compact spelling.
 */
export function elapsedSince(moment: Date | null, at: Date): string {
  return moment === null ? '--' : duration(secondsBetween(moment, at))
}

/**
 * Relative to this moment: just now / N minutes / N hours / N days ago.
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