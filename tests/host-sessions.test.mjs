/* The host-half hand that carries session notes back: locks in "that directory comes back verbatim".
 *
 * Which file counts as a note, which cell it belongs to, which session to look at when a cell
 * opened several — those are reading-level judgments, not this layer's (the model layer has its
 * own unit tests). What this layer must honor: every file comes back verbatim (no extension
 * filtering, no name stripping), an unreadable one is skipped, and a missing directory yields an
 * empty set.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { absentError, fakeWorkspaceFiles } from './helpers/workspace-files-port.mjs'
import { readSessionNotes } from '../src/host/sessions.ts'

/** This file's own cases on top of the shared stand-in: the whole layer absent from the workspace,
 * and files listed but unreadable (plus a directory entry nothing should try to carry over). */
function fakePort(files, { absent = false, phantom = [] } = {}) {
  const port = fakeWorkspaceFiles(files)
  return {
    async list(scope, path) {
      if (absent) throw absentError(path)
      const listing = await port.list(scope, path)
      return {
        ...listing,
        entries: [
          ...listing.entries,
          ...phantom.map((name) => ({ name, type: 'file' })),
          { name: 'notes', type: 'directory' },
        ],
      }
    },
    read: port.read,
  }
}

const scope = { sessionId: 's1', workspaceRoot: 'C:\\ws' }
const signal = new AbortController().signal

test('一层目录原样搬回去：每份文件都在，名字照旧、内容照旧', async () => {
  const note = JSON.stringify({ node: 'n-1', v: 1, run: [{ session: 'session-7', at: '2026-10-18T00:00:00Z' }] })
  const port = fakePort({
    '.pf/meta/sessions/n-1.json': note,
    '.pf/meta/sessions/顺手记的一笔.txt': '不是 JSON 也照搬',
  })
  const reading = await readSessionNotes(port, scope, signal)

  assert.equal(reading.state, 'read')
  assert.equal(reading.recordPath, '.pf/meta/sessions')
  assert.equal(reading.workspaceRoot, 'C:\\ws')
  assert.deepEqual(reading.notes, { 'n-1.json': note, '顺手记的一笔.txt': '不是 JSON 也照搬' })
})

test('搬不动的那一份跳过，别的照搬；目录那一项不去搬', async () => {
  const port = fakePort({
    '.pf/meta/sessions/n-1.json': '{"run": []}',
  }, { phantom: ['ghost.json'] })
  const reading = await readSessionNotes(port, scope, signal)

  assert.equal(reading.state, 'read')
  assert.deepEqual(reading.notes, { 'n-1.json': '{"run": []}' })
})

test('这一层目录不在（换台机器、新克隆一份记录）：交回空的一份', async () => {
  const port = fakePort({}, { absent: true })
  const reading = await readSessionNotes(port, scope, signal)

  assert.equal(reading.state, 'missing')
  assert.deepEqual(reading.notes, {})
})
