/**
 * 模型层对外的形状：进去的是四份记录加一个时刻，出来的是那一刻的读数。
 *
 * 输入就是记录自己的形状，四份原样递进来，字段一个都不改名、不补默认值。读数一律给成清单：
 * 某一个读数一个都没有的时候，它给出来的是一张空清单，不给出一个 `0` 让人拿去印。
 */
import type {
  PathfinderCycle,
  PathfinderInstruction,
  PathfinderIssue,
  PathfinderNode,
} from '../host/contract.ts'

/** 模型要的东西：四份记录，外加「读到哪一刻」。 */
export interface RecordsAtMoment {
  /** 键就是节点身份，条目是记录原样。 */
  readonly nodes: Readonly<Record<string, PathfinderNode>>
  readonly cycles: readonly PathfinderCycle[]
  readonly instructions: readonly PathfinderInstruction[]
  /** 输入形状收全四份记录，但这一格不算问题池的读数，它的判据不在这里。 */
  readonly issues: Readonly<Record<string, PathfinderIssue>>
  /** 读到哪一刻。 */
  readonly at: Date
}

/**
 * 卡自己的状态，只有三个词。正被某条线做着的卡，状态仍然是 `todo`：谁在做它记在线路的
 * 持有关系里（见 {@link NodeReading.running}），两件事各占一个字段。
 */
export type NodeState = 'todo' | 'shelved' | 'completed'

/**
 * 人闸：这一格什么时候要一个人。一个词 + 那一刻，词只有三个，判据全在记录里，这里不新增数据。
 */
export interface GateReading {
  /** 是哪一种闸。 */
  readonly kind: 'shelved' | 'manual' | 'checkpoint'
  /** 读作哪一个词：等待处理 / 手动节点 / 检查点。 */
  readonly word: '等待处理' | '手动节点' | '检查点'
  /** 那一刻；记录里没有那一刻就是 `null`，不补一个。 */
  readonly since: Date | null
}

/** 节点在那一刻走过的一步。 */
export interface StepReading {
  /** 这一步是哪条线走的；这条线记录里没写身份的，这里是空身份。 */
  readonly cycleId: string
  readonly node?: string
  /** 迈出的时刻，按那一刻切过：没到就没有。 */
  readonly startedAt: Date | null
  /** 落停的时刻，按那一刻切过：还没落停就没有。 */
  readonly endedAt: Date | null
  readonly result?: string
  /** 这一步用了多久；两端有一个没有就是 `null`。 */
  readonly seconds: number | null
}

/** 一个节点在那一刻的读数。 */
export interface NodeReading {
  readonly id: string
  readonly title?: string
  /** 那一刻的状态：三个词里的一个。 */
  readonly state: NodeState
  /**
   * 进行中：那一刻有条线握着它、且它还没交付；以线路记录里的持有关系为准。
   */
  readonly running: boolean
  /**
   * 可开工：自己是 `todo`、每个依赖都交付了、且没有任何线握着它。三条缺一不可。
   */
  readonly ready: boolean
  /** 记录自己写的那个词，原样；没写就没有。 */
  readonly recordStatus?: string
  /** 这一格跑的模式，原样。 */
  readonly mode?: string
  /** 这一格开在哪条会话上：记录本体上写着这个字段就带出来，没写就没有。 */
  readonly session?: string
  /** 记录里写的依赖，原样，一个都不丢。 */
  readonly dependencies: readonly string[]
  /** 那一刻还没交付的那几个依赖：依赖里没有一条算交付了。 */
  readonly openDependencies: readonly string[]
  /** 那一刻握着它的线路身份，按记录顺序。 */
  readonly heldBy: readonly string[]
  /** 持有关系自己那一刻：它最早被拿起来的时刻；没记或没到就是 `null`。 */
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
  /** 进行中开了多久（算到那一刻）；没在进行中、或没有那一刻就是 `null`。 */
  readonly elapsedSeconds: number | null
  /** 等待处理那一刻：判决那一步的落停时刻；没有那一刻就是 `null`（不是 0）。 */
  readonly parkedSince: Date | null
  /** 它走过的步。 */
  readonly steps: readonly StepReading[]
  /** 走过它的线路。 */
  readonly cycleIds: readonly string[]
  /** 人闸：这一格要一个人的话，是哪一个词、哪一刻；不要人就是 `null`。 */
  readonly gate: GateReading | null
}

