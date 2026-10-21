/**
 * How a moment and a span are measured.
 *
 * This module measures; it does not speak. A span's wording differs per language, so what is given
 * here is the *shape* of a duration — which unit it falls in, how many of that unit — and the client
 * says it. The only spellings that stay here are the ones that read the same in every language:
 * digits, the `--` that marks an absent value, and the compact `41s` / `1h02` form the panel prints
 * inline beside a card.
 *
 * When the moment is absent, an "absent" shape is given (`null`, or `--`) rather than a `0` that
 * reads as "exactly zero". Everything is based on the moment the caller provides; this module never
 * takes the current time itself.
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

/** Which unit a span falls in, how many of it, and the whole minutes left over past the hours. */
export interface DurationParts {
  readonly unit: 'seconds' | 'minutes' | 'hours'
  readonly value: number
  /** Whole minutes left once the hours are taken out; `0` in the other two units. */
  readonly rest: number
}

/**
 * The unit a span falls in: under a minute goes to seconds, a whole minute but under an hour to
 * minutes, beyond that to hours. No duration — or a moment not yet reached — has no unit at all.
 */
export function durationParts(seconds: number | null): DurationParts | null {
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
  const parts = durationParts(seconds)
  if (parts === null) return '--'
  if (parts.unit === 'seconds') return `${parts.value}s`
  if (parts.unit === 'minutes') return `${parts.value}m`
  return parts.rest > 0 ? `${parts.value}h${two(parts.rest)}` : `${parts.value}h`
}

/**
 * How long from that moment to `at`, compact spelling.
 */
export function elapsedSince(moment: Date | null, at: Date): string {
  return moment === null ? '--' : duration(secondsBetween(moment, at))
}

/**
 * Which day a moment fell on: today, yesterday, the day before, or a calendar date.
 *
 * One member per arm rather than a shared `'today' | 'yesterday' | 'before-yesterday'` literal: the
 * three relative days carry nothing and the calendar day carries a month and a day, and a
 * discriminant that is itself a union of three does not narrow to the other arm once its members
 * have been excluded — the reader would then be looking for a month on "today".
 */
export type DayParts =
  | { readonly unit: 'today' }
  | { readonly unit: 'yesterday' }
  | { readonly unit: 'before-yesterday' }
  | { readonly unit: 'date'; readonly month: number; readonly day: number }

/** The day that moment fell on, measured against the caller's own moment; `null` when there is none. */
export function dayParts(moment: Date | null, at: Date): DayParts | null {
  if (moment === null) return null
  const today = new Date(at.getFullYear(), at.getMonth(), at.getDate())
  const then = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate())
  const diff = Math.round((today.getTime() - then.getTime()) / 86400000)
  if (diff === 0) return { unit: 'today' }
  if (diff === 1) return { unit: 'yesterday' }
  if (diff === 2) return { unit: 'before-yesterday' }
  return { unit: 'date', month: moment.getMonth() + 1, day: moment.getDate() }
}

/**
 * How long ago a moment was, relative to the caller's own moment: barely at all, or a count of
 * minutes / hours / days. `null` when there is no moment to speak of.
 */
export type AgoParts =
  | { readonly unit: 'just-now' }
  | { readonly unit: 'minutes' | 'hours' | 'days'; readonly value: number }

/** Which arm a moment falls in, measured against `at`. */
export function agoParts(moment: Date | null, at: Date): AgoParts | null {
  if (moment === null) return null
  const minutes = Math.round((at.getTime() - moment.getTime()) / 60000)
  if (minutes < 1) return { unit: 'just-now' }
  if (minutes < 60) return { unit: 'minutes', value: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { unit: 'hours', value: hours }
  return { unit: 'days', value: Math.floor(hours / 24) }
}