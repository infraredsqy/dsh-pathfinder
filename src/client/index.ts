/**
 * 浏览器半身这一个插件的入口。
 *
 * 它交出去的是一样东西：**一块一挂就能用的主面板**。这一层不往 DSH 的座席上注册
 * 任何东西——中央栏那一格（`main` 的 key）与侧栏那一排（`sidebar.panellist`）归下游
 * 的挂载点那一格；重复注册会抛，两边抢同一把钥匙没有好处。所以这里只把面板、它的
 * id、以及那条与宿主说话的口子装成一条服务 `ctx.pathfinderPanel`，谁要挂就照下面
 * 那三行挂：
 *
 * ```js
 * const panel = ctx.pathfinderPanel
 * ctx.slots.inject('main', () => ctx.slots.register(
 *   { name: 'main', key: panel.id, inject: () => ({ port: panel.port }) },
 *   panel.Panel,
 * ))
 * ```
 *
 * 这条服务只有面板本体：读数从口子上来，`src/model` 那套纯函数把它读成那一刻的
 * 读数，面板只负责画。
 *
 * 服务用动态的 `ctx.inject` 取（与这个部署里别的插件同一路写法），取不到就把服务
 * 照常装出去、口子留成「取不到」那一条——面板自己会说它读不出来，不会把整条插件
 * 卡在待装状态。
 *
 * @module dsh-pathfinder/client
 */
import * as React from 'react'
import { createPanelPort, type PanelPort } from './data.ts'
import { PathfinderPanel } from './panel.tsx'
import { ensureStyle } from './styles.ts'

/** 面板的身份：中央栏那一格用它作 key，侧栏那一排用它作 id。 */
export const PANEL_ID = 'pathfinder'

/** 面板在标签上的名字。 */
export const PANEL_TITLE = '寻路'

/** 这条服务挂在上下文上的名字。 */
export const SERVICE_KEY = 'pathfinderPanel'

/**
 * 面板那一份样式的正文（构建期从 `mock/` 取进来那几张表，连同收拢）。
 *
 * 它平时由 {@link apply} 那一侧挂进文档（`ensureStyle`），这里再交出一份是为了
 * 自证夹具：`npm run check:panel` 要按面板 DOM 上解析出来的值量那些令牌，
 * 就得挂着**产物里这一份**，而不是另取一份样式。
 */
export { PANEL_CSS } from './styles.ts'

/** 交出去的那条服务。 */
export interface PathfinderPanelApi {
  /** 面板的身份。 */
  readonly id: string
  /** 面板的名字。 */
  readonly title: string
  /** 与宿主说话的那条口子：读四份记录，写归档 / 复原 / 删除与三个策略数。 */
  readonly port: PanelPort
  /** 面板本体，直接交给 `slots.register` 的第二个参数。 */
  readonly Panel: (props: PanelArgs) => React.ReactElement
}

/** 面板拿到的几样：口子在装配时就绑好，会话由座席那一侧递进来。 */
export interface PanelArgs {
  /** 与宿主说话的那条口子。 */
  readonly port: PanelPort
  /** 读哪条会话所在的工作区。 */
  readonly sessionId?: string | undefined
}

/** 插件体：把面板装成一条服务。 */
export function apply(ctx: unknown): void {
  const port = createPanelPort(ctx)
  const api: PathfinderPanelApi = {
    id: PANEL_ID,
    title: PANEL_TITLE,
    port,
    Panel: Entry,
  }
  try {
    const provide = (ctx as { provide?: (key: string, value: unknown) => void } | null | undefined)?.provide
    if (typeof provide === 'function') provide.call(ctx, SERVICE_KEY, api)
  } catch (error) {
    report('面板这一格没装上去', error)
  }
}

/**
 * 座席那一侧真正渲染的那个组件。
 *
 * 它比 {@link PathfinderPanel} 多一件事：会话身份。中央栏那一格是根作用域、不注入
 * `sessionId`，所以这一层从现成的 `useSessions` 快照里挑当前那一条；座席要是自己
 * 递了 `sessionId`，那个说话。
 * @param props - 座席递过来的几样。
 * @returns 面板本体。
 */
function Entry(props: PanelArgs & { readonly useSessions?: unknown }): React.ReactElement {
  ensureStyle()
  const hooks = props.useSessions
  const snapshot = typeof hooks === 'function' ? (hooks as () => unknown)() : undefined
  const sessionId = props.sessionId ?? currentSessionOf(snapshot)
  return React.createElement(PathfinderPanel, { port: props.port, sessionId })
}

/**
 * 从会话清单那一刻的快照里挑当前那一条。
 *
 * 记录里有这个数的时候用记录里那个；没有的时候退到清单第一行——面板总得对着某个
 * 工作区才画得出东西来。
 * @param snapshot - `useSessions` 那一刻的快照。
 * @returns 会话身份，挑不出来就是 `undefined`。
 */
export function currentSessionOf(snapshot: unknown): string | undefined {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined
  const held = snapshot as {
    readonly selectedId?: unknown
    readonly currentId?: unknown
    readonly activeId?: unknown
    readonly ids?: unknown
    readonly byId?: unknown
  }
  for (const value of [held.selectedId, held.currentId, held.activeId]) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  if (Array.isArray(held.ids)) {
    const first = held.ids.find((id): id is string => typeof id === 'string' && id.length > 0)
    if (first !== undefined) return first
  }
  if (typeof held.byId === 'object' && held.byId !== null) {
    const first = Object.keys(held.byId)[0]
    if (first !== undefined && first.length > 0) return first
  }
  return undefined
}

/** 一条警告；面板的装配出了岔子不该静悄悄。 */
function report(what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  // eslint-disable-next-line no-console -- 装配失败必须留下一条可查的痕迹
  console.warn(`dsh-pathfinder: ${what}：${message}`)
}