/**
 * 依赖场上给读者的一句话：可开工，或者还欠几件前置。
 *
 * 哪一句归这一格由读数自己的 `ready` 说，界面不重判那三条判据；落定的、进行中的、放下的
 * 不欠这个问题——依赖只写给还没开动的活。
 */
export interface DepsWord {
  /** 那一句话，逐字：`可开工` / `前置节点 N 个`。 */
  readonly word: string
  /** 是可开工那一句：记号跟它换装。 */
  readonly ready: boolean
  /** 「前置节点 N 个」里的 N；可开工那一句没有数。 */
  readonly count: number | null
}

/** 线路上一个持有关系在那一刻的样子。 */
export interface HoldingReading {
  readonly nodeId: string
  /** 握住的时刻；没记或没到就是 `null`。 */
  readonly since: Date | null
}

/** 一条线路在那一刻的读数。 */
export interface CycleReading {
  readonly id: string
  readonly title?: string
  /** 记录自己写的那个词，原样；没写就没有。 */
  readonly recordStatus?: string
  /** 那一刻在不在服务里。 */
  readonly inService: boolean
  readonly holding: readonly HoldingReading[]
  /** 那一刻它走过的步（记录里没有落停的步还没走完，不算走过）。 */
  readonly path: readonly StepReading[]
  /** 那一刻它走过的最后一步；一步都没走过就是 `null`。 */
  readonly lastStep: StepReading | null
  /** 它名下出局等人的节点身份：停在哪几格上等人。 */
  readonly parked: readonly string[]
}

/**
 * 指令登记簿上的一组：按范围分堆的那一段。组头一个词，底下一摞条目。
 *
 * 范围那个词只在出读数这一处读：全局在前，然后每条线按记录里的次序，再是认不得的那条线，
 * 最后一格；空组不收。
 */
export interface InstructionGroupReading {
  /** 这一组的身份：`global` / 绑的那条线（`cycle:<线身份>`）/ `node`。 */
  readonly key: string
  /** 读作哪一个词：全局 / 线自己的名字 / 未分组 / 这一格。 */
  readonly label: string
  /** 这一组里那几条：还算数的在前，新说的在前。 */
  readonly entries: readonly InstructionReading[]
}

/** 一条指令在那一刻的读数。 */
export interface InstructionReading {
  readonly id: string
  readonly text?: string
  /** 记录里自己写的备注，原样；没写就没有。 */
  readonly note?: string
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
  /** 记录自己写的那个词，原样（存量的旧值也原样带出来，不折算）；没写就没有。 */
  readonly recordState?: string
  /**
   * 那一刻它还站着：词说的是 `live`，也没有一个已经到的那一刻把它收掉。
   */
  readonly standing: boolean
  /** 那一刻它管得着：范围说的是「这一句算在谁头上」。 */
  readonly inScope: boolean
  /** 算数 ＝ 说出口了（所以它在读数里）＋ 还站着 ＋ 在范围里。 */
  readonly inForce: boolean
}

/** 词表上那四个读数各自那一栏，四栏互斥：一个节点只在一栏里。 */
export interface ColumnReadings {
  readonly completed: readonly NodeReading[]
  /** 进行中：那一刻有条线握着、还没交付的。 */
  readonly running: readonly NodeReading[]
  /** 等待处理：那一刻出局等人的；一个都没有时这一栏是空清单，不画，也不写 0。 */
  readonly shelved: readonly NodeReading[]
  /** 未开始：在局中、还没交付、也没人做（进行中的不在这一栏里）。 */
  readonly todo: readonly NodeReading[]
  /** 可开工：未开始里依赖都交付了、也没人握着的那一半。 */
  readonly ready: readonly NodeReading[]
  /** 前置未交付的那一半。 */
  readonly blocked: readonly NodeReading[]
}

/** 依赖场上的一条边：`from` 是前置、`to` 是等它的那一格，`span` 是两头隔了几层（至少是 1）。 */
export interface GraphEdge {
  readonly from: string
  readonly to: string
  readonly span: number
}

/**
 * 那一刻的依赖场读数：一张分层图。
 *
 * 一格的层号是最长路那一档：它站在它最深的前置右边一层。
 */
