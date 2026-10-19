/**
 * 调度中心在 DSH 自己那两处位置上的挂载点：侧栏面板图标列里的一项、中央栏那一格。
 *
 * 两个槽位都是别人已经声明过的（座席由 ui-layout / ui-sidebar 在运行时声明），往还没声明的
 * 槽里注册会在加载时直接抛，所以一律走 `slots.inject('<槽位>', …)`——它等的是声明，与两条
 * 插件谁先谁后无关。
 *
 * 这一份刻意落在 `.ts` 上、组件用 `React.createElement` 写：Node 直接加载 `.tsx` 会
 * `ERR_UNKNOWN_FILE_EXTENSION`，单测就进不来，而这里的注册与那份会话身份正是要单测锁住的东西。
 */
import * as React from 'react'
import type { PathfinderPanelApi } from './index.ts'
import { injectAt, report, serveOn, type SlotsService } from './context.ts'
import { serviceAt } from './data.ts'
import { NO_WORKSPACES, workspacesAt, type WorkspaceSource } from './workspaces.ts'

/** 侧栏那一行的位置：「插件」是 0、「排期」是 10，这一档紧挨插件下面。 */
export const PANEL_ORDER = 1

/** 侧栏那一行上的名字：界面叫调度中心，包与仓叫 `dsh-pathfinder`。 */
export const SEAT_LABEL = '调度中心'

/**
 * 座席标准 props 里那个 `useSessions` 快照。
 *
 * 它是一条带投影的 hook：整份快照要靠一次恒等投影取回来，不传投影等于把 `undefined` 当选择器
 * 调下去。
 * @param useSessions - 槽位递过来的那条 hook；不在这个部署上时什么都不是。
 */
export function sessionsSnapshotOf(useSessions: unknown): unknown {
  if (typeof useSessions !== 'function') return undefined
  return (useSessions as (select: (state: unknown) => unknown) => unknown)((state) => state)
}

interface SessionInList {
  readonly id?: unknown
  /** 谁还留着它：`mainView > 0` 的那一条就是当前会话。 */
  readonly retainedBy?: { readonly mainView?: unknown }
}

/**
 * 从会话清单那一刻的快照里挑当前那一条。
 *
 * DSH 自己的口径是 `byId` 里 `retainedBy.mainView > 0` 的那一条——`ids` 是宿主清单次序，副会话
 * 也会进 `byId`，两头都不等于「当前打开的那条」。`selectedId` / `currentId` / `activeId` 那三个
 * 探针服务的是别的形状与替身，有就先用；三者都没有、也没人挂 `mainView` 时，才落到清单一头那条
 * 兜底。
 * @param snapshot - `useSessions` 那一刻的快照。
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
  if (typeof held.byId === 'object' && held.byId !== null) {
    const sessions = Object.values(held.byId as Record<string, SessionInList | undefined>)
    const current = sessions.find((session) => {
      const held = session?.retainedBy?.mainView
      return typeof held === 'number' && held > 0
    })
    if (typeof current?.id === 'string' && current.id.length > 0) return current.id
  }
  if (Array.isArray(held.ids)) {
    const first = held.ids.find((id): id is string => typeof id === 'string' && id.length > 0)
    if (first !== undefined) return first
  }
  return undefined
}

/**
 * 会话清单那一刻的快照里，这台机器上有哪些会话。
 *
 * 两处都算数：`ids` 是宿主清单的次序，`byId` 是清单行加上本地留着的那些。面板拿这份名册比对
 * 记录里那条会话在不在本机上——两处都没有它，卡上那一下就没有去处。
 * @param snapshot - `useSessions` 那一刻的快照。
 */
export function knownSessionsOf(snapshot: unknown): ReadonlySet<string> {
  const known = new Set<string>()
  if (typeof snapshot !== 'object' || snapshot === null) return known
  const held = snapshot as { readonly ids?: unknown; readonly byId?: unknown }
  if (Array.isArray(held.ids)) {
    for (const id of held.ids) if (typeof id === 'string' && id.length > 0) known.add(id)
  }
  if (typeof held.byId === 'object' && held.byId !== null) {
    for (const id of Object.keys(held.byId)) if (id.length > 0) known.add(id)
  }
  return known
}

interface NavigationFace {
  readonly openSession?: (target: string) => void
}

export interface SessionNav {
  open(target: string): void
}

/**
 * 切会话那一手：DSH 现成的导航口子（`ctx.uiWorkspace.openSession`）的薄壳。
 *
 * 那个口子只管切，给不出结论——记录里那条会话在不在本机，由面板拿会话清单自己对出来。它到得比
 * 这一层晚时（插件先装好、工作区那一层后到）先什么都不做，等它到场再算；两处都只取一次。
 * @param ctx - 浏览器半身那一个插件上下文。
 */
export function createSessionNav(ctx: unknown): SessionNav {
  let face: NavigationFace | undefined
  const take = (owner: unknown): void => {
    const found = serviceAt(owner, 'uiWorkspace')
    /* 取到的那一份是个代理：那一手上写得对不对，只有这一刻问得出来。 */
    if (found !== undefined && typeof found.openSession === 'function') face = found as NavigationFace
  }
  take(ctx)
  if (face === undefined) injectAt(ctx, ['uiWorkspace'], '那条导航口子没接上', take)
  return {
    open(target) {
      if (face === undefined) return
      try {
        face.openSession?.(target)
      } catch (error) {
        report('切会话没切过去', error)
      }
    },
  }
}

