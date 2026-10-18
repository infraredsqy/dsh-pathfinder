/**
 * 两张注入的样式表在文档里的记号，以及「挂上去」与「摘下来」这两个动作。
 *
 * 两张表的正文各住在它自己那一份里（面板那一份在 `styles.ts`，设置那一节在
 * `settings.tsx`），正文归各自管；**记号与那两下动作住在这里**，理由只有一个：卸载
 * 要摘干净（完成判定第 2 条），而摘的那一处（`mount.ts` 的清理路径）不能把整份表身
 * 一起拖进来——它只要那两枚记号。
 *
 * 挂一次就够：同一份文档里重复挂只会多出一张同样的表。摘认那枚记号，与哪一次挂的
 * 无关——挂的时候没挂上、或者已经被谁摘过，摘这一下就当没有这回事，不抛。
 *
 * @module dsh-pathfinder/client/style-tags
 */

/** 面板那几张表的记号（`styles.ts` 挂的就是它）。 */
export const PANEL_STYLE_ID = 'dsh-pathfinder-panel-style'

/** 设置里那一节的记号（`settings.tsx` 挂的就是它）。 */
export const SETTINGS_STYLE_ID = 'dsh-pathfinder-settings-style'

/**
 * 把一张表挂进文档一次。
 * @param id - 这张表在文档里的记号。
 * @param css - 表身。
 */
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

/**
 * 把一张表从文档里摘掉。
 *
 * 摘不下来不该把卸载本身弄挂：卸载还在往下走（这一处之后还有别的要还回去），
 * 一张摘不掉的表比一条半路断掉的清理路径轻。
 * @param id - 这张表在文档里的记号。
 */
export function dropStyleTag(id: string): void {
  try {
    document.getElementById(id)?.remove()
  } catch (error) {
    /* 见上。 */
  }
}