/**
 * The host half's session-note fetch: which sessions each node in this
 * workspace has opened, in the directory layer where the notes live.
 *
 * Session identity belongs to this machine, so it lives inside the record
 * store's own directory layer, as small per-node note files. Fetching goes
 * through the same gateway as the four records, read-only; this only moves
 * each file back verbatim — which files count as notes, which node they
 * belong to, and which to show are reading judgments, the model layer's pure
 * functions. When the directory layer cannot be fetched, an empty reading is
 * returned as usual.
 */
import { RECORD_SESSIONS } from './contract.ts'
import { isAbsent, readWholeFile, type PathfinderScope, type WorkspaceFilesPort } from './records.ts'

/** What the panel gets when it fetches session notes. */
export interface PathfinderSessionsReading {
  /** The absolute workspace root read this time, same name as the four-records reading. */
  readonly workspaceRoot: string
  /** The directory layer where the notes live, workspace-relative. */
  readonly recordPath: string
  /**
   * The outcome for this layer of notes: `read` means fetched, `missing`
   * means this workspace never had the layer at all; both draw as "no
   * sessions".
   */
  readonly state: 'read' | 'missing'
  /** Each file in the layer, verbatim: keyed by file name, valued by the file's text; which count as notes is decided by the reading. */
  readonly notes: Readonly<Record<string, string>>
}

/**
 * Bring back one workspace's layer of session notes, verbatim.
 *
 * When one file cannot be fetched (page refused, listed but unreadable), skip
 * that file: whether a node has sessions is judged by the reading against the
 * fetched portion, and the rest are moved as usual.
 */
export async function readSessionNotes(
  port: WorkspaceFilesPort,
  scope: PathfinderScope,
  signal: AbortSignal,
): Promise<PathfinderSessionsReading> {
  const reading = { workspaceRoot: scope.workspaceRoot, recordPath: RECORD_SESSIONS }
  let entries: readonly { readonly name: string; readonly type: string }[]
  try {
    entries = (await port.list(scope, RECORD_SESSIONS, signal)).entries
  } catch (error) {
    if (!isAbsent(error)) throw error
    return { ...reading, state: 'missing', notes: {} }
  }
  const notes: Record<string, string> = {}
  for (const entry of entries) {
    if (entry.type !== 'file') continue
    try {
      notes[entry.name] = await readWholeFile(port, scope, `${RECORD_SESSIONS}/${entry.name}`, signal)
    } catch {
      /* This file could not be fetched: one fewer note moved, and the reading side treats it as absent. */
    }
  }
  return { ...reading, state: 'read', notes }
}
