/**
 * The raw records: field-for-field copies of the four record files' own
 * fields — no field renamed, no unit converted, no moment folded — plus the
 * result shape the host half hands back from one fetch.
 *
 * This is the model layer's bottom layer: it describes only the records
 * themselves and imports nothing; the host and browser halves both take these
 * shapes from here in turn (on the host side via `src/host/contract.ts`).
 */

/** The outcome of one source's fetch this round. */
export type PathfinderSourceState =
  /** Fetched; the collection holds its content. */
  | 'read'
  /** The workspace has no such piece (not listed in the directory). */
  | 'missing'
  /** Listed but unreadable: not readable JSON text, or an error midway. */
  | 'unusable'

/** A node in the records: fields copied from the record, value types as written by whichever spelling actually appears in the record. */
export interface PathfinderNode {
  readonly title?: string
  readonly description?: string
  readonly tags?: readonly string[]
  /** The mode this node runs in, e.g. `auto`／`manual`／`checkpoint`. */
  readonly mode?: string
  /** The node's current verdict: `completed`／`shelved`／`todo`. */
  readonly status?: string
  /** The record writes it as text; copied as such. */
  readonly weight?: string
  readonly dsh_session?: string
  /** The list of prerequisite node ids; each one a dependency edge. */
  readonly dependencies?: readonly string[]
  readonly created_at?: string | null
  readonly completed_at?: string | null
  /** The moment a human approved this delivery; it counts only at or after that delivery. */
  readonly approved_at?: string | null
  readonly updated_at?: string | null
  /** Any other fields the record carries come along: no trimming at this step. */
  readonly [field: string]: unknown
}

/** One step walked on a cycle. */
export interface PathfinderStep {
  readonly node?: string
  readonly started_at?: string | null
  readonly ended_at?: string | null
  readonly result?: string | null
  /** Any other fields the record carries come along. */
  readonly [field: string]: unknown
}

/** The entry where a cycle holds a node. */
export interface PathfinderHolding {
  readonly id?: string
  readonly since?: string | null
  /** Any other fields the record carries come along. */
  readonly [field: string]: unknown
}

/** One cycle in the records. */
export interface PathfinderCycle {
  readonly id?: string
  readonly title?: string
  readonly status?: string
  readonly tags?: readonly string[]
  readonly created_at?: string | null
  readonly updated_at?: string | null
  /** The policies this cycle hangs: keys and values as in the record. */
  readonly policies?: Readonly<Record<string, unknown>>
  /** Who is working it: the list-of-holdings spelling. */
  readonly holding?: readonly PathfinderHolding[]
  /** Who is working it: the single-value spelling. */
  readonly current_node?: string | null
  /** The hold moment paired with `current_node`, the record's verbatim text. */
  readonly current_started_at?: string | null
  /** The steps this cycle has walked, in record order. */
  readonly path?: readonly PathfinderStep[]
  /** Any other fields the record carries come along. */
  readonly [field: string]: unknown
}

/** One instruction in the records. */
export interface PathfinderInstruction {
  readonly id?: string
  readonly text?: string
  readonly scope?: string
  /** Which kind of object this instruction lands on. */
  readonly target?: string
  readonly state?: string
  /** Which cycle it binds to; `null` when unbound. */
  readonly cycle?: string | null
  /** Which node it binds to; `null` when unbound. */
  readonly node?: string | null
  /** Which round it takes effect in; `null` when unrecorded. */
  readonly round?: number | null
  /** At which beat it takes effect; `null` when unrecorded. */
  readonly stage?: number | null
  readonly said_by?: string
  readonly at?: string | null
  readonly resolved_at?: string | null
  readonly resolved_by?: string | null
  readonly superseded_by?: string | null
  readonly note?: string | null
  /** Stop after walking so many nodes; only a few entries in the records carry this number. */
  readonly stop_after_nodes?: number | null
  readonly applied_rounds?: readonly unknown[]
  readonly applied?: readonly unknown[]
  /** Any other fields the record carries come along. */
  readonly [field: string]: unknown
}

/** One issue in the pool. */
export interface PathfinderIssue {
  readonly id?: string
  readonly title?: string
  /** The severity tier. */
  readonly severity?: string | null
  readonly status?: string
  readonly module?: string
  /** Who reported it. */
  readonly source?: string | null
  /** The verdict. */
  readonly decision?: string | null
  readonly discovered?: string | null
  readonly updated_at?: string | null
  readonly check_count?: number | null
  readonly files?: readonly string[]
  readonly functions?: readonly string[]
  readonly description?: string | null
  readonly suggestion?: string | null
  readonly reason?: string | null
  readonly plan_path?: string | null
  /** Any other fields the record carries come along. */
  readonly [field: string]: unknown
}

/** The key of each of the four sources in a fetch result, one-to-one with the records' own top-level collections. */
export type RecordSourceKey = 'nodes' | 'cycles' | 'instructions' | 'issues'

/** The result of one fetch. */
export interface PathfinderReading {
  /** Which workspace root this reading was taken from — the caller-named one, or this session's own when none was named. Absolute path. */
  readonly workspaceRoot: string
  /** The directory layer holding the records, workspace-relative. */
  readonly recordPath: string
  /**
   * Each of the four sources' outcome this round, keyed by {@link RecordSourceKey}.
   * Sources that could not be fetched yield empty collections below: the panel draws "absent from the records".
   */
  readonly sources: Readonly<Record<RecordSourceKey, PathfinderSourceState>>
  /** Keys are node ids. */
  readonly nodes: Readonly<Record<string, PathfinderNode>>
  readonly cycles: readonly PathfinderCycle[]
  readonly instructions: readonly PathfinderInstruction[]
  /** Keys are issue ids. */
  readonly issues: Readonly<Record<string, PathfinderIssue>>
}
