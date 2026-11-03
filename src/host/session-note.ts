/**
 * The session-note writer: the note saying which session a node's work runs
 * in is written by the side that opened the session — this host half, when it
 * opens one natively (see `executor.ts`).
 *
 * The note lives in the record store's own directory layer, one small file per
 * node named by the node id, in the shape the engine's reader expects (`v` is
 * the one version it reads; the two lists carry the entries). This side adds
 * one `run` entry per open and keeps whatever is already written: the note is
 * an appendix, not a rewrite. The reading of notes is elsewhere
 * (`sessions.ts`); nothing here judges which session a node should show.
 */
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RECORD_SESSIONS } from './contract.ts'

/** The entry this side adds: which session, opened by which host, when. The record's closed set reads a missing host as `dsh` anyway; writing it keeps the note self-describing. */
export interface SessionNoteEntry {
  readonly session: string
  readonly host: 'dsh'
  readonly at: string
}

/**
 * The note file of one node, under the workspace root: the record store's
 * note layer, one file per node, named by the node id.
 */
export function notePathOf(root: string, node: string): string {
  return join(root, RECORD_SESSIONS, `${node}.json`)
}

/** An empty note: the shape a missing or unreadable file counts as. */
function emptyNote(): { v: 1; discussion: unknown[]; run: unknown[] } {
  return { v: 1, discussion: [], run: [] }
}

/**
 * Read one node's note as it is on disk, tolerantly: a missing file, bad
 * bytes, bad JSON, a shape nothing can read, or a version the record tree
 * does not carry all count as "never written" — a note is local
 * corroboration, and it is never a reason for an open to die. Recognized
 * entries carry over verbatim (field for field, including the host word
 * another opener wrote); only what cannot be read at all is dropped.
 */
async function readNote(path: string): Promise<{ v: 1; discussion: unknown[]; run: unknown[] }> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return emptyNote()
  }
  let held: unknown
  try {
    held = JSON.parse(text)
  } catch {
    return emptyNote()
  }
  if (held === null || typeof held !== 'object' || Array.isArray(held)) return emptyNote()
  const record = held as Record<string, unknown>
  if (record.v !== 1) return emptyNote()
  const note = emptyNote()
  for (const role of ['discussion', 'run'] as const) {
    const entries = record[role]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const session = (entry as Record<string, unknown>).session
      if (typeof session !== 'string' || session.length === 0) continue
      note[role].push(entry)
    }
  }
  return note
}

let tempSequence = 0

/** The temporary file name for one landing: same directory, exclusive by construction. */
function tempName(target: string): string {
  tempSequence += 1
  const entropy = `${Date.now().toString(36)}-${tempSequence}-${Math.random().toString(36).slice(2, 10)}`
  return `.${target}.${entropy}.tmp`
}

/** This step failed because another process is holding the target right now (a brief standoff on Windows). */
function isBusyPath(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) return false
  const code = (error as { code?: unknown }).code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

/** Back off between the attempts of one standoff-bound step; it continues by itself when the time is up. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms)
  })
}

/** Total attempts of one standoff-bound step (the first included). */
const BUSY_ATTEMPTS = 4

/**
 * Land bytes onto `path` as a whole: readers see only the old file or the new
 * one. The temporary file shares the target's directory, is created
 * exclusively and renamed into place after fsync; a rename meeting a reader
 * (a brief Windows standoff) backs off and retries before giving up.
 */
async function atomicWriteBytes(path: string, bytes: Uint8Array): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, tempName(path.split(/[\\/]/).pop() ?? 'note'))
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let landed = false
  try {
    handle = await open(tmp, 'wx')
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(tmp, path)
        landed = true
        break
      } catch (error) {
        if (!isBusyPath(error) || attempt >= BUSY_ATTEMPTS) throw error
        await sleep(50 * attempt)
      }
    }
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        /* A handle that will not close goes away with the process. */
      }
    }
    if (!landed) {
      try {
        await unlink(tmp)
      } catch {
        /* A leftover temporary file that will not clear is not the landing's verdict; the error already handed out is the thing to read. */
      }
    }
  }
}

/**
 * Append one `run` entry naming the session just opened for this node, and
 * land the note back as a whole. Whatever the note already said (entries in
 * either list) carries over verbatim; only the new entry is added.
 */
export async function noteOpenedSession(root: string, node: string, session: string): Promise<void> {
  const path = notePathOf(root, node)
  const note = await readNote(path)
  note.run.push({ session, host: 'dsh', at: `${new Date().toISOString().slice(0, 19)}Z` })
  const tail = '\n'
  await atomicWriteBytes(path, new TextEncoder().encode(`${JSON.stringify(note, null, 2)}${tail}`))
}
