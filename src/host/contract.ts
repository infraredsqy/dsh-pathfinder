/**
 * 宿主半身与浏览器半身之间的类型契约：四份记录文件里原有字段的直通副本，
 * 一个字段都不改名、不做单位换算、不折算时刻。
 *
 * 路径一律工作区相对：绝对根由宿主半身按会话身份解析，本模块里没有一台机器的路径。
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** 记录所在的那一层目录，工作区相对。 */
export const RECORD_DIR = '.pf'

/** 四份来源的工作区相对位置。 */
export const RECORD_SOURCES = {
  /** `ideas.json` 的 `nodes`，键是节点身份。 */
  nodes: `${RECORD_DIR}/ideas.json`,
  /** `state.json` 的 `cycles`，每条线自己带着走过的 `path`。 */
  cycles: `${RECORD_DIR}/state.json`,
  /** `instructions.json` 的 `instructions`。 */
  instructions: `${RECORD_DIR}/instructions.json`,
  /** `issues/issues.json` 的 `issues`，键是问题身份。 */
  issues: `${RECORD_DIR}/issues/issues.json`,
} as const

/**
 * 会话笔记住的那一层目录，工作区相对：一格一份小文件，文件名就是节点身份。
 *
 * 会话身份是这台机器自己的事，不跟着记录本体走——换一台机器、新克隆一份记录，
 * 这一层目录都不跟着走，面板据此把那几格读作「这台机器上没有去处」。
 */
export const RECORD_SESSIONS = `${RECORD_DIR}/meta/sessions`

/** 一份来源这一趟的取值结局。 */
export type PathfinderSourceState =
  /** 取到了，集合里是它的内容。 */
  | 'read'
  /** 工作区里没有这一份（目录里没列到它）。 */
  | 'missing'
  /** 列到了、读不动：不是可读的 JSON 文本，或者中途出错。 */
  | 'unusable'

/** 记录里的节点：字段照抄记录，取值类型照记录里实际出现的那一种写。 */
export interface PathfinderNode {
  readonly title?: string
  readonly description?: string
  readonly tags?: readonly string[]
  /** 跑这一格的模式，例如 `auto`／`manual`／`checkpoint`。 */
  readonly mode?: string
  /** 这一格现在的判定：`completed`／`shelved`／`todo`。 */
  readonly status?: string
  /** 记录把它写成文本，照抄。 */
  readonly weight?: string
  readonly dsh_session?: string
  /** 前置节点的身份清单；每一条是一条依赖边。 */
  readonly dependencies?: readonly string[]
  readonly created_at?: string | null
  readonly completed_at?: string | null
  readonly updated_at?: string | null
  /** 记录里还带着别的字段时一并带过来：这一步不裁剪。 */
  readonly [field: string]: unknown
}

/** 线路上走过的一步。 */
export interface PathfinderStep {
  readonly node?: string
  readonly started_at?: string | null
  readonly ended_at?: string | null
  readonly result?: string | null
  /** 记录里还带着别的字段时一并带过来。 */
  readonly [field: string]: unknown
}

/** 线路上握着某个节点的那一条。 */
export interface PathfinderHolding {
  readonly id?: string
  readonly since?: string | null
  /** 记录里还带着别的字段时一并带过来。 */
  readonly [field: string]: unknown
}

/** 记录里的一条线路。 */
export interface PathfinderCycle {
  readonly id?: string
  readonly title?: string
  readonly status?: string
  readonly tags?: readonly string[]
  readonly created_at?: string | null
  readonly updated_at?: string | null
  /** 这条线挂着的策略：键与值都照记录。 */
  readonly policies?: Readonly<Record<string, unknown>>
  /** 谁在做它：写成一份握着清单的那一种。 */
  readonly holding?: readonly PathfinderHolding[]
  /** 谁在做它：写成单值的那一种。 */
  readonly current_node?: string | null
  /** 与 `current_node` 配对的握住时刻，记录里原样的那串文本。 */
  readonly current_started_at?: string | null
  /** 这条线走过的步，按记录里的顺序。 */
  readonly path?: readonly PathfinderStep[]
  /** 记录里还带着别的字段时一并带过来。 */
  readonly [field: string]: unknown
}

