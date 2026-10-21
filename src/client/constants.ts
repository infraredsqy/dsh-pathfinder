/**
 * Shared word keys used across the client.
 *
 * Each phrase is named once: the five node-following cells say the same thing, so they share one key
 * and look it up through the same translator — the same discipline as before, with the word itself
 * moved into the dictionary where the reader's language decides it.
 */
import type { WordKey } from './locales/index.ts'

/** Shown in each of the five node-following cells when this workspace has no node record yet. */
export const NOT_ENABLED_WORD: WordKey = 'panel.not-enabled'