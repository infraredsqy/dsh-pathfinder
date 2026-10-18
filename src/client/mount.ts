/**
 * 调度中心在 DSH 自己那两处位置上的挂载点。
 *
 * 两处，两个槽位，注册方式各不同：
 *   - `sidebar.panellist`：侧栏面板图标列里的一项，`id` 就是中央栏那一格的 key，
 *     `order` 决定它落在整列里的第几行（升序）。
 *   - `main`：中央栏按 key 分派，key 与侧栏那一项同一个 id。`conversation` 是 DSH
 *     自己的保留键，聊天住在那儿，谁也不许占。
 *
 * 这个插件的东西住在两处：**调度中心自己那一格**（侧栏这枚图标项点开就是它）与**设置里
 * 那一节**（`settings.tsx`）。面板要把「这个工作区没有记录」「读不出来」说清楚，这两句话
 * 就摆在面板正文里（`panel.tsx`）——读者在哪儿读面板，就在哪儿读到它们。
 *
 * 两个槽位都是**别人已经声明过**的：座席由 ui-layout / ui-sidebar 在运行时声明，往还
 * 没声明的槽里注册会在加载时直接抛。所以一律走 `slots.inject('<槽位>', …)`——它等的是
 * 声明，与两条插件谁先谁后无关。
 *
 * 卸载要撤干净（完成判定第 2 条）：两个摘除器与两张注入的样式表，全挂在同一条
 * `ctx.effect` 的清理函数上；次序是先撤注册（组件随之卸载），再摘样式标签。
 *
 * 这一份刻意落在 `.ts` 上、组件用 `React.createElement` 写：Node 直接加载 `.tsx` 会
 * `ERR_UNKNOWN_FILE_EXTENSION`，单测就进不来，而这里的注册与那份会话身份正是要单测锁住
 * 的东西。写法与 `index.ts` 里的 `Entry` 一致。
 *
 * @module dsh-pathfinder/client/mount
 */
import * as React from 'react'
import type { PathfinderPanelApi } from './index.ts'
import { serviceAt } from './data.ts'
import { NO_WORKSPACES, workspacesAt, type WorkspaceSource } from './workspaces.ts'

/** 侧栏那一行的位置：「插件」是 0、「排期」是 10，这一档紧挨插件下面。 */
export const PANEL_ORDER = 1

/** 侧栏那一行上的名字。名字是用户定的：界面叫**调度中心**，包与仓叫 `dsh-pathfinder`。 */
export const SEAT_LABEL = '调度中心'

/* ---- 会话身份与去处 ------------------------------------------------------ */

/**
 * 座席标准 props 里那个 `useSessions` 快照。
 *
 * 它是一条**带投影的** hook：整份快照要靠一次恒等投影取回来，不传投影等于把 `undefined`
 * 当选择器调下去。
 * @param useSessions - 槽位递过来的那条 hook；不在这个部署上时什么都不是。
 * @returns 那一刻的会话清单快照，取不到就是 `undefined`。
 */
export function sessionsSnapshotOf(useSessions: unknown): unknown {
  if (typeof useSessions !== 'function') return undefined
  return (useSessions as (select: (state: unknown) => unknown) => unknown)((state) => state)
}

/**
 * 会话清单快照里 `byId` 每一条的样子：只取挑当前会话用得上那两样。
 */
interface SessionInList {
  /** 会话身份。 */
  readonly id?: unknown
  /** 谁还留着它：`mainView > 0` 的那一条就是当前会话。 */
  readonly retainedBy?: { readonly mainView?: unknown }
}

/**
 * 从会话清单那一刻的快照里挑当前那一条。
 *
 * DSH 自己的口径是 `byId` 里 `retainedBy.mainView > 0` 的那一条——`ids` 是宿主清单次序，
 * 副会话也会进 `byId`，两头都不等于「当前打开的那条」。`selectedId` / `currentId` /
 * `activeId` 那三个探针服务的是别的形状与替身，有就先用；三者都没有、也没人挂 `mainView`
 * 时，才落到清单一头那条兜底（宿主还没标主视图的部署总得对着某个工作区才画得出东西）。
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
 * 两处都算数：`ids` 是宿主清单的次序，`byId` 是清单行加上本地留着的那些（副会话的地址也
 * 住在里面）。面板拿这份名册比对记录里那条会话在不在本机上——两处都没有它，卡上那一下
 * 就没有去处。
 * @param snapshot - `useSessions` 那一刻的快照。
 * @returns 会话身份的名册；快照拿不到就是空的一份。
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

/** DSH 那条导航口子上这一层用得着的一手。 */
interface NavigationFace {
  readonly openSession?: (target: string) => void
}

