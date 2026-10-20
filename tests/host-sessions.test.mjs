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
import { NOT_FOUND } from '../src/host/records.ts'
import { readSessionNotes } from '../src/host/sessions.ts'

function fakePort(files, { absent = false, phantom = [] } = {}) {
  /* The fake port fakes "absent" using the code exported by records.ts: the contract lives in one place repo-wide; if anyone drifts, it snaps here. */
  const missing = () => {
    const error = new Error('no entry here')
    error.code = NOT_FOUND
    return error
  }
  return {
    async list(scope, path) {
      if (absent) throw missing()
      return {
        path,
        entries: [
          ...Object.keys(files)
            .filter((one) => one.startsWith(`${path}/`))
            .map((one) => ({ name: one.slice(path.length + 1), type: 'file' })),
          /* Listed but unreadable: only shows up when carried over. */
          ...phantom.map((name) => ({ name, type: 'file' })),
          { name: 'notes', type: 'directory' },
        ],
        truncated: false,
      }
    },
    async read(scope, path, range) {
      if (!(path in files)) throw missing()
      const lines = files[path].split('\n')
      const offset = range?.offset ?? 1
      const limit = range?.limit ?? 400
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      return { text: slice.join('\n'), lines: slice.length, eof: offset - 1 + slice.length >= lines.length }
    },
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
