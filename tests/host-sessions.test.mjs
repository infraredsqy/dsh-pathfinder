/* 宿主半身搬会话笔记那一手：锁的是「那一层目录原样搬回去」。
 *
 * 哪份算笔记、它属于哪一格、一格开过好几条时该看哪条——那些是读数判断，不在这层（模型层
 * 另有单测）。这一层要认的几件事：每份文件都原样搬回（不筛后缀、不剥文件名）、搬不动的那
 * 一份跳过、那层目录不在时交回空的一份。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readSessionNotes } from '../src/host/sessions.ts'

function fakePort(files, { absent = false, phantom = [] } = {}) {
  const missing = () => {
    const error = new Error('no entry here')
    error.code = 'workspace-file/not-found'
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
          /* 列得到、读不出来的那一份：搬的时候才现形。 */
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
  assert.equal(reading.project, 'C:\\ws')
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
