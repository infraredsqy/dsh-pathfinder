/**
 * The records' fields: read out verbatim, then cut by "read up to which
 * moment".
 *
 * Moments are the records' verbatim text; not one is converted or rewritten
 * here. Unreadable (unwritten, or not a moment) means no such moment: `null`
 * is given, no 0 left behind, no default filled in.
 */

/** Given when that record field really holds a string; every other spelling counts as unwritten. */
export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function toMoment(raw: unknown): Date | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? null : new Date(ms)
}

export function happenedAt(moment: Date | null, at: Date): boolean {
  return moment !== null && moment.getTime() <= at.getTime()
}

/**
 * Cut by that moment: arrived means the moment itself; not yet arrived counts
 * as no such moment.
 *
 * The same field in the record may speak of something that had not yet
 * happened by the moment being read; the reading must not then contain a
 * moment that had not happened.
 */
export function cutAt(moment: Date | null, at: Date): Date | null {
  return happenedAt(moment, at) ? moment : null
}

/**
 * Whether that word was written down by the moment: for fields that carry a
 * last-modified moment.
 *
 * The record's own word was written by the record itself; only its own
 * last-modified moment can say when. With that moment unrecorded, the word
 * counts as long since written — a missing field must not discard what the
 * record itself said.
 */
export function writtenBy(moment: Date | null, at: Date): boolean {
  return moment === null || moment.getTime() <= at.getTime()
}

export function secondsBetween(from: Date | null, to: Date | null): number | null {
  if (from === null || to === null) return null
  return Math.round((to.getTime() - from.getTime()) / 1000)
}

/**
 * A field emitted only for a written string: unwritten (`undefined` or `null`)
 * means the field is absent, never an empty string standing in.
 */
export function field<K extends string>(key: K, value: string | null | undefined): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {}
  if (value !== undefined && value !== null) out[key] = value
  return out
}