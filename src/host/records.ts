/**
 * 把工作区里那份记录读成一份读数：定位置、分页读、解析、原样收进边界形状。
 *
 * 取数只走宿主已有的工作区文件口子（按行分页读、列目录），一律只读。口子对一页有字节上限，
 * 超了那一页会被拒绝，所以这里是「一页一页取到 `eof`」，它拒了这一页就把行数减半重取。
 */
import { RECORD_DIR, RECORD_SOURCES } from './contract.ts'
import type { PathfinderReading, PathfinderSourceState } from './contract.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** 取数时按哪一套位置去读。 */
export interface PathfinderScope {
  /** 会话身份：工作区文件口子按它认路径。 */
  readonly sessionId: SessionId
  /** 要读的那个工作区根，绝对路径，记录从它往下找。 */
  readonly workspaceRoot: string
}

export interface WorkspaceDirectoryEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly size?: number
}

export interface WorkspaceDirectoryListing {
  readonly path: string
  readonly entries: readonly WorkspaceDirectoryEntry[]
  readonly truncated: boolean
}

export interface WorkspaceFilePage {
  /** 这一页的行，用 `\n` 连起来。 */
  readonly text: string
  /** 这一页有几行；`0` 表示起点已经越过文件末尾。 */
  readonly lines: number
  /** 这一页是否含最后一行。 */
  readonly eof: boolean
}

/**
 * 宿主工作区文件口子里这一步要用的那两个动作。两个都写成方法声明：真口子按会话身份解析
 * 路径，参数上的那点出入由方法位的宽松匹配兜住。
 */
export interface WorkspaceFilesPort {
  list(scope: PathfinderScope, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing>
  read(
    scope: PathfinderScope,
    path: string,
    range: { readonly offset?: number; readonly limit?: number },
    signal: AbortSignal,
  ): Promise<WorkspaceFilePage>
}

/** 每一份来源里装集合的那个顶层键，与记录自己的写法一致。 */
const COLLECTION_KEY = {
  nodes: 'nodes',
  cycles: 'cycles',
  instructions: 'instructions',
  issues: 'issues',
} as const

/** 口子在目标不存在时给的那一个码；只有它算「工作区里没有这一份」。 */
const NOT_FOUND = 'workspace-file/not-found'

/** 口子对一页的字节数另有上限：这一页超了它拒绝，不替我们截短。 */
const PAGE_TOO_LARGE = 'workspace-file/too-large'

/** 请求里的页行数超过口子自己那一档时，它给的那一个码。 */
const PAGE_LIMIT_REFUSED = 'gateway/bad-request'

/** 默认档被拒、又还没从哪一页学到口子那一档时的减半起点。 */
const SHRINK_FROM_LINES = 256

function isAbsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === NOT_FOUND
}

/**
 * 口子拒了这一页的两种说法：页的字节数超上限，或请求的行数超过它那一档。
 * 两种都只说明「这个页大小在它这儿过不去」，收小一档重取就是。
 */
function isPageRefused(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return error.code === PAGE_TOO_LARGE || error.code === PAGE_LIMIT_REFUSED
}

/** 记录把节点与问题池写成以身份为键的一层表；线路与指令写成一张清单。 */
function isMapLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 收一份集合：键名照记录，条目照抄字段；记录里还带着这里没列出来的字段时一并带过来，
 * 这一步不裁剪，也不替它补默认值。
 * @returns 形状对得上时给那份集合，对不上给 `undefined`（这一份算取不动）。
 */
function collect(key: keyof typeof COLLECTION_KEY, parsed: unknown): unknown {
  if (!isMapLike(parsed)) return undefined
  const value = parsed[COLLECTION_KEY[key]]
  if (key === 'cycles' || key === 'instructions') {
    if (!Array.isArray(value)) return undefined
    return value.map((item) => (isMapLike(item) ? { ...item } : undefined)).every((item) => item !== undefined)
      ? value.map((item) => ({ ...(item as Record<string, unknown>) }))
      : undefined
  }
  if (!isMapLike(value)) return undefined
  const out: Record<string, unknown> = {}
  for (const [id, item] of Object.entries(value)) {
    if (!isMapLike(item)) return undefined
    out[id] = { ...item }
  }
  return out
}

/**
 * 一页一页把一份文件取全，中间用 `\n` 接回去。
 *
 * 页大小先取口子自己那一档：请求里省掉 `limit`，它给默认档。它拒了这一页（字节数超它那一页
 * 的上限，或请求的行数超过它那一档）就把这一页的行数减半重取，一直收到整份读完；单行本身
 * 就超上限（收到一行也过不去）才是真的读不动，照抛给调用方判。
 *
 * @param port - 工作区文件口子。
 * @param scope - 这一次读的位置。
 * @param path - 工作区相对路径。
 * @param signal - 调用方取消。
 * @returns 整份文件的文本。
 */
