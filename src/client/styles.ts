/**
 * The panel's own stylesheets.
 *
 * The sheet body is pulled in at build time from the module sheets in `mock/`; the blueprint copy is
 * the single source, so no second copy lives here. DSH theme values are not bundled: the real
 * panel's aliases are provided by the shell.
 */
import css from 'virtual:pf-styles'
import { PANEL_STYLE_ID, dropStyleTag, ensureStyleTag } from './style-tags.ts'

export const PANEL_CSS: string = css

export function ensureStyle(): void {
  ensureStyleTag(PANEL_STYLE_ID, PANEL_CSS)
}

export function dropStyle(): void {
  dropStyleTag(PANEL_STYLE_ID)
}