/**
 * 调度中心在 DSH 自己那几处位置上的挂载点。
 *
 * 四处，四个槽位，注册方式各不相同：
 *   - `sidebar.panellist`：侧栏面板图标列里的一项，`id` 就是中央栏那一格的 key，
 *     `order` 决定它落在整列里的第几行（升序）。
 *   - `main`：中央栏按 key 分派，key 与侧栏那一项同一个 id。`conversation` 是 DSH
 *     自己的保留键，聊天住在那儿，谁也不许占。
 *   - `sidebar.footer.action`：侧栏脚上「设置」旁边那一列动作，只印一枚从记录读出来的
 *     数，不接任何交互。
 *   - `shell.overlay`：整帧之上那一层浮层。层本身是穿透的，条目可以自己 opt-in 指针
 *     事件；这一条是纯提示，反过来明说「不接指针」——有事才说一句，没事不画。
 *
 * 四个槽位都是**别人已经声明过**的：座席由 ui-layout / ui-sidebar 在运行时声明，往还
 * 没声明的槽里注册会在加载时直接抛。所以一律走 `slots.inject('<槽位>', …)`——它等的是
 * 声明，与两条插件谁先谁后无关。
 *
 * 卸载要撤干净（完成判定第 2 条）：四个摘除器、那份共用读数、两张注入的样式表，全挂在
 * 同一条 `ctx.effect` 的清理函数上；次序是先撤注册（组件随之卸载），再摘样式标签。
 *
 * 这一份刻意落在 `.ts` 上、组件用 `React.createElement` 写：Node 直接加载 `.tsx` 会
 * `ERR_UNKNOWN_FILE_EXTENSION`，单测就进不来，而这里的四条注册与那份读数正是要单测锁住
 * 的东西。写法与 `index.ts` 里的 `Entry` 一致。
 *
 * @module dsh-pathfinder/client/mount
 */
import * as React from 'react'
import type { PathfinderPanelApi } from './index.ts'
import { serviceAt, type PanelPort } from './data.ts'
import type { PathfinderReading } from '../host/contract.ts'
import { readProject, type ProjectReading } from '../model/index.ts'

/** 侧栏那一行的位置：「插件」是 0、「排期」是 10，这一档紧挨插件下面。 */
export const PANEL_ORDER = 1

/** 侧栏那一行上的名字。名字是用户定的：界面叫**调度中心**，包与仓叫 `dsh-pathfinder`。 */
export const SEAT_LABEL = '调度中心'

/** 页脚那枚徽标在 `sidebar.footer.action` 里的条目名。 */
export const READY_BADGE_ID = 'pathfinder.ready-badge'

/** 浮层那一句提示在 `shell.overlay` 里的条目名。 */
export const PENDING_NOTICE_ID = 'pathfinder.pending-notice'

/** 页脚动作那一列的次序：排在别的页脚动作后面，`order` 升序。 */
export const FOOTER_ORDER = 10

/** 浮层那一层里各条目自己的次序。 */
export const NOTICE_ORDER = 10

/** 词表里「可开工」那一栏的词；数从记录现算。 */
const READY_WORD = '可开工'

/** 词表里「等待处理」那一栏的词；数从记录现算。 */
const SHELVED_WORD = '等待处理'

/** 还没有会话时的那句话，与面板那一格用的同一句。 */
const NO_SESSION = '还没有选中会话，读不出这是哪个工作区。'

/** 这个工作区里压根没有记录时的那句话：四份来源全 `missing`，读数里一个数都没有来处。 */
const NO_RECORD = '这个工作区里没有记录。'

/** 记录在、但一份都读不动时的那句话：四份来源全 `unusable`。与上一句分开——「读不动」不是「没有」。 */
const UNUSABLE_RECORD = '这个工作区里的记录读不动。'

/* ---- 那一份共用的读数 ---------------------------------------------------- */

/**
 * 页脚徽标与浮层要说的是同一份读数。
 *
 * 两处都是 root 作用域、都拿得到同一条会话，读各读一遍就浪费一趟取数、还可能两处说的
 * 不是同一个时刻。所以取数只做一遍：谁先露面谁把会话递进来，另一处跟着用。
 */
export interface SeatReadings {
  /** 读数变了就叫一声。 */
  subscribe(listener: () => void): () => void
  /** 此刻那一份读数；没变就还是同一个对象。 */
  getSnapshot(): SeatReading
  /**
   * 座席把「我现在对着哪条会话」递进来。看过的那条会话不重读。
   * @param sessionId - 会话身份；没有会话就是 `undefined`。
   */
  attach(sessionId: string | undefined): void
  /** 卸载：在飞的读作废，之后不再叫订阅者。 */
  dispose(): void
}