/**
 * 顶上那枚工作区选择器要的那份清单：DSH 的 `workspaces` 服务上那条只读口子。
 *
 * 它与切会话那一手同一路写法，只是多一层转发：那个服务到得比这一层晚时，面板顶上照旧不摆控件，
 * 等它到场再算。转发是必要的——`getSnapshot` 交给 React 之后必须每次给出同一个对象（清单没变
 * 时），所以不能临时拼一份空名单，得有一个稳定的空快照；清单换了人，也要叫一声让面板重画。
 * @param ctx - 浏览器半身那一个插件上下文。
 */
export function createWorkspaceNav(ctx: unknown): WorkspaceSource {
  let face: WorkspaceSource | undefined
  let stopFace: (() => void) | undefined
  const listeners = new Set<() => void>()
  const announce = (): void => { for (const listener of [...listeners]) listener() }
  /* 清单换了人：先前那一份退订，新那一份接上。没有听众时不订阅——面板卸载之后这一层不该还挂着
   * 别人的订阅。 */
  const adopt = (found: WorkspaceSource | undefined): void => {
    if (found === undefined || found === face) return
    stopFace?.()
    stopFace = undefined
    face = found
    if (listeners.size > 0) stopFace = found.subscribe(announce)
    announce()
  }
  adopt(workspacesAt(ctx))
  if (face === undefined) {
    injectAt(ctx, ['workspaces'], '那份工作区清单没接上', (owner) => { adopt(workspacesAt(owner)) })
  }
  return {
    getSnapshot: () => face?.getSnapshot() ?? NO_WORKSPACES.getSnapshot(),
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1 && face !== undefined) stopFace = face.subscribe(announce)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stopFace?.()
          stopFace = undefined
        }
      }
    },
  }
}

/**
 * 侧栏那一项的图标：自画的内联 SVG。产物里只有 `react` 留在外面，DSH 那套图标包不在这个仓的
 * 模块表上，引不得。
 */
function PanelIcon(props: { readonly size?: number }): React.ReactElement {
  const size = typeof props.size === 'number' && props.size > 0 ? props.size : 16
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      focusable: false,
      'aria-hidden': true,
    },
    React.createElement('path', {
      d: 'M4.5 7.1 11.1 4 M5.2 8 11.1 8 M4.5 8.9 11.1 12',
      stroke: 'currentColor',
      strokeWidth: 1.2,
      strokeLinecap: 'round',
    }),
    React.createElement('circle', { cx: 3.6, cy: 8, r: 1.7, fill: 'currentColor' }),
    React.createElement('circle', { cx: 12.1, cy: 3.5, r: 1.2, fill: 'currentColor' }),
    React.createElement('circle', { cx: 12.1, cy: 8, r: 1.2, fill: 'currentColor' }),
    React.createElement('circle', { cx: 12.1, cy: 12.5, r: 1.2, fill: 'currentColor' }),
  )
}

/**
 * 把调度中心两处接到各自的槽位上。
 *
 * 两条注册做在同一趟里，两个摘除器交给同一条 `effect` 的清理函数；清理那一趟的次序是先撤注册、
 * 再摘两张样式标签——组件随撤注册卸载，标签随后收走，反过来会让还在画的组件裸奔一瞬。
 *
 * 服务用动态的 `ctx.inject(['slots'], …)` 等：取不到 `slots` 就安静地不做，这一层从不把插件的
 * `apply` 弄挂。
 *
 * 卸载的归属分两种上下文：真 Cordis 的上下文都带 `effect`，清理挂在它上面，随插件卸载跑。没有
 * `effect` 的上下文只有替身长这样：那种上下文上 `ctx.inject` 的回调晚一个微任务才跑，调用点
 * 拿到的返回值必然是 `undefined`，所以这一层不往调用点交回什么。
 * @param ctx - 浏览器半身那一个插件上下文。
 * @param api - 同一次 `apply` 里装配好的面板：id、口子、偏好与面板本体。
 * @param dropStyles - 摘掉两张注入的样式表；由插件入口交进来，这一层不把两份表身拖进来。
 */
export function registerSeats(
  ctx: unknown,
  api: PathfinderPanelApi,
  dropStyles: () => void,
): void {
  injectAt(ctx, ['slots'], '调度中心那两处没挂上', (owner) => {
    const slots = serviceAt(owner, 'slots') as SlotsService | undefined
    if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
    const nav = createSessionNav(ctx)
    const workspaces = createWorkspaceNav(ctx)
    serveOn(owner, () => {
      const disposers = contribute(slots, api, nav, workspaces)
      return () => {
        for (const dispose of disposers.reverse()) dispose()
        dropStyles()
      }
    }, 'dsh-pathfinder: seats')
  })
}

/**
 * 两条注册，每条各挡在自己的 `try` 里。
 *
 * 一条挂不上（比如同一个 id 已经在册）不该把另外一条一起带走：那些位置照样是该露面的，而重复
 * 注册那一下会抛在槽位登记处的通知里，React 自己的订阅也在那条通知上——那个抛必须停在这一层。
 */
function contribute(
  slots: SlotsService,
  api: PathfinderPanelApi,
  nav: SessionNav,
  workspaces: WorkspaceSource,
): (() => void)[] {
  const disposers: (() => void)[] = []
  const put = (what: string, run: () => unknown): void => {
    try {
      const dispose = run()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    } catch (error) {
      report(`${what}没注册上`, error)
    }
  }
  put('侧栏那一项', () => slots.inject?.('sidebar.panellist', () => slots.register?.({
    name: 'sidebar.panellist',
    id: api.id,
    order: PANEL_ORDER,
    label: () => SEAT_LABEL,
  }, PanelIcon)))
  put('中央栏那一格', () => slots.inject?.('main', () => slots.register?.({
    name: 'main',
    key: api.id,
    inject: () => ({ port: api.port, prefs: api.prefs, openSession: nav.open, workspaces }),
  }, api.Panel)))
  return disposers
}