/**
 * 宿主半身与浏览器半身之间的类型契约。
 *
 * 边界形状就是记录自己的形状：节点、线路、指令、问题池四份文件里**原有字段**的直通副本。
 * 这里一个字段都不改名、不做单位换算、不折算时刻——面板要用的读数全在这份记录里，
 * 需要怎么切（可开工、人闸、刻度）是拿到这份读数的下一步的事。
 *
 * 记录住在工作区自己的一层隐藏目录里，四份文件各管一件事；路径一律是**工作区相对**的，
 * 绝对根由宿主半身按会话身份解析（见 `PathfinderRecords`）。本模块里没有一台机器的路径。
 *
 * @module dsh-pathfinder/host/contract
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** 记录所在的那一层目录，工作区相对。 */
export const RECORD_DIR = '.pf'

/**
 * 四份来源的工作区相对位置：节点与线路、线路走过的步、指令、问题池。
 * 键名是这一步的四个读数面，值是记录里那一份文件的位置。
 */
export const RECORD_SOURCES = {
  /** 节点与线路：`ideas.json` 的 `nodes`，键是节点身份。 */
  nodes: `${RECORD_DIR}/ideas.json`,
  /** 走过的步：`state.json` 的 `cycles`，每条线自己带着走过的 `path`。 */
  cycles: `${RECORD_DIR}/state.json`,
  /** 指令：`instructions.json` 的 `instructions`。 */
  instructions: `${RECORD_DIR}/instructions.json`,
  /** 问题池：`issues/issues.json` 的 `issues`，键是问题身份。 */
  issues: `${RECORD_DIR}/issues/issues.json`,
} as const

/**
 * 会话笔记住的那一层目录，工作区相对：一格一份小文件，文件名就是节点身份。
 *
 * 会话身份是这台机器自己的事，所以它不住在记录本体上——换一台机器、新克隆一份记录，
 * 这一层目录都不跟着走（它挡在版本库外），面板据此把那几格读作「这台机器上没有去处」。
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
  /** 节点的标题，记录自己的句子。 */
  readonly title?: string
  /** 节点的说明，记录自己的句子。 */
  readonly description?: string
  /** 节点带的标签。 */
  readonly tags?: readonly string[]
  /** 跑这一格的模式，例如 `auto`／`manual`／`checkpoint`。 */
  readonly mode?: string
  /** 这一格现在的判定：`completed`／`shelved`／`todo`。 */
  readonly status?: string
  /** 这一格的重量。记录把它写成文本，照抄。 */
  readonly weight?: string
  /** 这一格跑在哪条会话上。 */
  readonly dsh_session?: string
  /** 前置节点的身份清单；每一条就是一条依赖边。 */
  readonly dependencies?: readonly string[]
  /** 建立时刻，记录里原样的那串文本。 */
  readonly created_at?: string | null
  /** 交付时刻，记录里原样的那串文本。 */
  readonly completed_at?: string | null
  /** 最后改动时刻，记录里原样的那串文本。 */
  readonly updated_at?: string | null
  /** 记录里还带着别的字段时一并带过来：这一步不裁剪。 */
  readonly [field: string]: unknown
}

/** 线路上走过的一步。 */
export interface PathfinderStep {
  /** 这一步走的是哪个节点。 */
  readonly node?: string
  /** 迈出这一步的时刻，记录里原样的那串文本。 */
  readonly started_at?: string | null
  /** 这一步落停的时刻，记录里原样的那串文本。 */
  readonly ended_at?: string | null
  /** 这一步的结局。 */
  readonly result?: string | null
  /** 记录里还带着别的字段时一并带过来。 */
  readonly [field: string]: unknown
}

/** 线路上握着某个节点的那一条。 */
export interface PathfinderHolding {
  /** 被握着的节点身份。 */
  readonly id?: string
  /** 握住的时刻，记录里原样的那串文本。 */
  readonly since?: string | null
  /** 记录里还带着别的字段时一并带过来。 */
  readonly [field: string]: unknown
}

/** 记录里的一条线路。 */
export interface PathfinderCycle {
  /** 线路的身份。 */
  readonly id?: string
  /** 线路的标题，记录自己的句子。 */
  readonly title?: string
  /** 线路现在的状态。 */
  readonly status?: string
  /** 线路带的标签。 */
  readonly tags?: readonly string[]
  /** 建立时刻，记录里原样的那串文本。 */
  readonly created_at?: string | null
  /** 最后改动时刻，记录里原样的那串文本。 */
  readonly updated_at?: string | null
  /** 这条线挂着的策略：键与值都照记录。 */
  readonly policies?: Readonly<Record<string, unknown>>
  /** 谁在做它：新一版记录把这条写成一份握着清单。 */
  readonly holding?: readonly PathfinderHolding[]
  /** 谁在做它：旧一版记录把它写成一个单值。 */
  readonly current_node?: string | null
  /** 旧一版的握住时刻，记录里原样的那串文本。 */
  readonly current_started_at?: string | null
  /** 这条线**走过的**步，按记录里的顺序。 */
  readonly path?: readonly PathfinderStep[]
  /** 记录里还带着别的字段时一并带过来。 */
  readonly [field: string]: unknown
}