/**
 * 一份读数的三档，与面板那一格同一套说法。
 *
 * `failed` 里带一句给人看的话：记录读不回来时，浮层把那句话印出来（面板也是这么办的）。
 * `ok` 那一档另带两枚记号：「这个工作区里没有记录」（四份来源全 `missing`）与「记录读不动」
 * （四份来源全 `unusable`）在集合上都长得一样（空集合），只有这两枚记号分得开；两档屏上
 * 说的是两句话，徽标也各有各的处置。
 */
export type SeatReading =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ok'; readonly project: ProjectReading; readonly recordAbsent: boolean; readonly recordUnusable: boolean }
  | { readonly phase: 'failed'; readonly message: string }

/**
 * 这一份记录读回来时，四份来源是不是一份都没列到——那就是「这个工作区里没有记录」。
 *
 * 宿主半身那一侧的口径：记录那一层目录列不到、四份文件一份也没列到，四份来源就全报
 * `missing`。一处 `read`／`unusable` 都算这个工作区里有记录。
 * @param reading - 宿主半身交回来的那份记录。
 * @returns 全 `missing` 就是 `true`。
 */
function recordAbsent(reading: PathfinderReading): boolean {
  const states = Object.values(reading.sources)
  return states.length > 0 && states.every((state) => state === 'missing')
}

/**
 * 这一份记录读回来时，四份来源是不是一份都读不动——记录在（那一层目录列得到、文件也在），
 * 但没有一份解得出内容，宿主半身四份全报 `unusable`。
 *
 * 与 `recordAbsent` 互斥，也不该混用：`missing` 是「这个工作区里没有记录」，`unusable` 是
 * 「记录在、读不动」。两档的集合都是空的，屏上靠这两枚记号分开。
 * @param reading - 宿主半身交回来的那份记录。
 * @returns 全 `unusable` 就是 `true`。
 */
function recordUnusable(reading: PathfinderReading): boolean {
  const states = Object.values(reading.sources)
  return states.length > 0 && states.every((state) => state === 'unusable')
}

/**
 * 做一只读数源。
 * @param port - 与宿主说话的那条口子。
 * @returns 两处座席共用的这一份。
 */
