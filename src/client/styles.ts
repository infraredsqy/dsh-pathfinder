/**
 * 面板自己的那几张样式表。
 *
 * 表身由构建期从 `mock/` 那几份模块表里取进来（`mock/tokens.css` 这份共同地面，
 * 加上用到的模块表），随产物一起走——蓝本那一份是唯一来源，这里不摆第二份抄本。
 * DSH 主题值那一份（`mock/theme.css`）不进来：真面板里那些别名由外壳给。
 *
 * 挂一次就够：同一份文档里重复挂只会多出一张同样的表。
 *
 * @module dsh-pathfinder/client/styles
 */
import css from 'virtual:pf-styles'

/** 这一张表的正文，构建期定下来。 */
export const PANEL_CSS: string = css

/** 这张表在文档里的记号。 */
const STYLE_ID = 'dsh-pathfinder-panel-style'

/** 把面板那几张表挂进文档一次。 */
export function ensureStyle(): void {
  try {
    if (document.getElementById(STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = PANEL_CSS
    document.head.appendChild(style)
  } catch (error) {
    /* 一张挂不上的表也比不上面板本身：挂不上就照没有样式画。 */
  }
}