/** 记录里的一条指令。 */
export interface PathfinderInstruction {
  /** 指令的身份。 */
  readonly id?: string
  /** 指令的正文，说话人自己的句子。 */
  readonly text?: string
  /** 这条指令管到哪儿。 */
  readonly scope?: string
  /** 这条指令落在哪一类对象上。 */
  readonly target?: string
  /** 这条指令现在的状态。 */
  readonly state?: string
  /** 绑到哪条线路；没绑就是 `null`。 */
  readonly cycle?: string | null
  /** 绑到哪个节点；没绑就是 `null`。 */
  readonly node?: string | null
  /** 第几轮生效；没记就是 `null`。 */
  readonly round?: number | null
  /** 哪一拍生效；没记就是 `null`。 */
  readonly stage?: number | null
  /** 谁说的。 */
  readonly said_by?: string
  /** 说出口的时刻，记录里原样的那串文本。 */
  readonly at?: string | null
  /** 结掉的时刻，记录里原样的那串文本。 */
  readonly resolved_at?: string | null
  /** 谁结掉的。 */
  readonly resolved_by?: string | null
  /** 被哪一条接替。 */
  readonly superseded_by?: string | null
  /** 附着的一句话。 */
  readonly note?: string | null
  /** 走几格之后停下；记录里只有少数条目带这个数。 */
  readonly stop_after_nodes?: number | null
  /** 已生效的轮次。 */
  readonly applied_rounds?: readonly unknown[]
  /** 已生效的对象。 */
  readonly applied?: readonly unknown[]
  /** 记录里还带着别的字段时一并带过来。 */
  readonly [field: string]: unknown
}

/** 问题池里的一条问题。 */
export interface PathfinderIssue {
  /** 问题的身份。 */
  readonly id?: string
  /** 问题的标题，记录自己的句子。 */
  readonly title?: string
  /** 严重程度档位。 */
  readonly severity?: string | null
  /** 这一条现在的处置状态。 */
  readonly status?: string
  /** 落在哪个模块上。 */
  readonly module?: string
  /** 谁报的。 */
  readonly source?: string | null
  /** 判决。 */
  readonly decision?: string | null
  /** 发现时刻，记录里原样的那串文本。 */
  readonly discovered?: string | null
  /** 最后改动时刻，记录里原样的那串文本。 */
  readonly updated_at?: string | null
  /** 核过几次。 */
  readonly check_count?: number | null
  /** 牵到的文件。 */
  readonly files?: readonly string[]
  /** 牵到的函数。 */
  readonly functions?: readonly string[]
  /** 问题的说明，记录自己的句子。 */
  readonly description?: string | null
  /** 建议，记录自己的句子。 */
  readonly suggestion?: string | null
  /** 理由，记录自己的句子。 */
  readonly reason?: string | null
  /** 方案落在哪儿。 */
  readonly plan_path?: string | null
  /** 记录里还带着别的字段时一并带过来。 */
  readonly [field: string]: unknown
}

/** 一次取数的结果：一个工作区、一层记录目录、四份来源。 */
export interface PathfinderReading {
  /** 这份读数取自哪个工作区根——按会话身份解析出来的那个绝对路径。 */
  readonly workspaceRoot: string
  /** 记录所在的那一层目录，工作区相对。 */
  readonly recordPath: string
  /**
   * 四份来源各自这一趟的结局，键是 {@link RECORD_SOURCES} 的键。
   * 取不到的那几份在下面给空集合：面板照「记录里没有」画。
   */
  readonly sources: Readonly<Record<keyof typeof RECORD_SOURCES, PathfinderSourceState>>
  /** `ideas.json` 的 `nodes`，键就是节点身份。 */
  readonly nodes: Readonly<Record<string, PathfinderNode>>
  /** `state.json` 的 `cycles`。 */
  readonly cycles: readonly PathfinderCycle[]
  /** `instructions.json` 的 `instructions`。 */
  readonly instructions: readonly PathfinderInstruction[]
  /** `issues/issues.json` 的 `issues`，键就是问题身份。 */
  readonly issues: Readonly<Record<string, PathfinderIssue>>
}

/** 取数时可以带的东西。 */
export interface PathfinderReadOptions {
  /** 调用方取消。 */
  readonly signal?: AbortSignal
}

/**
 * 宿主半身交给浏览器半身的那条服务：给它一条会话身份，它把那条会话所在工作区里的
 * 记录读成一份读数。记录不在就是空读数（四份来源全 `missing`、集合全空）。
 */
export interface PathfinderRecords {
  /**
   * @param sessionId - 会话身份；工作区根由它自己的会话头解析。
   * @param options - 可选的取消信号。
   * @returns 那个工作区里的记录，原样。
   */
  read(sessionId: SessionId, options?: PathfinderReadOptions): Promise<PathfinderReading>
}