/**
 * 面板顶上那枚工作区选择器的候选名单：DSH 自己那份工作区清单。
 *
 * 调度中心不关心 DSH 此刻把哪条会话摆在中央栏，所有工作区对它都是可以打开的对象；这一层只把
 * 那份清单读成一个快照、认出「这条会话落在哪个桶里」、没有清单时交出一份空名单。清单本身归
 * DSH 的 `workspaces` 服务，这里不缓存、不复制。
 */
import { serviceAt } from './data.ts'

export interface WorkspaceChoice {
  /** 工作区身份，下拉里的值就是它。 */
  readonly workspaceId: string
  /** 那个工作区的绝对路径：读记录时的那个根。 */
  readonly path: string
  /** 印在下拉里的名字，DSH 自己给的那个标题。 */
  readonly title: string
  readonly sessionIds: readonly string[]
}

export interface WorkspaceSnapshot {
  /** 按 DSH 自己的次序排好的工作区。 */
  readonly items: readonly WorkspaceChoice[]
}

/**
 * DSH 那份工作区清单的口子。
 *
 * 只取读的两手：这一层不写清单——建、改名、删都是 DSH 左侧那一栏的事。
 */
export interface WorkspaceSource {
  getSnapshot(): WorkspaceSnapshot
  subscribe(listener: () => void): () => void
}

/**
 * 一份空名单。
 *
 * 它必须是同一个对象：`getSnapshot` 交给 React 之后，清单没变时每次都要给出同一个引用，临时
 * 拼一份新的会让 React 以为一直在变。没有工作区清单的部署共用这一份。
 */
const EMPTY: WorkspaceSnapshot = { items: [] }

/** 这个部署上没有工作区清单时用的那一份口子：名单永远空着，谁也不用订阅。 */
export const NO_WORKSPACES: WorkspaceSource = {
  getSnapshot: () => EMPTY,
  subscribe: () => () => undefined,
}

/**
 * 从上下文上取 DSH 那份工作区清单。
 *
 * 取不到就是取不到：面板顶上不摆选择器，照旧读这条会话自己那个工作区。这一层不抛。
 * @param owner - 一个上下文（插件自己的，或注入回调给的那个）。
 */
export function workspacesAt(owner: unknown): WorkspaceSource | undefined {
  const service = serviceAt(owner, 'workspaces')
  const list = service?.list
  if (typeof list !== 'object' || list === null) return undefined
  const held = list as { readonly getSnapshot?: unknown; readonly subscribe?: unknown }
  if (typeof held.getSnapshot !== 'function' || typeof held.subscribe !== 'function') return undefined
  return list as WorkspaceSource
}

/**
 * 这条会话落在哪个桶里。
 *
 * 「桶」就是 DSH 那一栏的分组：会话身份出现在某个工作区的 `sessionIds` 里，它就落在那一个里；
 * 一个都不出现就是未分组——DSH 自己也是这么读的。
 * @param items - 此刻的工作区清单。
 * @param sessionId - 会话身份；没有会话时是 `undefined`。
 */
export function bucketOf(
  items: readonly WorkspaceChoice[],
  sessionId: string | undefined,
): WorkspaceChoice | undefined {
  if (sessionId === undefined || sessionId.length === 0) return undefined
  return items.find((item) => item.sessionIds.includes(sessionId))
}
