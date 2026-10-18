/**
 * 宿主半身读会话笔记那一手：这个工作区里每一格开过哪些会话。
 *
 * 会话身份是这台机器自己的事，所以它住在记录库自己那层目录里、按节点分的小份笔记上。
 * 取数走与四份记录同一条口子，只读；取不到的时候交回一份空清单，读数照常返回。
 */
import { RECORD_SESSIONS } from './contract.ts'
import { readWholeFile, type PathfinderScope, type WorkspaceFilesPort } from './records.ts'

/** 口子在目标不存在时给的那一个码；只有它算「这个工作区里没有笔记」。 */
const NOT_FOUND = 'workspace-file/not-found'

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
 * 一格的那份笔记里最近开过的那条会话。
 *
 * 两类各按自己的时刻比：`at` 是记录自己写的那串时刻文本，两边同一种写法，直接按文本比。
 * 时刻一样（或两处都没写）时，跑这一格的那条压过讨论的那条：同一刻开的两条里，读者要
 * 找的是眼下这一格在做的那条。
 * @param note - 解出来的一格笔记；形状不对时什么也解不出。
 * @returns 会话身份；一条都解不出来就是 `undefined`。
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

/** 面板读会话笔记拿到的那一份。 */
export interface PathfinderSessionsReading {
  /** 记录所在的那个工作区根，绝对路径。 */
  readonly project: string
  /** 笔记住的那一层目录，工作区相对。 */
  readonly recordPath: string
  /**
   * 这一层笔记的结局：`read` 是列到了（有几格没解出会话也算它），`missing` 是这个工作区里
   * 压根没有这一层，两种都按「一条会话都没有」画。
   */
  readonly state: 'read' | 'missing'
  /** 每一格最近开过的那条会话，键是节点身份；一条都没读出来就是空的一份。 */
  readonly sessions: Readonly<Record<string, string>>
}

function isAbsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === NOT_FOUND
}

/**
 * 读一个工作区里每一格的会话笔记。
 *
 * 一份笔记读不动（半截 JSON、页过不去）时跳过那一格：那一点在这台机器上就没有会话可去，
 * 面板照「没有」画，别的格照读。
 * @param port - 工作区文件口子。
 * @param scope - 这一次读的位置。
 * @param signal - 调用方取消。
 * @returns 每一格最近开过的那条会话，连同这一层的结局。
 */
export async function readSessionNotes(
  port: WorkspaceFilesPort,
  scope: PathfinderScope,
  signal: AbortSignal,
): Promise<PathfinderSessionsReading> {
  const reading = { project: scope.workspaceRoot, recordPath: RECORD_SESSIONS }
  let entries: readonly { readonly name: string; readonly type: string }[]
  try {
    entries = (await port.list(scope, RECORD_SESSIONS, signal)).entries
  } catch (error) {
    if (!isAbsent(error)) throw error
    return { ...reading, state: 'missing', sessions: {} }
  }
  const sessions: Record<string, string> = {}
  for (const entry of entries) {
    if (entry.type !== 'file' || !entry.name.endsWith(NOTE_SUFFIX)) continue
    const nodeId = entry.name.slice(0, -NOTE_SUFFIX.length)
    if (nodeId.length === 0) continue
    try {
      const text = await readWholeFile(port, scope, `${RECORD_SESSIONS}/${entry.name}`, signal)
      const session = latestSessionOf(JSON.parse(text))
      if (session !== undefined) sessions[nodeId] = session
    } catch (error) {
      /* 这一份读不动：这一格按「没有会话」画。 */
    }
  }
  return { ...reading, state: 'read', sessions }
}