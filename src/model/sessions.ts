/**
 * The session notes' reading: which session each node should send the reader
 * to.
 *
 * What comes in is the layer of notes the host half moved back verbatim —
 * file names as-is, contents as-is. Which files count as notes, which node
 * they belong to (the file name itself is the node id), and which one to show
 * when a node has several sessions are all judged here; a file that cannot be
 * parsed skips its node and the rest are read as usual — that node simply has
 * no session to go to on this machine, and the panel draws "none".
 */

/** The file-name suffix of a note: the file name itself is the node id. */
const NOTE_SUFFIX = '.json'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function refsOf(note: Record<string, unknown>, kind: 'discussion' | 'run'): readonly unknown[] {
  const list = note[kind]
  return Array.isArray(list) ? list : []
}

/**
 * The most recently opened session in one note.
 *
 * Each kind compares by its own moment: `at` is the record's own moment text,
 * spelled the same way on both sides, so it compares directly as text. When
 * the moments tie (or neither is written), the run entry beats the discussion
 * entry: of two sessions opened at the same moment, the reader wants the one
 * currently working this node.
 */
export function latestSessionOf(note: unknown): string | undefined {
  const held = asRecord(note)
  if (held === undefined) return undefined
  let best: { readonly session: string; readonly at: string; readonly rank: number } | undefined
  for (const [rank, kind] of [[1, 'run'], [0, 'discussion']] as const) {
    for (const entry of refsOf(held, kind)) {
      const ref = asRecord(entry)
      if (ref === undefined) continue
      const session = ref.session
      if (typeof session !== 'string' || session.length === 0) continue
      const at = typeof ref.at === 'string' ? ref.at : ''
      if (best === undefined || at > best.at || (at === best.at && rank > best.rank)) {
        best = { session, at, rank }
      }
    }
  }
  return best?.session
}

/**
 * Read a layer of notes into a reading: keys are node ids, values the session
 * to show.
 */
export function readSessions(notes: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [name, raw] of Object.entries(notes)) {
    if (!name.endsWith(NOTE_SUFFIX)) continue
    const nodeId = name.slice(0, -NOTE_SUFFIX.length)
    if (nodeId.length === 0) continue
    let held: unknown
    try {
      held = JSON.parse(raw)
    } catch {
      continue
    }
    const session = latestSessionOf(held)
    if (session !== undefined) out[nodeId] = session
  }
  return out
}

/**
 * The stranded dispatch: which line this cell's claim belongs to when the
 * claim is on disk and the session it opened is gone, `null` when it is not.
 *
 * The dispatch writes a claim when a session is really out; the session's
 * identity is this machine's own note. Both on disk and the session absent
 * from the host's live agents — a worker that died mid-round, or a host
 * restarted under the cell — the cell can never settle by itself: nothing is
 * left to end a turn, and the plan holds it in `wait`. That is the reading
 * here; the line id comes back so the reader's sentence can name the two
 * record words the remedy names.
 *
 * Three guards, in order: the cell must still be held by a line (a settled
 * cell keeps its claim and its note forever, and is not stranded); the host
 * must be able to say which sessions are alive (an unknown is never read as
 * gone); and the note must name the session at all (no note, no identity to
 * miss). What the reader is told to do about it is the client's sentence.
 */
export function strandedCycleOf(
  node: { readonly id: string; readonly running: boolean },
  claims: Readonly<Record<string, string>>,
  sessions: Readonly<Record<string, string>>,
  alive: ReadonlySet<string> | null,
): string | null {
  if (!node.running) return null
  if (alive === null) return null
  const claim = claims[node.id]
  if (claim === undefined || claim.length === 0) return null
  const session = sessions[node.id]
  if (session === undefined || session.length === 0) return null
  return alive.has(session) ? null : claim
}
