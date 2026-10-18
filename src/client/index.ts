/**
 * 浏览器半身这一个插件的入口：把面板装成一条服务 `ctx.pathfinderPanel`，再把设置里那一节与
 * 调度中心的侧栏项、中央栏那一格接上去。
 *
 * 读数从口子上来，面板只负责画；面板自己那几个偏好从设置上来、也写回设置里去。
 */
import * as React from 'react'
import { createPanelPort, type PanelPort } from './data.ts'
import { currentSessionOf, knownSessionsOf, registerSeats, sessionsSnapshotOf } from './mount.ts'
import { PathfinderPanel } from './panel.tsx'
import { createPrefsSource, type PrefsStore } from './prefs.ts'
import { dropSettingsStyle, registerSettingsSection } from './settings.tsx'
import { dropStyle, ensureStyle } from './styles.ts'
import type { WorkspaceSource } from './workspaces.ts'

/** 面板的身份：中央栏那一格用它作 key，侧栏那一排用它作 id。 */
export const PANEL_ID = 'pathfinder'

export const PANEL_TITLE = '寻路'

export const SERVICE_KEY = 'pathfinderPanel'

/**
 * 面板那一份样式的正文。这里再交出一份是给自证夹具：`npm run check:panel` 要按面板 DOM 上解析
 * 出来的值量那些令牌，就得挂着产物里这一份，而不是另取一份样式。
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

/** 调度中心那两处的身份，供自证夹具对着读。 */
export {
  createWorkspaceNav,
  currentSessionOf,
  knownSessionsOf,
  PANEL_ORDER,
  SEAT_LABEL,
  sessionsSnapshotOf,
} from './mount.ts'

export { bucketOf, NO_WORKSPACES, workspacesAt } from './workspaces.ts'
export type { WorkspaceChoice, WorkspaceSnapshot, WorkspaceSource } from './workspaces.ts'

/** 两张注入的样式表在文档里的记号：卸载之后 document 里不该剩下它们。 */
export { PANEL_STYLE_ID, SETTINGS_STYLE_ID } from './style-tags.ts'

export interface PathfinderPanelApi {
  readonly id: string
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
  readonly port: PanelPort
  readonly sessionId?: string | undefined
  /** 面板自己的偏好住哪份设置文档；不给就按出厂那几条画。 */
  readonly prefs?: PrefsStore | undefined
  /** 卡上那一下的去处：DSH 那条导航口子。不给就点不动。 */
  readonly openSession?: ((target: string) => void) | undefined
  /** DSH 那份工作区清单：面板顶上那枚选择器的候选。不给就一个都挑不了。 */
  readonly workspaces?: WorkspaceSource | undefined
}

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
  /* 两处座席的卸载挂在 `mount.ts` 里那条 `effect` 上：这一行只负责把它们挂上去。 */
  registerSeats(ctx, api, () => {
    dropStyle()
    dropSettingsStyle()
  })
}

/**
 * 座席那一侧真正渲染的那个组件。
 *
 * 它比 {@link PathfinderPanel} 多一件事：中央栏那一格是根作用域、不注入 `sessionId`，所以这一层
 * 从 `useSessions` 快照里挑当前那一条；座席要是自己递了 `sessionId`，那个说话。同一份快照还交出
 * 一份名册，面板拿它对记录里那条会话在不在本机。
 * @param props - 座席递过来的几样。
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
    workspaces: props.workspaces,
  })
}

/** 一条警告；面板的装配出了岔子不该静悄悄。 */
function report(what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  // eslint-disable-next-line no-console -- 装配失败必须留下一条可查的痕迹
  console.warn(`dsh-pathfinder: ${what}：${message}`)
}