/** 记录里的一条指令。 */
export interface PathfinderInstruction {
  readonly id?: string
  readonly text?: string
  readonly scope?: string
  /** 这条指令落在哪一类对象上。 */
  readonly target?: string
  readonly state?: string
  /** 绑到哪条线路；没绑就是 `null`。 */
  readonly cycle?: string | null
  /** 绑到哪个节点；没绑就是 `null`。 */
  readonly node?: string | null
  /** 第几轮生效；没记就是 `null`。 */
  readonly round?: number | null
  /** 哪一拍生效；没记就是 `null`。 */
  readonly stage?: number | null
  readonly said_by?: string
  readonly at?: string | null
  readonly resolved_at?: string | null
  readonly resolved_by?: string | null
  readonly superseded_by?: string | null
  readonly note?: string | null
  /** 走几格之后停下；记录里只有少数条目带这个数。 */
  readonly stop_after_nodes?: number | null
  readonly applied_rounds?: readonly unknown[]
  readonly applied?: readonly unknown[]
  /** 记录里还带着别的字段时一并带过来。 */
  readonly [field: string]: unknown
}

/** 问题池里的一条问题。 */
export interface PathfinderIssue {
  readonly id?: string
  readonly title?: string
  /** 严重程度档位。 */
  readonly severity?: string | null
  readonly status?: string
  readonly module?: string
  /** 谁报的。 */
  readonly source?: string | null
  /** 判决。 */
  readonly decision?: string | null
  readonly discovered?: string | null
  readonly updated_at?: string | null
  readonly check_count?: number | null
  readonly files?: readonly string[]
  readonly functions?: readonly string[]
  readonly description?: string | null
  readonly suggestion?: string | null
  readonly reason?: string | null
  readonly plan_path?: string | null
  /** 记录里还带着别的字段时一并带过来。 */
  readonly [field: string]: unknown
}

/** 一次取数的结果。 */
export interface PathfinderReading {
  /** 这份读数取自哪个工作区根——调用方点名的那一个，没点名就是这条会话自己那个。绝对路径。 */
  readonly workspaceRoot: string
  /** 记录所在的那一层目录，工作区相对。 */
  readonly recordPath: string
  /**
   * 四份来源各自这一趟的结局，键是 {@link RECORD_SOURCES} 的键。
   * 取不到的那几份在下面给空集合：面板照「记录里没有」画。
   */
  readonly sources: Readonly<Record<keyof typeof RECORD_SOURCES, PathfinderSourceState>>
  /** 键就是节点身份。 */
  readonly nodes: Readonly<Record<string, PathfinderNode>>
  readonly cycles: readonly PathfinderCycle[]
  readonly instructions: readonly PathfinderInstruction[]
  /** 键就是问题身份。 */
  readonly issues: Readonly<Record<string, PathfinderIssue>>
}

/** 取数时可以带的东西。 */
export interface PathfinderReadOptions {
  readonly signal?: AbortSignal
}

/**
 * 宿主半身交给浏览器半身的那条服务：给它一条会话身份与一个工作区根，它把那个工作区里的
 * 记录读成一份读数。记录不在就是空读数（四份来源全 `missing`、集合全空）。
 *
 * 工作区根由调用方点名，挑哪一个读哪一个；空字符串是「没挑」，那时候按会话身份解析。
 */
export interface PathfinderRecords {
  /**
   * @param sessionId - 会话身份；工作区文件口子按它认路径，`workspaceRoot` 空着时也由它定根。
   * @param workspaceRoot - 要读的那个工作区根，绝对路径；空字符串＝这条会话自己那个根。
   * @param options - 可选的取消信号。
   * @returns 那个工作区里的记录，原样。
   */
  read(sessionId: SessionId, workspaceRoot: string, options?: PathfinderReadOptions): Promise<PathfinderReading>
}