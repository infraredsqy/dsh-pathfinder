/**
 * 宿主半身搬会话笔记那一手：这个工作区里每一格开过哪些会话，笔记住的那层目录。
 *
 * 会话身份是这台机器自己的事，所以它住在记录库自己那层目录里、按节点分的小份笔记上。
 * 取数走与四份记录同一条口子，只读；这一手只把每份文件原样搬回去——哪份算笔记、它属于
 * 哪一格、该看哪条，是读数判断，归模型层那套纯函数。取不到这层目录的时候交回空的一份，
 * 读数照常给。
 */
import { RECORD_SESSIONS } from './contract.ts'
import { isAbsent, readWholeFile, type PathfinderScope, type WorkspaceFilesPort } from './records.ts'

/** 面板搬会话笔记拿到的那一份。 */
export interface PathfinderSessionsReading {
  /** 这次读的绝对工作区根，与四份记录那份读数同一个名字。 */
  readonly workspaceRoot: string
  /** 笔记住的那一层目录，工作区相对。 */
  readonly recordPath: string
  /**
   * 这一层笔记的结局：`read` 是搬到了，`missing` 是这个工作区里压根没有这一层，两种都按
   * 「一条会话都没有」画。
   */
  readonly state: 'read' | 'missing'
  /** 这一层里每份文件的原样：键是文件名，值是文件里那串字；哪份算笔记由读数判。 */
  readonly notes: Readonly<Record<string, string>>
}

/**
 * 把一个工作区里那一层会话笔记原样搬回来。
 *
 * 一份文件搬不动（页过不去、列到了却读不出）时跳过那一份：那一格有没有会话由读数对着搬到的
 * 部分判，别的份照搬。
 */
export async function readSessionNotes(
  port: WorkspaceFilesPort,
  scope: PathfinderScope,
  signal: AbortSignal,
): Promise<PathfinderSessionsReading> {
  const reading = { workspaceRoot: scope.workspaceRoot, recordPath: RECORD_SESSIONS }
  let entries: readonly { readonly name: string; readonly type: string }[]
  try {
    entries = (await port.list(scope, RECORD_SESSIONS, signal)).entries
  } catch (error) {
    if (!isAbsent(error)) throw error
    return { ...reading, state: 'missing', notes: {} }
  }
  const notes: Record<string, string> = {}
  for (const entry of entries) {
    if (entry.type !== 'file') continue
    try {
      notes[entry.name] = await readWholeFile(port, scope, `${RECORD_SESSIONS}/${entry.name}`, signal)
    } catch {
      /* 这一份搬不动：少搬一份，读数那头按「没有」处置。 */
    }
  }
  return { ...reading, state: 'read', notes }
}