export function createSeatReadings(port: PanelPort): SeatReadings {
  let state: SeatReading = { phase: 'loading' }
  let current: string | undefined
  let generation = 0
  const listeners = new Set<() => void>()
  const publish = (next: SeatReading): void => {
    state = next
    for (const listener of [...listeners]) listener()
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => state,
    attach(sessionId) {
      const key = sessionId === undefined || sessionId.length === 0 ? '' : sessionId
      if (key === current) return
      current = key
      /* 换会话就是在飞的读作废：晚回来的那一趟说的是上一条会话。 */
      const mine = (generation += 1)
      if (key === '') {
        publish({ phase: 'failed', message: NO_SESSION })
        return
      }
      publish({ phase: 'loading' })
      port.read(key).then(
        (reading) => {
          if (mine !== generation) return
          publish({
            phase: 'ok',
            project: readProject({
              nodes: reading.nodes,
              cycles: reading.cycles,
              instructions: reading.instructions,
              issues: reading.issues,
              at: new Date(),
            }),
            recordAbsent: recordAbsent(reading),
            recordUnusable: recordUnusable(reading),
          })
        },
        (error: unknown) => {
          if (mine !== generation) return
          publish({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
        },
      )
    },
    dispose() {
      generation += 1
      current = undefined
      listeners.clear()
    },
  }
}

/**
 * 一处座席要印的那一行。
 *
 * 读数那一行拆成「词 + 数」两截：词是词表里的工具词，数从记录现算，数字那一截走等宽并
 * 带 `tabular-nums`。读不回来时印的是一个整句，那就是 `reason` 那一支。
 */
export type SeatLine =
  | { readonly kind: 'count'; readonly word: typeof READY_WORD | typeof SHELVED_WORD; readonly count: number }
  | { readonly kind: 'reason'; readonly text: string }

/**
 * 页脚徽标要印的那枚数：`可开工 N`。
 *
 * 记录读不回来（口子没接上、取数失败、还没有会话）时什么都不画——这枚数印的是记录里的
 * 事实，编不出来。记录在、但一份都读不动（四份来源全 `unusable`）时同样什么都不画：
 * 那种工作区上 `0` 是编出来的，浮层会说清是哪一档。
 * @param reading - 此刻那一份读数。
 * @returns 那一行；不该画的时候是 `null`。
 */
export function readyBadgeLine(reading: SeatReading): SeatLine | null {
  if (reading.phase !== 'ok') return null
  if (reading.recordUnusable) return null
  return { kind: 'count', word: READY_WORD, count: reading.project.columns.ready.length }
}

/**
 * 浮层上那一句：有事才说一句。
 *
 * 按这一次读的结局分五路：读不回来印那句原因；读成功但四份来源全 `missing`（这个工作区里
 * 压根没有记录）印一句原因；读成功但四份来源全 `unusable`（记录在、读不动）印**另一句**
 * 原因——「读不动」不是「没有」，两档不混用；读成功、有记录、有节点等待处理印 `等待处理 N`；
 * 其余（有记录、没有等待处理的）**不画**——那一枚数与页脚徽标说的是同一件事，同一件事不说
 * 两遍。还在读的时候也不画。
 * @param reading - 此刻那一份读数。
 * @returns 那一句；不该画的时候是 `null`。
 */
export function noticeLine(reading: SeatReading): SeatLine | null {
  if (reading.phase === 'failed') return { kind: 'reason', text: reading.message }
  if (reading.phase !== 'ok') return null
  /* 这个工作区里没有记录：这一句只有浮层说得出来——徽标那一枚数在空记录上也是 `可开工 0`。 */
  if (reading.recordAbsent) return { kind: 'reason', text: NO_RECORD }
  /* 记录在、一份都读不动：说「读不动」，徽标那一处不画数。 */
  if (reading.recordUnusable) return { kind: 'reason', text: UNUSABLE_RECORD }
  const shelved = reading.project.columns.shelved.length
  if (shelved > 0) return { kind: 'count', word: SHELVED_WORD, count: shelved }
  return null
}

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

/* ---- 四处座席各自的样子 -------------------------------------------------- */

/** 两处告示状座席共同拿到的几样。 */
interface NoticeProps {
  /** 那条共用的读数（`inject` 递进来）。 */
  readonly reading: SeatReadings
  /** 座席标准 props：会话清单。 */
  readonly useSessions?: unknown
}

/** 数字那一截的字体：词表说一切数字走等宽，且带 `tabular-nums`。 */
const NUMBER_STYLE: React.CSSProperties = {
  fontFamily: 'var(--ds-font-family-code, monospace)',
  fontVariantNumeric: 'tabular-nums',
}

/** 一行里的那几个孩子：词、一个空格、数字那一截。 */
function lineChildren(line: SeatLine): React.ReactNode[] {
  if (line.kind === 'reason') return [line.text]
  return [line.word, ' ', React.createElement('span', { style: NUMBER_STYLE }, String(line.count))]
}

/** 一行的整句读法：印在 `title` / `aria-label` 上，也是画不出来时留给读屏的那句话。 */
function lineLabel(line: SeatLine): string {
  return line.kind === 'reason' ? line.text : `${line.word} ${String(line.count)}`
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

/** 页脚那枚徽标的样子：值只走 DSH 自己的令牌，这一格住在侧栏脚下，别处不自造颜色。 */
function badgeStyle(wide: boolean): React.CSSProperties {
  return {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 2px',
    padding: wide ? '5px 8px' : '4px 6px',
    font: 'inherit',
    fontSize: '12.5px',
    lineHeight: '18px',
    whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-label-secondary)',
    background: 'var(--dsw-alias-bg-layer-3)',
    border: '0.5px solid var(--dsw-alias-border-l2)',
    borderRadius: 'var(--dsw-radius-sm, 8px)',
  }
}

/** 浮层那一句的样子：纯提示，所以自己把指针事件关掉，底下那一层照旧点得着。 */
const NOTICE_STYLE: React.CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: '16px',
  transform: 'translateX(-50%)',
  pointerEvents: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  maxWidth: 'calc(100% - 32px)',
  padding: '5px 10px',
  font: 'inherit',
  fontSize: '13px',
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-overlay)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: 'var(--dsw-radius-md, 10px)',
}

/**
 * 页脚那枚徽标：一枚从记录读出来的数，只读。
 *
 * 记录读不回来、或记录在却一份都读不动时，它整个不画——一枚没有来处的数不如不印。
 */
function ReadyBadge(props: NoticeProps & { readonly wide?: boolean }): React.ReactElement | null {
  const reading = useSeatReading(props.reading, useCurrentSessionId(props.useSessions))
  const line = readyBadgeLine(reading)
  if (line === null) return null
  return React.createElement(
    'span',
    {
      style: badgeStyle(props.wide === true),
      title: lineLabel(line),
      'aria-label': lineLabel(line),
      'data-pathfinder': READY_BADGE_ID,
    },
    ...lineChildren(line),
  )
}

/**
 * 浮层上那一句：有事才说一句——读不回来的原因、这个工作区里没有记录、记录读不动、或者
 * `等待处理 N` 这几档才画；有记录、也没有等待处理的时候不画（那枚数页脚徽标已经印了）。
 *
 * 那一层是穿透的，所以这一条常驻、却不挡路。
 */
