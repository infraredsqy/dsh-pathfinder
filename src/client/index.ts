/**
 * Entry of the browser-half plugin: mounts the panel as the service `ctx.pathfinderPanel`, then
 * wires up the settings section, the dispatch-center sidebar items, and the center-column cell.
 *
 * Readings arrive through the port; the panel only draws. The panel's own preferences come from
 * settings and are written back to settings.
 */
import * as React from 'react'
import { report } from './context.ts'
import { createPanelPort, type PanelPort } from './data.ts'
import { currentSessionOf, knownSessionsOf, registerSeats, sessionsSnapshotOf } from './mount.ts'
import { PathfinderPanel } from './panel.tsx'
import { createPrefsSource, type PrefsStore } from './prefs.ts'
import { dropSettingsStyle, registerSettingsSection } from './settings.tsx'
import { dropStyle, ensureStyle } from './styles.ts'
import type { WorkspaceSource } from './workspaces.ts'

/** The panel's identity: used as key by the center-column cell and as id by the sidebar row. */
export const PANEL_ID = 'pathfinder'

export const PANEL_TITLE = '寻路'

export const SERVICE_KEY = 'pathfinderPanel'

/**
 * The body of the panel's stylesheet, re-exported for the self-check fixture: `npm run
 * check:panel` measures tokens against values parsed from the panel DOM, so it must load this copy
 * from the bundle rather than fetch some other stylesheet.
 */
export { PANEL_CSS } from './styles.ts'

/** The settings section's identity, for callers and the self-check fixture to read against. */
export {
  SECTION_LABEL,
  SECTION_ORDER,
  SECTION_SLOT,
  SETTINGS_CSS,
  SETTINGS_NAMESPACE,
  SettingsSection,
} from './settings.tsx'

/** The identities of the two dispatch-center spots, for the self-check fixture to read against. */
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

/** Markers of the two injected stylesheets in the document: neither should remain after unmount. */
export { PANEL_STYLE_ID, SETTINGS_STYLE_ID } from './style-tags.ts'

export interface PathfinderPanelApi {
  readonly id: string
  readonly title: string
  /** The port for talking to the host: reads the four records, writes archive / restore / delete and the three policy numbers. */
  readonly port: PanelPort
  /** The port the panel uses to read and write settings; the settings page reads it too. */
  readonly prefs: PrefsStore
  /** The panel itself, passed directly as the second argument of `slots.register`. */
  readonly Panel: (props: PanelArgs) => React.ReactElement
}

/** What the panel receives: the port is bound at assembly time, sessions are passed in by the seat side. */
export interface PanelArgs {
  readonly port: PanelPort
  readonly sessionId?: string | undefined
  /** Which settings document holds the panel's own preferences; factory defaults apply when absent. */
  readonly prefs?: PrefsStore | undefined
  /** Where card clicks go: DSH's navigation gateway. Cards are inert without it. */
  readonly openSession?: ((target: string) => void) | undefined
  /** DSH's workspace list: candidates for the selector at the top of the panel. Nothing is pickable without it. */
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
  /* The two seats' unmount hangs on the `effect` in `mount.ts`: this line only registers them. */
  registerSeats(ctx, api, () => {
    dropStyle()
    dropSettingsStyle()
  })
}

/**
 * The component actually rendered by the seat side.
 *
 * It adds one thing over {@link PathfinderPanel}: the center-column cell sits at the root scope and
 * does not inject `sessionId`, so this layer picks the current one from the `useSessions` snapshot;
 * when the seat passes a `sessionId` itself, that one wins. The same snapshot also yields a roster
 * the panel uses to check whether a record's session exists on this machine.
 */
function Entry(props: PanelArgs & { readonly useSessions?: unknown }): React.ReactElement {
  ensureStyle()
  /* `useSessions` is a real hook: the snapshot is fetched unconditionally; only picking the session falls to `??`. */
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