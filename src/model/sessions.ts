/**
 * 会话笔记的读数：每一格该让读者去哪条会话。
 *
 * 进去的是宿主半身原样搬回来的那一层笔记——文件名照旧、内容照旧。哪份文件算笔记、它属于
 * 哪一格（文件名本身就是节点身份）、一格开过好几条时该看哪条，都在这里判；解不动的那一份
 * 跳过那一格，其余照读——那一格在这台机器上就没有会话可去，面板照「没有」画。
 */

/** 一份笔记的文件名后缀：文件名本身就是节点身份。 */
const NOTE_SUFFIX = '.json'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function refsOf(note: Record<string, unknown>, kind: 'discussion' | 'run'): readonly unknown[] {
  const list = note[kind]
  return Array.isArray(list) ? list : []
}

/**
 * 一份笔记里最近开过的那条会话。
 *
 * 两类各按自己的时刻比：`at` 是记录自己写的那串时刻文本，两边同一种写法，直接按文本比。
 * 时刻一样（或两处都没写）时，跑这一格的那条压过讨论的那条：同一刻开的两条里，读者要
 * 找的是眼下这一格在做的那条。
 */
export function latestSessionOf(note: unknown): string | undefined {
  const held = asRecord(note)
  if (held === undefined) return undefined
  let best: { readonly session: string; readonly at: string; readonly rank: number } | undefined
  for (const [rank, kind] of [[1, 'run'], [0, 'discussion']] as const) {
    for (const entry of refsOf(held, kind)) {
      const ref = asRecord(entry)
      if (ref === undefined) continue
      const session = ref.session
      if (typeof session !== 'string' || session.length === 0) continue
      const at = typeof ref.at === 'string' ? ref.at : ''
      if (best === undefined || at > best.at || (at === best.at && rank > best.rank)) {
        best = { session, at, rank }
      }
    }
  }
  return best?.session
}

/**
 * 一层笔记读成读数：键是节点身份，值是该看的那条会话。
 */
export function readSessions(notes: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [name, raw] of Object.entries(notes)) {
    if (!name.endsWith(NOTE_SUFFIX)) continue
    const nodeId = name.slice(0, -NOTE_SUFFIX.length)
    if (nodeId.length === 0) continue
    let held: unknown
    try {
      held = JSON.parse(raw)
    } catch {
      continue
    }
    const session = latestSessionOf(held)
    if (session !== undefined) out[nodeId] = session
  }
  return out
}
