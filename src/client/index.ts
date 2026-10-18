/**
 * 浏览器半身这一个插件的入口。
 *
 * 它交出去的是三样东西。
 *
 * 第一样是**一块一挂就能用的主面板**：面板、它的 id、那条与宿主说话的口子、以及面板读
 * 设置的那条口子装成一条服务 `ctx.pathfinderPanel`，谁要挂就照下面那几行挂：
 *
 * ```js
 * const panel = ctx.pathfinderPanel
 * ctx.slots.inject('main', () => ctx.slots.register(
 *   { name: 'main', key: panel.id, inject: () => ({ port: panel.port, prefs: panel.prefs }) },
 *   panel.Panel,
 * ))
 * ```
 *
 * 第二样是**设置里那一节**：`settings.section` 上的一条注册，它既是导航行，也是它打开的
 * 那一页（见 `settings.tsx`）。
 *
 * 第三样是**调度中心那四处挂载点**（见 `mount.ts`）：侧栏一项、页脚徽标、浮层提示与中央栏
 * 那一格。四处都由这一层挂，`mount.ts` 只管注册与卸载，两条样式表各留一条摘除口子给它的
 * 清理路径。
 *
 * 读数从口子上来，`src/model` 那套纯函数把它读成那一刻的读数，面板只负责画。面板自己那
 * 几个偏好从设置上来、也写回设置里去（`prefs.ts`），浏览器本地存储里不留键。
 *
 * 服务用动态的 `ctx.inject` 取（与这个部署里别的插件同一路写法），取不到就把服务照常装
 * 出去、口子留成「取不到」那一条——面板自己会说它读不出来，不会把整条插件卡在待装状态。
 *
 * @module dsh-pathfinder/client
 */
import * as React from 'react'
import { createPanelPort, type PanelPort } from './data.ts'
import { currentSessionOf, knownSessionsOf, registerSeats, sessionsSnapshotOf } from './mount.ts'
import { PathfinderPanel } from './panel.tsx'
import { createPrefsSource, type PrefsStore } from './prefs.ts'
import { dropSettingsStyle, registerSettingsSection } from './settings.tsx'
import { dropStyle, ensureStyle } from './styles.ts'

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

/** 设置那一节的身份，供调用方与自证夹具对着读。 */
export {
  SECTION_LABEL,
  SECTION_ORDER,
  SECTION_SLOT,
  SETTINGS_CSS,
  SETTINGS_NAMESPACE,
  SettingsSection,
} from './settings.tsx'

/**
 * 调度中心那四处的身份，供自证夹具对着读；`currentSessionOf` 与
 * `sessionsSnapshotOf` 是四处座席挑会话那一套，`knownSessionsOf` 是同一份快照交出的
 * 会话名册（卡上那一下的去处），`Entry` 用的是同一套。
 */
export {
  currentSessionOf,
  FOOTER_ORDER,
  knownSessionsOf,
  NOTICE_ORDER,
  PANEL_ORDER,
  PENDING_NOTICE_ID,
  READY_BADGE_ID,
  SEAT_LABEL,
  sessionsSnapshotOf,
} from './mount.ts'

/** 两张注入的样式表在文档里的记号：卸载之后 document 里不该剩下它们。 */
export { PANEL_STYLE_ID, SETTINGS_STYLE_ID } from './style-tags.ts'

/** 交出去的那条服务。 */
export interface PathfinderPanelApi {
  /** 面板的身份。 */
  readonly id: string
  /** 面板的名字。 */
  readonly title: string
  /** 与宿主说话的那条口子：读四份记录，写归档 / 复原 / 删除与三个策略数。 */
  readonly port: PanelPort
  /** 面板读设置、写设置的那条口子；设置页读的也是它。 */
  readonly prefs: PrefsStore
  /** 面板本体，直接交给 `slots.register` 的第二个参数。 */
  readonly Panel: (props: PanelArgs) => React.ReactElement
}

/** 面板拿到的几样：口子在装配时就绑好，会话由座席那一侧递进来。 */
export interface PanelArgs {
  /** 与宿主说话的那条口子。 */
  readonly port: PanelPort
  /** 读哪条会话所在的工作区。 */
  readonly sessionId?: string | undefined
  /** 面板自己的偏好住哪份设置文档；不给就按出厂那几条画。 */
  readonly prefs?: PrefsStore | undefined
  /** 卡上那一下的去处：DSH 那条导航口子。不给就点不动。 */
  readonly openSession?: ((target: string) => void) | undefined
}

/** 插件体：把面板装成一条服务，再把设置那一节与调度中心那四处接上去。 */
export function apply(ctx: unknown): void {
  const port = createPanelPort(ctx)
  const prefs = createPrefsSource()
  const api: PathfinderPanelApi = {
    id: PANEL_ID,
    title: PANEL_TITLE,
    port,
    prefs,
    Panel: Entry,
  }
  try {
    const provide = (ctx as { provide?: (key: string, value: unknown) => void } | null | undefined)?.provide
    if (typeof provide === 'function') provide.call(ctx, SERVICE_KEY, api)
  } catch (error) {
    report('面板这一格没装上去', error)
  }
  registerSettingsSection(ctx, prefs)
  /* 四处座席的卸载挂在 `mount.ts` 里那条 `effect` 上（真部署的上下文都带 `effect`）：
   * 这一行只负责把四处挂上去，它不交回任何东西，也没东西可接。 */
  registerSeats(ctx, api, () => {
    dropStyle()
    dropSettingsStyle()
  })
}

/**
 * 座席那一侧真正渲染的那个组件。
 *
 * 它比 {@link PathfinderPanel} 多一件事：会话身份。中央栏那一格是根作用域、不注入
 * `sessionId`，所以这一层从现成的 `useSessions` 快照里挑当前那一条；座席要是自己
 * 递了 `sessionId`，那个说话。同一份快照还交出一份名册：这台机器上此刻有哪些会话——
 * 卡上那条记录指向的会话在不在里面，面板拿它对。
 * @param props - 座席递过来的几样。
 * @returns 面板本体。
 */
function Entry(props: PanelArgs & { readonly useSessions?: unknown }): React.ReactElement {
  ensureStyle()
  /* `useSessions` 是真 hook：快照无条件取回来，挑哪条会话才轮到 `??`。 */
  const snapshot = sessionsSnapshotOf(props.useSessions)
  const sessionId = props.sessionId ?? currentSessionOf(snapshot)
  const knownSessions = React.useMemo(() => knownSessionsOf(snapshot), [snapshot])
  return React.createElement(PathfinderPanel, {
    port: props.port,
    sessionId,
    prefs: props.prefs,
    openSession: props.openSession,
    knownSessions,
  })
}

/** 一条警告；面板的装配出了岔子不该静悄悄。 */
function report(what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  // eslint-disable-next-line no-console -- 装配失败必须留下一条可查的痕迹
  console.warn(`dsh-pathfinder: ${what}：${message}`)
}