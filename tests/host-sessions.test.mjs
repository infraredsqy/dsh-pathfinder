/* 宿主半身读会话笔记那一手：锁的是「那一层按节点分的小份笔记怎么读成每一格的会话」。
 *
 * 会话身份住在那层按节点分的小份笔记上。这一层要认的几件事：一格开过好几条时取哪一条
 * （最近开过的；同一刻时跑它的那条压过讨论的那条）、解不出来的那一份怎么处置（跳过这一格）、
 * 那一层目录不在时交回什么（一份空清单，这一屏照旧画得出来）。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { latestSessionOf, readSessionNotes } from '../src/host/sessions.ts'

test('笔记里最近开过的那条会话：两类各按自己的时刻比', () => {
  assert.equal(latestSessionOf({
    discussion: [{ session: 'session-talk', host: 'dsh', at: '2026-10-16T18:21:28Z' }],
    run: [{ session: 'session-run', host: 'dsh', at: '2026-10-18T17:59:44Z' }],
  }), 'session-run')

  assert.equal(latestSessionOf({
    discussion: [{ session: 'session-talk', at: '2026-10-19T01:00:00Z' }],
    run: [{ session: 'session-run', at: '2026-10-18T17:59:44Z' }],
  }), 'session-talk')
})

test('时刻一样或两处都没写：跑这一格的那条压过讨论的那条', () => {
  assert.equal(latestSessionOf({
    discussion: [{ session: 'session-talk', at: '2026-10-18T00:00:00Z' }],
    run: [{ session: 'session-run', at: '2026-10-18T00:00:00Z' }],
  }), 'session-run')

  assert.equal(latestSessionOf({
    discussion: [{ session: 'session-talk' }],
    run: [{ session: 'session-run' }],
  }), 'session-run')
})

test('同一类里开过好几条：取时刻最新的那一条', () => {
  assert.equal(latestSessionOf({
    run: [
      { session: 'session-first', at: '2026-10-17T00:00:00Z' },
      { session: 'session-again', at: '2026-10-18T00:00:00Z' },
    ],
  }), 'session-again')
})

test('解不出来的那一份：什么也解不出，不抛', () => {
  assert.equal(latestSessionOf({ run: [{ host: 'dsh' }] }), undefined)
  assert.equal(latestSessionOf({ run: [{ session: '' }] }), undefined)
  assert.equal(latestSessionOf({ run: '一串东西' }), undefined)
  assert.equal(latestSessionOf('一条笔记不是一份记录'), undefined)
  assert.equal(latestSessionOf(undefined), undefined)
})

function fakePort(files, { absent = false } = {}) {
  const asked = []
  const missing = () => {
    const error = new Error('no entry here')
    error.code = 'workspace-file/not-found'
    return error
  }
  return {
    asked,
    async list(scope, path) {
      asked.push(`list ${path}`)
      if (absent) throw missing()
      return {
        path,
        entries: [
          ...Object.keys(files)
            .filter((one) => one.startsWith(`${path}/`))
            .map((one) => ({ name: one.slice(path.length + 1), type: 'file' })),
          { name: 'notes', type: 'directory' },
        ],
        truncated: false,
      }
    },
    async read(scope, path, range) {
      asked.push(`read ${path}`)
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

test('一层笔记读成一份清单：键是文件名（节点身份），值是那一格最近开过的那条会话', async () => {
  const port = fakePort({
    '.pf/meta/sessions/n-1.json': JSON.stringify({ node: 'n-1', v: 1, run: [{ session: 'session-7', at: '2026-10-18T00:00:00Z' }] }),
    '.pf/meta/sessions/n-2.json': JSON.stringify({ node: 'n-2', v: 1, discussion: [{ session: 'session-talk' }] }),
  })
  const reading = await readSessionNotes(port, scope, signal)

  assert.equal(reading.state, 'read')
  assert.equal(reading.recordPath, '.pf/meta/sessions')
  assert.equal(reading.project, 'C:\\ws')
  assert.deepEqual(reading.sessions, { 'n-1': 'session-7', 'n-2': 'session-talk' })
})

test('那一份读不动、或者一条会话都没写：跳过这一格，别的格照读', async () => {
  const port = fakePort({
    '.pf/meta/sessions/n-1.json': JSON.stringify({ run: [{ session: 'session-7' }] }),
    '.pf/meta/sessions/n-2.json': '这不是可读的 JSON 文本',
    '.pf/meta/sessions/n-3.json': JSON.stringify({ run: [{ host: 'dsh' }] }),
  })
  const reading = await readSessionNotes(port, scope, signal)

  assert.equal(reading.state, 'read')
  assert.deepEqual(Object.keys(reading.sessions), ['n-1'])
})

test('这一层目录不在（换台机器、新克隆一份记录）：交回一份空清单', async () => {
  const port = fakePort({}, { absent: true })
  const reading = await readSessionNotes(port, scope, signal)

  assert.equal(reading.state, 'missing')
  assert.deepEqual(reading.sessions, {})
})