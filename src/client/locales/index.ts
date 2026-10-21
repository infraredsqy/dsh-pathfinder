/**
 * The panel's word lookup tables: one entry per language it can speak.
 *
 * {@link WORD_TABLES} is the only list of languages this panel ships, and it is read twice — once
 * to register every table with DSH's locale service, once to resolve a word when that service is
 * absent. Adding a language is therefore adding a file beside `zh.ts` with the same shape and one
 * line here; no component, and no other file, learns that a language appeared.
 *
 * Each table is typed against the key set {@link zh} states, so the completeness check is a
 * compile-time one: a table that is missing a key, or that carries a key nobody else has, does not
 * build. That is the whole reason `zh` holds the keys rather than a separate key list.
 */
import { en } from './en.ts'
import { zh } from './zh.ts'
import type { WordKey } from './zh.ts'

export type { WordKey } from './zh.ts'
export { en, zh }

/** One language's words: every key, in that language. */
export type WordTable = Readonly<Record<WordKey, string>>

/**
 * Every shipped lookup table, keyed by the locale id DSH stores as its preference (`zh`, `en`, and
 * whatever a later language pack adds beside them).
 */
export const WORD_TABLES: Readonly<Record<string, WordTable>> = { zh, en }