/* 面板顶上那枚工作区选择器的候选名单：锁的是「清单从哪来」与「这条会话落在哪个桶里」。
 *
 * 清单从 DSH 的 `workspaces` 服务上那条只读口子来，形状不对的当没有；没有清单时那份空
 * 名单每次给出同一个对象——现拼一份新的，React 会当成一直在变。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { NO_WORKSPACES, bucketOf, workspacesAt } from '../src/client/workspaces.ts'

function choice(workspaceId, sessionIds = []) {
  return { workspaceId, path: `C:\\${workspaceId}`, title: workspaceId, sessionIds }
}

function source(items) {
  const snapshot = { items }
  const listeners = []
  return {
    listeners,
    face: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.push(listener)
        return () => { listeners.splice(listeners.indexOf(listener), 1) }
      },
    },
  }
}

test('清单从上下文上取：getSnapshot 与 subscribe 两手都在才算数', () => {
  const { face } = source([choice('w-1')])
  const owner = { get: (name) => (name === 'workspaces' ? { list: face } : undefined) }

  assert.equal(workspacesAt(owner), face)
})

test('清单挂在属性上（没有 get 的上下文）也认', () => {
  const { face } = source([choice('w-1')])

  assert.equal(workspacesAt({ workspaces: { list: face } }), face)
})

test('形状不对：少一手、或者不是一条清单，一律当没有', () => {
  assert.equal(workspacesAt({ get: () => ({ list: { getSnapshot: () => ({ items: [] }) } }) }), undefined)
  assert.equal(workspacesAt({ get: () => ({ list: { subscribe: () => () => undefined } }) }), undefined)
  assert.equal(workspacesAt({ get: () => ({ list: null }) }), undefined)
  assert.equal(workspacesAt({ get: () => undefined }), undefined)
  assert.equal(workspacesAt(undefined), undefined)
})

test('没有清单时那份空名单：永远是同一个对象，订阅它什么也不发生', () => {
  assert.equal(NO_WORKSPACES.getSnapshot(), NO_WORKSPACES.getSnapshot())
  assert.deepEqual(NO_WORKSPACES.getSnapshot().items, [])
  assert.equal(typeof NO_WORKSPACES.subscribe(() => undefined), 'function')
})

test('这条会话落在哪个桶里：身份在哪个工作区的名下就算它', () => {
  const items = [choice('w-1', ['s-9']), choice('w-2', ['s-7', 's-8'])]

  assert.equal(bucketOf(items, 's-7')?.workspaceId, 'w-2')
  assert.equal(bucketOf(items, 's-9')?.workspaceId, 'w-1')
})

test('一个都不出现、或压根没有会话：未分组', () => {
  const items = [choice('w-1', ['s-9'])]

  assert.equal(bucketOf(items, 's-404'), undefined)
  assert.equal(bucketOf(items, ''), undefined)
  assert.equal(bucketOf(items, undefined), undefined)
  assert.equal(bucketOf([], 's-9'), undefined)
})
