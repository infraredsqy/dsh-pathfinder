/**
 * 记录原形：四份记录文件里原有字段的直通副本，一个字段都不改名、不做单位换算、不折算时刻，
 * 外加宿主半身一趟取数交回来的那份结果形状。
 *
 * 这是模型层的最底层：只描述记录自己，不 import 任何东西；宿主半身与浏览器半身都反过来
 * 从这里拿这些形状（宿主那侧由 `src/host/contract.ts` 转手）。
 */

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

/** 取数结果里四份来源各自的键，与记录自己的顶层集合一一对应。 */
export type RecordSourceKey = 'nodes' | 'cycles' | 'instructions' | 'issues'

/** 一次取数的结果。 */
export interface PathfinderReading {
  /** 这份读数取自哪个工作区根——调用方点名的那一个，没点名就是这条会话自己那个。绝对路径。 */
  readonly workspaceRoot: string
  /** 记录所在的那一层目录，工作区相对。 */
  readonly recordPath: string
  /**
   * 四份来源各自这一趟的结局，键是 {@link RecordSourceKey}。
   * 取不到的那几份在下面给空集合：面板照「记录里没有」画。
   */
  readonly sources: Readonly<Record<RecordSourceKey, PathfinderSourceState>>
  /** 键就是节点身份。 */
  readonly nodes: Readonly<Record<string, PathfinderNode>>
  readonly cycles: readonly PathfinderCycle[]
  readonly instructions: readonly PathfinderInstruction[]
  /** 键就是问题身份。 */
  readonly issues: Readonly<Record<string, PathfinderIssue>>
}
