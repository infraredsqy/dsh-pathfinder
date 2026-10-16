/**
 * 模型层对外的形状：进去的是四份记录加一个时刻，出来的是那一刻的读数。
 *
 * 输入就是记录自己的形状——跟数据桥那一格同一个边界：节点、线路、指令、问题池四份原样递
 * 进来，字段一个都不改名、不补默认值。位置元组那种给版面用的投影形状只活在原型与测试里，
 * 不进这条路。
 *
 * 这一层是纯逻辑：没有全局状态、不碰 DOM、不 import 任何运行时依赖，单独跑得起来。
 *
 * 读数一律给成**清单**：某一个读数一个都没有的时候，它给出来的是一张空清单（那一格空着，
 * 不画）。这里不给出一个 `0` 让人拿去印——记录里没有的那一刻，就不拿 0 顶上。
 *
 * @module dsh-pathfinder/model/contract
 */
import type {
  PathfinderCycle,
  PathfinderInstruction,
  PathfinderIssue,
  PathfinderNode,
} from '../host/contract.ts'

/** 模型要的东西：四份记录，外加「读到哪一刻」。 */
export interface RecordsAtMoment {
  /** 节点那一份：键就是节点身份，条目是记录原样。 */
  readonly nodes: Readonly<Record<string, PathfinderNode>>
  /** 线路那一份，按记录里的顺序。 */
  readonly cycles: readonly PathfinderCycle[]
  /** 指令那一份，按记录里的顺序。 */
  readonly instructions: readonly PathfinderInstruction[]
  /**
   * 问题池那一份。这里的输入形状收全四份记录（记录长什么样，输入就是什么样），但这一格
   * 不算问题池的读数——它的判据不在这里。
   */
  readonly issues: Readonly<Record<string, PathfinderIssue>>
  /** 读到哪一刻。 */
  readonly at: Date
}

/**
 * 卡自己的状态，只有三个词。**正被某条线做着的卡，状态仍然是 `todo`**——谁在做它记在线路
 * 的持有关系里（见 {@link NodeReading.running}），两件事各占一个字段。
 */
export type NodeState = 'todo' | 'shelved' | 'completed'

/**
 * 人闸：这一格什么时候要一个人。一个词 + 那一刻。
 * 词只有三个，判据全在记录里，这里不新增数据。
 */
export interface GateReading {
  /** 是哪一种闸。 */
  readonly kind: 'shelved' | 'manual' | 'checkpoint'
  /** 读作哪一个词：等待处理 / 手动节点 / 检查点。 */
  readonly word: '等待处理' | '手动节点' | '检查点'
  /** 那一刻。记录里没有那一刻就是 `null`——不补一个。 */
  readonly since: Date | null
}

/** 节点在那一刻走过的一步。 */
export interface StepReading {
  /** 这一步是哪条线走的；这条线记录里没写身份的，这里是空身份。 */
  readonly cycleId: string
  /** 这一步走的哪一格，原样；记录里没写就没有。 */
  readonly node?: string
  /** 迈出的时刻，按那一刻切过：没到就没有。 */
  readonly startedAt: Date | null
  /** 落停的时刻，按那一刻切过：还没落停就没有。 */
  readonly endedAt: Date | null
  /** 这一步的判决，原样；记录里没写就没有。 */
  readonly result?: string
  /** 这一步用了多久；两端有一个没有就是 `null`。 */
  readonly seconds: number | null
}

/** 一个节点在那一刻的读数。 */
export interface NodeReading {
  /** 节点身份。 */
  readonly id: string
  /** 那一刻的状态：三个词里的一个。 */
  readonly state: NodeState
  /**
   * 在手：那一刻有条线握着它、且它还没交付。
   * 以线路记录里的持有关系为准——那是记录里的权威字段。
   */
  readonly running: boolean
  /**
   * 可开工：自己是 `todo`、每个依赖都交付了、且没有任何线握着它。三条缺一不可。
   */
  readonly ready: boolean
  /** 记录自己写的那个词，原样；没写就没有。 */
  readonly recordStatus?: string
  /** 这一格跑的模式，原样；没写就没有。 */
  readonly mode?: string
  /** 记录里写的依赖，原样（一个都不丢）。 */
  readonly dependencies: readonly string[]
  /** 那一刻还没交付的那几个依赖：依赖里没有一条算交付了。 */
  readonly openDependencies: readonly string[]
  /** 那一刻握着它的线路身份，按记录顺序。 */
  readonly heldBy: readonly string[]
  /** 持有关系自己那一刻：它最早被拿在手里的时刻；没记或没到就是 `null`。 */
  readonly heldSince: Date | null
  /** 建立时刻，按那一刻切过。 */
  readonly createdAt: Date | null
  /** 交付时刻，按那一刻切过。 */
  readonly completedAt: Date | null
  /** 它自己那一步迈出的时刻。 */
  readonly startedAt: Date | null
  /** 它自己那一步落停的时刻。 */
  readonly endedAt: Date | null
  /** 它自己那一步用了多久。 */
  readonly seconds: number | null
  /** 在手开了多久（算到那一刻）；不在手、或没有那一刻就是 `null`。 */
  readonly elapsedSeconds: number | null
  /** 等待处理那一刻：判决那一步的落停时刻；没有那一刻就是 `null`（不是 0）。 */
  readonly parkedSince: Date | null
  /** 它走过的步，按记录顺序。 */
  readonly steps: readonly StepReading[]
  /** 走过它的线路，按记录顺序。 */
  readonly cycleIds: readonly string[]
  /** 人闸：这一格要一个人的话，是哪一个词、哪一刻；不要人就是 `null`。 */
  readonly gate: GateReading | null
}