export interface GraphReading {
  /** 每一层里那几格，按记录里的次序。一个节点都没有时这一份是空的。 */
  readonly layers: readonly (readonly NodeReading[])[]
  readonly maxDepth: number
  readonly edges: readonly GraphEdge[]
}

/** 问题池里一条问题的四个状态，记录自己那几个词。 */
export type IssueState = 'open' | 'acknowledged' | 'rejected' | 'resolved'

/** 那一刻的一条问题。 */
export interface IssueReading {
  readonly id: string
  readonly title?: string
  /** 严重程度那一档，原样。 */
  readonly severity?: string
  /** 记录里那一档在重量表里算几倍；表里没有这一档就是 0。 */
  readonly weight: number
  /** 那一刻它落在哪个状态：记录自己的词，那一刻还没写下来就是 `open`。 */
  readonly status: IssueState
  /** 记录自己写的那个词，原样；没写就没有。 */
  readonly recordStatus?: string
  readonly module?: string
  /** 谁报的。 */
  readonly source?: string
  /** 判决。 */
  readonly decision?: string
  /** 这一条压不压那条线：判决不给它压秤的就是 `false`——还在册、还算站着，只是不进加权和。 */
  readonly payable: boolean
  /** 发现时刻，按那一刻切过：那一刻还没发现就没有。 */
  readonly discoveredAt: Date | null
  /** 最后改动时刻，按那一刻切过。 */
  readonly updatedAt: Date | null
  readonly checkCount: number | null
  readonly files: readonly string[]
  readonly description?: string
  readonly suggestion?: string
  readonly reason?: string
  readonly planPath?: string
}

/** 问题池里的一堆：一个状态下面那几条。 */
export interface IssueGroupReading {
  readonly key: IssueState
  /** 读作哪一个词：未解决 / 已承认 / 已驳回 / 已解决。 */
  readonly label: string
  /** 这一堆算不算池子还欠着的：欠着的两堆算，放下的两堆不算。 */
  readonly standing: boolean
  /** 这一堆里那几条，排序见 {@link PoolReading}。 */
  readonly entries: readonly IssueReading[]
  readonly count: number
  /** 这一堆的加权和：不压线的那几条不进这个和。 */
  readonly weight: number
}

/** 重量表：记录里写着的一档算几倍。 */
export type PoolWeights = Readonly<Record<string, number>>

/** 那一刻的问题池读数。 */
export interface PoolReading {
  /** 策略线：`issue_pool_weight_limit` 那条线自己立的数；记录里没有这一条就是 `null`，不印 0。 */
  readonly line: number | null
  /** 重量表：记录里写着的那一份（几个等级各算几倍）；记录里没有这一份就是 `null`。 */
  readonly weights: PoolWeights | null
  readonly rows: readonly IssueReading[]
  /** 四堆，按读者遇到它们的次序：未解决、已承认、已驳回、已解决；空的堆不收。 */
  readonly groups: readonly IssueGroupReading[]
  /**
   * 还欠着的那几条：未解决的接着已承认的。池子的重量就是这一份里进和的那几条的重量，
   * 重量表没有的话这一份也没有。
   */
  readonly standing: readonly IssueReading[]
  /** 站着那几条的加权和，不压线的那几条不进这个和；重量表读不出来就是 `null`。 */
  readonly weight: number | null
  /** 四个数，外加一个总数。 */
  readonly census: PoolCensus
}

/** 问题池那几个数。 */
export interface PoolCensus {
  /** 在册的一共几条。 */
  readonly total: number
  /** 站着的一共几条。 */
  readonly standing: number
  readonly open: number
  readonly acknowledged: number
  readonly rejected: number
  readonly resolved: number
}

/** 那一刻的项目读数。 */
export interface ProjectReading {
  /** 读到哪一刻。 */
  readonly at: Date
  readonly nodes: readonly NodeReading[]
  /** 同一份读数按身份取。 */
  readonly nodeById: Readonly<Record<string, NodeReading>>
  readonly columns: ColumnReadings
  readonly cycles: readonly CycleReading[]
  /** 同一份读数按身份取。 */
  readonly cycleById: Readonly<Record<string, CycleReading>>
  /** 那一刻说出口了的那几条指令。 */
  readonly instructions: readonly InstructionReading[]
  /** 那一刻的依赖场：谁挡着谁。 */
  readonly graph: GraphReading
  /** 那一刻的问题池。 */
  readonly pool: PoolReading
}