function PendingNotice(props: NoticeProps): React.ReactElement | null {
  const reading = useSeatReading(props.reading, useCurrentSessionId(props.useSessions))
  const line = noticeLine(reading)
  if (line === null) return null
  return React.createElement(
    'div',
    {
      style: NOTICE_STYLE,
      role: 'status',
      'aria-label': lineLabel(line),
      'data-pathfinder': PENDING_NOTICE_ID,
    },
    ...lineChildren(line),
  )
}

/** 一处告示状座席订阅那一刻的读数，顺手把会话递给那份读数源。 */
function useSeatReading(readings: SeatReadings, sessionId: string | undefined): SeatReading {
  const state = React.useSyncExternalStore(readings.subscribe, readings.getSnapshot, readings.getSnapshot)
  React.useEffect(() => { readings.attach(sessionId) }, [readings, sessionId])
  return state
}

/** 座席标准 props 里那一条会话：两处告示状座席都按它挑。 */
function useCurrentSessionId(useSessions: unknown): string | undefined {
  return currentSessionOf(sessionsSnapshotOf(useSessions))
}

/* ---- 把四处挂上去 -------------------------------------------------------- */

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
 * 把调度中心四处接到各自的槽位上。
 *
 * 四条注册做在同一趟里，四个摘除器交给同一条 `effect` 的清理函数；清理那一趟的次序是
 * 先撤注册、再摘两张样式标签——组件随撤注册卸载，标签随后收走，反过来会让还在画的
 * 组件裸奔一瞬。
 *
 * 服务用动态的 `ctx.inject(['slots'], …)` 等（照设置那一节的写法）：取不到 `slots` 就
 * 安静地不做，这一层从不把插件的 `apply` 弄挂，也不把自己卡在待装状态。
 *
 * 卸载的归属分两种上下文：真 Cordis 的上下文都带 `effect`，清理挂在它上面，随插件卸载
 * 跑（完成判定第 2 条要的那一趟）。没有 `effect` 的上下文只有替身长这样：那种上下文上
 * `ctx.inject` 的回调晚一个微任务才跑，调用点拿到的返回值必然是 `undefined`，所以这一层
 * 不往调用点交回什么——替身上那四条注册没有卸载通知可归，随那个上下文一起走。
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
        const readings = createSeatReadings(api.port)
        const nav = createSessionNav(ctx)
        const serve = (): (() => void) => {
          const disposers = contribute(slots, api, readings, nav)
          return () => {
            for (const dispose of disposers.reverse()) dispose()
            readings.dispose()
            dropStyles()
          }
        }
        const effect = (owner as EffectOwner).effect
        if (typeof effect === 'function') effect.call(owner, serve, 'dsh-pathfinder: seats')
        /* 没有 `effect` 的上下文：这里没人替它管卸载，`serve()` 交回的那一手也无处可交
         * ——调用点拿到的只会是 `undefined`（`ctx.inject` 的回调晚一个微任务才跑）。四条
         * 注册照挂，卸载随这个上下文走。 */
        else serve()
      } catch (error) {
        report('调度中心那四处没挂上', error)
      }
    })
  } catch (error) {
    report('调度中心那四处没挂上', error)
  }
}

/**
 * 四条注册，每条各挡在自己的 `try` 里。
 *
 * 一条挂不上（比如同一个 id 已经在册）不该把另外三条一起带走：那些位置照样是该露面的，
 * 而重复注册那一下会抛在槽位登记处的通知里，React 自己的订阅也在那条通知上——那个抛
 * 必须停在这一层。
 * @param slots - `slots` 服务。
 * @param api - 面板。
 * @param readings - 两处告示状座席共用的那份读数。
 * @param nav - 卡上那一下的去处：交给中央栏那一格。
 * @returns 收到的那几个摘除器，次序就是注册的次序。
 */
function contribute(slots: SlotsService, api: PathfinderPanelApi, readings: SeatReadings, nav: SessionNav): (() => void)[] {
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
    inject: () => ({ port: api.port, prefs: api.prefs, openSession: nav.open }),
  }, api.Panel)))
  put('页脚徽标', () => slots.inject?.('sidebar.footer.action', () => slots.register?.({
    name: 'sidebar.footer.action',
    id: READY_BADGE_ID,
    order: FOOTER_ORDER,
    inject: () => ({ reading: readings }),
  }, ReadyBadge)))
  put('浮层提示', () => slots.inject?.('shell.overlay', () => slots.register?.({
    name: 'shell.overlay',
    id: PENDING_NOTICE_ID,
    order: NOTICE_ORDER,
    inject: () => ({ reading: readings }),
  }, PendingNotice)))
  return disposers
}

/** 一条警告；这四处没挂上不该静悄悄。 */
function report(what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  // eslint-disable-next-line no-console -- 装配失败必须留下一条可查的痕迹
  console.warn(`dsh-pathfinder: ${what}：${message}`)
}