/** 线路上一个持有关系在那一刻的样子。 */
export interface HoldingReading {
  /** 被握着的节点身份。 */
  readonly nodeId: string
  /** 握住的时刻；没记或没到就是 `null`。 */
  readonly since: Date | null
}

/** 一条线路在那一刻的读数。 */
export interface CycleReading {
  /** 线路身份。 */
  readonly id: string
  /** 线路的标题；没写就没有。 */
  readonly title?: string
  /** 记录自己写的那个词，原样；没写就没有。 */
  readonly recordStatus?: string
  /** 那一刻在不在服务里。 */
  readonly inService: boolean
  /** 那一刻它握着的那组节点。 */
  readonly holding: readonly HoldingReading[]
  /** 那一刻它**走过的**步（记录里没有落停的步还没走完，不算走过）。 */
  readonly path: readonly StepReading[]
  /** 那一刻它走过的最后一步；一步都没走过就是 `null`。 */
  readonly lastStep: StepReading | null
  /** 它名下出局等人的节点身份：停在哪几格上等人。 */
  readonly parked: readonly string[]
}

/** 一条指令在那一刻的读数。 */
export interface InstructionReading {
  /** 指令身份。 */
  readonly id: string
  /** 正文，说话人自己的句子；没写就没有。 */
  readonly text?: string
  /** 范围，原样：全局 / 绑某条线 / 绑某一格，以及记录里别的写法；没写就没有。 */
  readonly scope?: string
  /** 绑到哪条线路；没绑就是 `null`。 */
  readonly cycleId: string | null
  /** 绑到哪个节点；没绑就是 `null`。 */
  readonly nodeId: string | null
  /** 说出口的时刻，按那一刻切过。 */
  readonly saidAt: Date | null
  /** 结掉的时刻，按那一刻切过：那一刻还没结就没有。 */
  readonly closedAt: Date | null
  /** 记录自己写的那个词，原样；没写就没有。 */
  readonly recordState?: string
  /** 那一刻它还站着：词没说它终局，也没有一个已经到的那一刻把它收掉。 */
  readonly standing: boolean
  /** 那一刻它管得着：范围说的是「这一句算在谁头上」。 */
  readonly inScope: boolean
  /** 算数 ＝ 说出口了（所以它在读数里）＋ 还站着 ＋ 在范围里。 */
  readonly inForce: boolean
}

/**
 * 词表上那四个读数各自那一栏。四栏互斥，合起来是在那一刻有读数的那些节点——
 * 一个节点只在一栏里。
 */
export interface ColumnReadings {
  /** 已成：那一刻交付了的。 */
  readonly completed: readonly NodeReading[]
  /** 在手：那一刻有条线握着、还没交付的。 */
  readonly running: readonly NodeReading[]
  /**
   * 等待处理：那一刻出局等人的。它一个都没有时这一栏是空清单——那一格空着，不画，
   * 也不写 0。
   */
  readonly shelved: readonly NodeReading[]
  /** 待办：在局中、还没交付、也没人做（在手的不在这一栏里）。 */
  readonly todo: readonly NodeReading[]
  /** 可开工：待办里依赖都交付了、也没人握着的那一半。 */
  readonly ready: readonly NodeReading[]
  /** 前置未交付的那一半。 */
  readonly blocked: readonly NodeReading[]
}

/** 那一刻的项目读数。 */
export interface ProjectReading {
  /** 读到哪一刻。 */
  readonly at: Date
  /** 节点读数，按记录里的顺序。 */
  readonly nodes: readonly NodeReading[]
  /** 同一份读数按身份取。 */
  readonly nodeById: Readonly<Record<string, NodeReading>>
  /** 四个读数各自那一栏。 */
  readonly columns: ColumnReadings
  /** 线路读数，按记录里的顺序。 */
  readonly cycles: readonly CycleReading[]
  /** 同一份读数按身份取。 */
  readonly cycleById: Readonly<Record<string, CycleReading>>
  /** 那一刻说出口了的那几条指令，按记录里的顺序。 */
  readonly instructions: readonly InstructionReading[]
}