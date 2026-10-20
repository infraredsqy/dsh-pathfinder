/**
 * The field surface of the panel's own preferences section in the settings
 * document: field names, factory defaults, and a few value sets.
 *
 * Both sides read this file (the host builds `Config` from it, the browser
 * reads and writes the settings document by it), so the factory defaults are
 * written exactly once. The namespace is decided by the profile line, not
 * here.
 */

/** The per-column card count tier. */
export type InfoLevel = 'lean' | 'three' | 'full'

/** Ids of the six views; key names line up with the blueprint's two columns (`tab-*` / `pane-*`). */
export type ViewId = 'now' | 'detail' | 'notes' | 'wires' | 'issue' | 'config'

/**
 * The names of the fields in this section: the host schema's keys, the paths
 * of the write-back `set` calls, and the keys the browser half reads back are
 * all the same string, so it is written only here.
 */
export const PANEL_PREF_FIELDS = {
  sideWidth: 'sideWidth',
  infoLevel: 'infoLevel',
  defaultTab: 'defaultTab',
  showArchived: 'showArchived',
  showOtherStates: 'showOtherStates',
} as const

/** Lower bound of the wire column width on the detail's left, same tier as the blueprint. */
export const SIDE_MIN = 120

export const SIDE_MAX = 320

/** The width before any dragging. */
export const SIDE_DEFAULT = 176

/** The three info levels, ordered as the row of buttons in the settings page. */
export const INFO_LEVELS: readonly InfoLevel[] = ['lean', 'three', 'full']

/** The six views, ordered as the row of tabs. */
export const VIEW_IDS: readonly ViewId[] = ['now', 'detail', 'notes', 'wires', 'issue', 'config']

/**
 * The shape before anything has been recorded.
 *
 * The sidebar width has no row in the settings page — it is a dragged value,
 * absent from the blueprint's page too — but the value lives in this document
 * all the same, so it still gets a factory default here.
 */
export const PANEL_PREF_DEFAULTS = {
  sideWidth: SIDE_DEFAULT,
  infoLevel: 'three',
  defaultTab: 'now',
  showArchived: false,
  showOtherStates: false,
} as const