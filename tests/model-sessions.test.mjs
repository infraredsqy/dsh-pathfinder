/* The session notes reading: which file counts as a note, which cell it belongs to, and which
 * session to look at when a cell opened several.
 *
 * Session notes are another input of the model layer: the host half carries that directory back
 * verbatim, and which session to surface to the reader is judged here.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { latestSessionOf, readSessions, strandedCycleOf } from '../src/model/index.ts'

test('一份笔记里最近开过的那条会话：两类各按自己的时刻比', () => {
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

test('一层笔记读成读数：文件名剥掉后缀是节点身份，后缀不对的不算笔记', () => {
  const out = readSessions({
    'n-1.json': JSON.stringify({ run: [{ session: 'session-7' }] }),
    'n-2.json': JSON.stringify({ discussion: [{ session: 'session-talk' }] }),
    '说明.md': JSON.stringify({ run: [{ session: 'session-md' }] }),
    '.json': JSON.stringify({ run: [{ session: 'session-bare' }] }),
  })

  assert.deepEqual(out, { 'n-1': 'session-7', 'n-2': 'session-talk' })
})

test('解不动的那一份：跳过那一格，别的格照读', () => {
  const out = readSessions({
    'n-1.json': '这不是可读的 JSON 文本',
    'n-2.json': JSON.stringify({ run: [{ host: 'dsh' }] }),
    'n-3.json': JSON.stringify({ run: [{ session: 'session-3' }] }),
  })

  assert.deepEqual(out, { 'n-3': 'session-3' })
})

test('一层笔记一条都没有：交回空的一份', () => {
  assert.deepEqual(readSessions({}), {})
})

/* ---- the stranded dispatch: claim on disk, session gone ------------------ */

const heldNode = { id: 'n-1', running: true }

test('认领在、会话不在：这一格 stranded，回的是认领所在的那条线', () => {
  const claims = { 'n-1': 'c-1' }
  const sessions = { 'n-1': 'session-7' }
  const alive = new Set(['session-other'])

  assert.equal(strandedCycleOf(heldNode, claims, sessions, alive), 'c-1')
})

test('会话还活着：不是 stranded', () => {
  const alive = new Set(['session-7'])

  assert.equal(strandedCycleOf(heldNode, { 'n-1': 'c-1' }, { 'n-1': 'session-7' }, alive), null)
})

test('没有认领：不是 stranded——claims 是这条读数的门', () => {
  const alive = new Set([])

  assert.equal(strandedCycleOf(heldNode, {}, { 'n-1': 'session-7' }, alive), null)
  assert.equal(strandedCycleOf(heldNode, { 'n-1': '' }, { 'n-1': 'session-7' }, alive), null)
})

test('笔记没有给出会话身份：判不了「不在」，不算 stranded', () => {
  const alive = new Set([])

  assert.equal(strandedCycleOf(heldNode, { 'n-1': 'c-1' }, {}, alive), null)
  assert.equal(strandedCycleOf(heldNode, { 'n-1': 'c-1' }, { 'n-1': 'session-7' }, null), null)
})

test('格子不在任何线的手里：认领和笔记都还在也不算 stranded——settled 的格子永远带着这两样', () => {
  const done = { id: 'n-1', running: false }
  const alive = new Set([])

  assert.equal(strandedCycleOf(done, { 'n-1': 'c-1' }, { 'n-1': 'session-7' }, alive), null)
})