/** 切会话那一手：面板拿到的是一个身份，把它递出去。 */
export interface SessionNav {
  /**
   * 切到那一条会话。
   * @param target - 会话身份。
   */
  open(target: string): void
}

/**
 * 切会话那一手：DSH 现成的导航口子（`ctx.uiWorkspace.openSession`）的薄壳。
 *
 * 那个口子只管切，给不出结论——记录里那条会话在不在本机，由面板拿会话清单自己对出来。
 * 所以这一层只做一件事：把身份递给它。它到得比这一层晚时（插件先装好、工作区那一层
 * 后到）先什么都不做，等它到场再算；两处都只取一次。
 * @param ctx - 浏览器半身那一个插件上下文。
 * @returns 那一手；口子始终没到场时点下去什么也不发生。
 */
export function createSessionNav(ctx: unknown): SessionNav {
  let face: NavigationFace | undefined
  const take = (owner: unknown): void => {
    const found = serviceAt(owner, 'uiWorkspace')
    /* 取到的那一份是个代理：那一手上写得对不对，只有这一刻问得出来。 */
    if (found !== undefined && typeof found.openSession === 'function') face = found as NavigationFace
  }
  take(ctx)
  if (face === undefined) {
    const holder = ctx as { inject?: (names: readonly string[], callback: (owner: unknown) => void) => unknown } | null | undefined
    try {
      holder?.inject?.(['uiWorkspace'], take)
    } catch (error) {
      report('那条导航口子没接上', error)
    }
  }
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

/* ---- 两处座席各自的样子 -------------------------------------------------- */

/**
 * 顶上那枚工作区选择器要的那份清单：DSH 的 `workspaces` 服务上那条只读口子。
 *
 * 它与切会话那一手同一路写法，只是多一层转发：那个服务到得比这一层晚时（插件先装好、
 * 工作区那一层后到），面板顶上照旧不摆控件，等它到场再算。转发是必要的——`getSnapshot`
 * 交给 React 之后必须**每次给出同一个对象**（清单没变时），所以不能临时拼一份空名单，
 * 得有一个稳定的空快照；清单换了人，也要叫一声让面板重画。
 * @param ctx - 浏览器半身那一个插件上下文。
 * @returns 那份清单的口子；那个服务始终没到场时空名单。
 */
export function createWorkspaceNav(ctx: unknown): WorkspaceSource {
  let face: WorkspaceSource | undefined
  let stopFace: (() => void) | undefined
  const listeners = new Set<() => void>()
  const announce = (): void => { for (const listener of [...listeners]) listener() }
  /* 清单换了人（那个服务晚到场）：先前那一份退订，新那一份接上。没有听众时不订阅——
   * 面板卸载之后这一层不该还挂着别人的订阅。 */
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
    const holder = ctx as { inject?: (names: readonly string[], callback: (owner: unknown) => void) => unknown } | null | undefined
    try {
      holder?.inject?.(['workspaces'], (owner) => { adopt(workspacesAt(owner)) })
    } catch (error) {
      report('那份工作区清单没接上', error)
    }
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
 * 侧栏那一项的图标：自画的内联 SVG。
 *
 * 产物里只有 `react` 留在外面，DSH 那套图标包不在这个仓的模块表上，引不得。图形是
 * 「一个源头分出去三条线」：调度中心干的就是这件事，而侧栏只给它一枚 16/18 的方寸。
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

/* ---- 把两处挂上去 -------------------------------------------------------- */

/** 上下文那一侧用得上的那一手。 */
interface ClientContext {
  inject?: (names: readonly string[], callback: (owner: unknown) => void) => unknown
}

/** `slots` 那一侧用得上的两手。 */
interface SlotsService {
  inject?: (key: string, register: () => unknown) => unknown
  register?: (options: unknown, component: (props: never) => React.ReactNode) => unknown
}

/** 上下文上挂 effect 的那一手。 */
interface EffectOwner {
  effect?: (run: () => () => void, name?: string) => unknown
}

/**
 * 把调度中心两处接到各自的槽位上。
 *
 * 两条注册做在同一趟里，两个摘除器交给同一条 `effect` 的清理函数；清理那一趟的次序是
 * 先撤注册、再摘两张样式标签——组件随撤注册卸载，标签随后收走，反过来会让还在画的
 * 组件裸奔一瞬。
 *
 * 服务用动态的 `ctx.inject(['slots'], …)` 等（照设置那一节的写法）：取不到 `slots` 就
 * 安静地不做，这一层从不把插件的 `apply` 弄挂，也不把自己卡在待装状态。
 *
 * 卸载的归属分两种上下文：真 Cordis 的上下文都带 `effect`，清理挂在它上面，随插件卸载
 * 跑（完成判定第 2 条要的那一趟）。没有 `effect` 的上下文只有替身长这样：那种上下文上
 * `ctx.inject` 的回调晚一个微任务才跑，调用点拿到的返回值必然是 `undefined`，所以这一层
 * 不往调用点交回什么——替身上那两条注册没有卸载通知可归，随那个上下文一起走。
 * @param ctx - 浏览器半身那一个插件上下文。
 * @param api - 同一次 `apply` 里装配好的面板：id、口子、偏好与面板本体。
 * @param dropStyles - 摘掉两张注入的样式表；由插件入口交进来（`styles.ts` 与
 * `settings.tsx` 各有一条摘除口子，这一层不把两份表身拖进来）。
 */
export function registerSeats(
  ctx: unknown,
  api: PathfinderPanelApi,
  dropStyles: () => void,
): void {
  const holder = ctx as ClientContext | null | undefined
  if (holder === null || holder === undefined || typeof holder.inject !== 'function') return
  try {
    holder.inject(['slots'], (owner) => {
      try {
        const slots = serviceAt(owner, 'slots') as SlotsService | undefined
        if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
        const nav = createSessionNav(ctx)
        const workspaces = createWorkspaceNav(ctx)
        const serve = (): (() => void) => {
          const disposers = contribute(slots, api, nav, workspaces)
          return () => {
            for (const dispose of disposers.reverse()) dispose()
            dropStyles()
          }
        }
        const effect = (owner as EffectOwner).effect
        if (typeof effect === 'function') effect.call(owner, serve, 'dsh-pathfinder: seats')
        /* 没有 `effect` 的上下文：这里没人替它管卸载，`serve()` 交回的那一手也无处可交
         * ——调用点拿到的只会是 `undefined`（`ctx.inject` 的回调晚一个微任务才跑）。两条
         * 注册照挂，卸载随这个上下文走。 */
        else serve()
      } catch (error) {
        report('调度中心那两处没挂上', error)
      }
    })
  } catch (error) {
    report('调度中心那两处没挂上', error)
  }
}

/**
 * 两条注册，每条各挡在自己的 `try` 里。
 *
 * 一条挂不上（比如同一个 id 已经在册）不该把另外一条一起带走：那些位置照样是该露面的，
 * 而重复注册那一下会抛在槽位登记处的通知里，React 自己的订阅也在那条通知上——那个抛
 * 必须停在这一层。
 * @param slots - `slots` 服务。
 * @param api - 面板。
 * @param nav - 卡上那一下的去处：交给中央栏那一格。
 * @param workspaces - 顶上那枚工作区选择器的候选名单：也交给中央栏那一格。
 * @returns 收到的那几个摘除器，次序就是注册的次序。
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

/** 一条警告；这两处没挂上不该静悄悄。 */
function report(what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  // eslint-disable-next-line no-console -- 装配失败必须留下一条可查的痕迹
  console.warn(`dsh-pathfinder: ${what}：${message}`)
}