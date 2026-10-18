/**
 * 面板自己的那几张样式表。
 *
 * 表身由构建期从 `mock/` 那几份模块表里取进来（`mock/tokens.css` 这份共同地面，
 * 加上用到的模块表），随产物一起走——蓝本那一份是唯一来源，这里不摆第二份抄本。
 * DSH 主题值那一份（`mock/theme.css`）不进来：真面板里那些别名由外壳给。
 *
 * 挂一次就够：同一份文档里重复挂只会多出一张同样的表。摘的那一条口子留给卸载：这一层
 * 挂上去的表，插件退场时由清理路径（`mount.ts`）经 {@link dropStyle} 摘掉。
 *
 * @module dsh-pathfinder/client/styles
 */
import css from 'virtual:pf-styles'
import { PANEL_STYLE_ID, dropStyleTag, ensureStyleTag } from './style-tags.ts'

/** 这一张表的正文，构建期定下来。 */
export const PANEL_CSS: string = css

/** 把面板那几张表挂进文档一次。 */
export function ensureStyle(): void {
  ensureStyleTag(PANEL_STYLE_ID, PANEL_CSS)
}

/** 把面板那几张表从文档里摘掉；没挂上时这一下当没有这回事。 */
export function dropStyle(): void {
  dropStyleTag(PANEL_STYLE_ID)
}