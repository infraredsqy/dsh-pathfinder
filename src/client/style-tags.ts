/**
 * 两张注入的样式表在文档里的记号，以及「挂上去」与「摘下来」这两个动作。
 *
 * 记号与这两下动作住在这里、不和表身同住，图的是摘的那一处只要两枚记号，不必把整份表身一起
 * 拖进来。挂一次就够，摘认记号、与哪一次挂的无关；挂的时候没挂上或已经被谁摘过，摘这一下
 * 就不抛。
 */

/** 面板那几张表的记号。 */
export const PANEL_STYLE_ID = 'dsh-pathfinder-panel-style'

/** 设置里那一节的记号。 */
export const SETTINGS_STYLE_ID = 'dsh-pathfinder-settings-style'

export function ensureStyleTag(id: string, css: string): void {
  try {
    if (document.getElementById(id) !== null) return
    const style = document.createElement('style')
    style.id = id
    style.textContent = css
    document.head.appendChild(style)
  } catch (error) {
    /* 一张挂不上的表也比不上面板本身：挂不上就照没有样式画。 */
  }
}

export function dropStyleTag(id: string): void {
  try {
    document.getElementById(id)?.remove()
  } catch (error) {
    /* 摘不下来不该把卸载本身弄挂：这一处之后还有别的要还回去。 */
  }
}