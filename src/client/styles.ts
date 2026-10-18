/**
 * 面板自己的那几张样式表。
 *
 * 表身由构建期从 `mock/` 那几份模块表里取进来，蓝本那一份是唯一来源，这里不摆第二份抄本；DSH
 * 主题值那一份不进来，真面板里那些别名由外壳给。
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