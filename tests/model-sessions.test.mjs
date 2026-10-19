/* 会话笔记的读数：哪份文件算笔记、它属于哪一格、一格开过好几条时该看哪条。
 *
 * 会话笔记是模型层的又一份输入：宿主半身把那一层目录原样搬回来，挑哪条给读者在这里判。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { latestSessionOf, readSessions } from '../src/model/index.ts'

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