export async function readWholeFile(
  port: WorkspaceFilesPort,
  scope: PathfinderScope,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  const pages: string[] = []
  let offset = 1
  // 这一页要几行：`undefined`＝口子默认档；被拒过之后就定在一个更小的档上，只减不增。
  let limit: number | undefined
  // 口子默认档一页给几行：不带 `limit` 的那一页成功时学到，被拒之后拿它减半，比凭空挑一档更贴它那一档。
  let defaultLines: number | undefined
  for (;;) {
    try {
      let page: WorkspaceFilePage
      if (limit === undefined) {
        page = await port.read(scope, path, { offset }, signal)
      } else {
        const range = { offset, limit }
        page = await port.read(scope, path, range, signal)
      }
      pages.push(page.text)
      if (limit === undefined && defaultLines === undefined) defaultLines = page.lines
      // 空页而还没到末尾：口子给了个它自己也不打算往前走的回复，收在这里，免得转不出来。
      if (page.eof || page.lines === 0) return pages.join('\n')
      offset += page.lines
    } catch (error) {
      if (!isPageRefused(error)) throw error
      const shrunk = Math.floor((limit ?? defaultLines ?? SHRINK_FROM_LINES) / 2)
      // 一行也过不去：这一份是真的取不动（例如整份记录压在一行里、那一行就超了上限），照抛。
      if (shrunk < 1) throw error
      limit = shrunk
    }
  }
}

/**
 * 读一个工作区里那份记录。
 *
 * 取不到的四份来源给空集合，读数照常返回：工作区里没有记录是一种正常读数，面板据此
 * 「什么都没发生」地画。真出错（列目录被拒、调用方取消）照抛，不在这里咽掉。
 * @param port - 工作区文件口子。
 * @param scope - 这一次读的位置。
 * @param signal - 调用方取消。
 * @returns 那个工作区里的记录，原样。
 */
export async function readReading(
  port: WorkspaceFilesPort,
  scope: PathfinderScope,
  signal: AbortSignal,
): Promise<PathfinderReading> {
  const recording = new Map<string, readonly WorkspaceDirectoryEntry[] | undefined>()
  const listDir = async (dir: string): Promise<readonly WorkspaceDirectoryEntry[] | undefined> => {
    const known = recording.get(dir)
    if (known !== undefined || recording.has(dir)) return known
    let entries: readonly WorkspaceDirectoryEntry[] | undefined
    try {
      entries = (await port.list(scope, dir, signal)).entries
    } catch (error) {
      if (!isAbsent(error)) throw error
      entries = undefined
    }
    recording.set(dir, entries)
    return entries
  }

  const sources: Record<keyof typeof RECORD_SOURCES, PathfinderSourceState> = {
    nodes: 'missing',
    cycles: 'missing',
    instructions: 'missing',
    issues: 'missing',
  }
  const reading = {
    workspaceRoot: scope.workspaceRoot,
    recordPath: RECORD_DIR,
    sources,
    nodes: {} as Record<string, never>,
    cycles: [] as never[],
    instructions: [] as never[],
    issues: {} as Record<string, never>,
  }

  // 记录那一层目录先列一次：列得到才算这个工作区里有记录，列不到就是「没有这份记录」。
  if ((await listDir(RECORD_DIR)) === undefined) return reading as PathfinderReading

  for (const key of Object.keys(RECORD_SOURCES) as (keyof typeof RECORD_SOURCES)[]) {
    const segments = RECORD_SOURCES[key].split('/')
    let found = true
    for (let depth = 0; depth < segments.length - 1 && found; depth++) {
      const dir = segments.slice(0, depth + 1).join('/')
      const entries = await listDir(dir)
      const child = segments[depth + 1]
      const last = depth + 1 === segments.length - 1
      found = entries?.some((entry) => entry.name === child && entry.type === (last ? 'file' : 'directory')) ?? false
    }
    if (!found) continue
    try {
      const text = await readWholeFile(port, scope, RECORD_SOURCES[key], signal)
      const collection = collect(key, JSON.parse(text))
      if (collection === undefined) {
        sources[key] = 'unusable'
        continue
      }
      if (key === 'nodes' || key === 'issues') Object.assign(reading[key], collection)
      else reading[key] = collection as never[]
      sources[key] = 'read'
    } catch (error) {
      // 取消照抛：调用方要的不是一份缺一半的读数。
      if (signal.aborted) throw error
      sources[key] = 'unusable'
    }
  }
  return reading as PathfinderReading
}