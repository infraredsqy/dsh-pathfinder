/**
 * Why a pathfinder operation was refused, as a code rather than a sentence.
 *
 * The host half cannot know which language the reader is looking at: the panel's language is a
 * browser-side fact, decided in the browser and stored in the Host's settings document, and a host
 * method is called per request without one. So a refusal crosses the boundary as a code, and the
 * panel spells the sentence (`src/client/words.ts`).
 *
 * `detail` carries what no dictionary on this side owns: the offending argument, a resolved path,
 * or another program's own output. A refusal whose words come from a program we do not own says so
 * by carrying them here rather than inventing a translation for them.
 */

/** Every reason this half can refuse an operation. */
export type PfRefusalCode =
  /** An argument failed the character gate that keeps values out of cmd's interpretation. */
  | 'arg-not-allowed'
  /** The host exposes no subprocess gateway, so no command can run. */
  | 'no-subprocess'
  /** The `pf` command does not resolve on this machine. */
  | 'pf-missing'
  /** `pf` resolves to a path cmd cannot be handed. */
  | 'pf-path-unsafe'
  /** Neither interpreter that can carry a verbatim sentence exists. */
  | 'no-interpreter'
  /** The tool ran and exited non-zero; `detail` is its own output. */
  | 'tool-refused'
  /** Spawning or collecting the command failed outright. */
  | 'spawn-failed'
  /** An instruction scope outside the three the tool spells. */
  | 'scope-unknown'
  /** An empty verbatim sentence: nothing to record. */
  | 'empty-text'

/** A refusal: which one, plus the untranslatable detail that goes with it. */
export interface PfRefusal {
  readonly code: PfRefusalCode
  readonly detail?: string
}

/**
 * What a command-running operation returns.
 *
 * On success `text` is the tool's own output, carried out verbatim: those are the tool's words, not
 * this plugin's, and the config reader parses exactly this stream. On failure the reason is a code,
 * with the tool's own words — when it said any — in `detail`.
 */
export type PfOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: PfRefusalCode; readonly detail?: string }

/** The failure branch of an outcome, named so a launcher can return it before an outcome exists. */
export type PfFailure = Extract<PfOutcome, { readonly ok: false }>