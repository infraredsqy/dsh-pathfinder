/**
 * 那一刻的项目读数：节点、线路，以及四个读数各自那一栏。
 *
 * 每一条在那一刻是什么样，由它自己的字段说：时刻按那一刻切，记录自己的词在它自己的最后改动
 * 时刻之前写下来才算数，记录里没有那一刻就空着，不拿 0 顶上。进行中以线路记录里的持有关系
 * 为准：谁在做它这个问题记在线路那一侧，卡片自己的字段只回答「交付了没有」。
 */
import type { PathfinderCycle, PathfinderNode, PathfinderStep } from '../host/contract.ts'
import type {
  ColumnReadings,
  CycleReading,
  GateReading,
  HoldingReading,
  NodeReading,
  NodeState,
  ProjectReading,
  RecordsAtMoment,
  StepReading,
} from './contract.ts'
import { cutAt, happenedAt, secondsBetween, text, toMoment, writtenBy } from './fields.ts'
import { readGraph } from './graph.ts'
import { readInstructions } from './instructions.ts'
import { readPool } from './pool.ts'

/** 没交付的那两个判决：落到卡片上就是把这一格搁置了。 */
const PARKED_RESULTS = new Set(['failed', 'stopped'])

/** 线在服务里、不在服务里：记录自己那两个词。 */
const ACTIVE = 'active'
const INACTIVE = 'inactive'

/** 线路上的一步，连同它走的哪一格（步自己的字段里也写着，这里留一份现成的给节点分堆）。 */
interface CutStep {
  readonly nodeId: string | null
  readonly reading: StepReading
}

/** 线路上的一手：哪条线握着、握着谁。 */
interface CutHolding {
  readonly cycleId: string
  readonly holding: HoldingReading
}

/** 一条线在那一刻的样子，还没填「它名下出局等人的那几格」（那要等节点读数算完）。 */
interface CutCycle {
  readonly id: string
  readonly title: string | undefined
  readonly recordStatus: string | undefined
  readonly inService: boolean
  readonly holding: readonly CutHolding[]
  readonly path: readonly StepReading[]
  readonly lastStep: StepReading | null
  readonly steps: readonly CutStep[]
}

/** 一个节点自己的事实，还没算依赖那两栏（那要等同批节点的状态都出来）。 */
interface NodeFacts {
  readonly id: string
  readonly node: PathfinderNode
  readonly state: NodeState
  readonly steps: readonly StepReading[]
  readonly walkedBy: readonly string[]
  readonly held: readonly CutHolding[]
  readonly firstStep: StepReading | undefined
  /** 最后落停的那一步，连同它自己的判决；一步都没落停就没有。 */
  readonly lastVerdict: StepReading | undefined
}

/**
 * 读那一刻的项目。
 * @param input - 四份记录 + 读到哪一刻。
 * @throws 进来的不是一个时刻时给 TypeError：一个说不通的时刻，读出来每个字都不作数。
 */
export function readProject(input: RecordsAtMoment): ProjectReading {
  const at = input.at
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('读到哪一刻：进来的不是一个时刻')
  }

  const cut = input.cycles.map((cycle) => cutCycle(cycle, at))
  const facts = readFacts(input.nodes, cut, at)
  const nodes = facts.map((item) => readNode(item, facts, cut, at))
  const nodeById = Object.fromEntries(nodes.map((node) => [node.id, node]))
  const cycles = cut.map((item) => finishCycle(item, nodes))
  const cycleById = Object.fromEntries(cycles.map((cycle) => [cycle.id, cycle]))

  return {
    at,
    nodes,
    nodeById,
    columns: columnsOf(nodes),
    cycles,
    cycleById,
    instructions: readInstructions(input.instructions, nodeById, cycleById, at),
    graph: readGraph(nodes),
    pool: readPool(input.nodes, input.cycles, input.issues, at),
  }
}

function cutCycle(cycle: PathfinderCycle, at: Date): CutCycle {
  const id = text(cycle.id) ?? ''
  const steps: CutStep[] = []
  const path: StepReading[] = []
  for (const step of cycle.path ?? []) {
    const cut = cutStep(step, id, at)
    if (cut === null) continue
    steps.push(cut)
    /* 走过的步：落停了才算走过。那一刻还没落停的那一步是「正走着」，它不在走过的那串里。 */
    if (cut.reading.endedAt !== null) path.push(cut.reading)
  }
  const recordStatus = text(cycle.status)
  const holding = readHolding(cycle, at)
  return {
    id,
    title: text(cycle.title),
    recordStatus,
    inService: inServiceOf(cycle, recordStatus, holding, at),
    holding,
    path,
    lastStep: path.length > 0 ? (path[path.length - 1] ?? null) : null,
    steps,
  }
}

/** 线路在不在服务里：记录那个词写下来了就用它，还没写下来就按它手上握着谁读。 */
function inServiceOf(
  cycle: PathfinderCycle,
  recordStatus: string | undefined,
  holding: readonly CutHolding[],
  at: Date,
): boolean {
  const stated = recordStatus === ACTIVE || recordStatus === INACTIVE
  if (stated && writtenBy(toMoment(cycle.updated_at), at)) return recordStatus === ACTIVE
  /* 那一刻这个词还没写下来（或者记录里没有这个词）：手上什么都没有的线，读作不在服务里。 */
  return holding.length > 0
}

/** 一条线在那一刻握着谁：清单与单值两种写法都读。 */
function readHolding(cycle: PathfinderCycle, at: Date): readonly CutHolding[] {
  const id = text(cycle.id) ?? ''
  const out: CutHolding[] = []
  for (const entry of cycle.holding ?? []) {
    const holding = holdingOf(entry, at)
    if (holding !== null) out.push({ cycleId: id, holding })
  }
  if (out.length > 0) return out
  const current = text(cycle.current_node)
  if (current === undefined) return out
  const startedAt = toMoment(cycle.current_started_at)
  /* 那一刻还没拿起来的那一手，当时还没被握着。 */
  if (startedAt !== null && !happenedAt(startedAt, at)) return out
  return [{ cycleId: id, holding: { nodeId: current, since: startedAt } }]
}

/** 一手里那一条：写成对象，或只写一个身份。 */
function holdingOf(entry: unknown, at: Date): HoldingReading | null {
  if (typeof entry === 'string') return entry.length > 0 ? { nodeId: entry, since: null } : null
  if (typeof entry !== 'object' || entry === null) return null
  const fields = entry as { readonly id?: unknown; readonly since?: unknown }
  const nodeId = text(fields.id)
  if (nodeId === undefined) return null
  const since = toMoment(fields.since)
  /* 记录说这一手是那一刻才拿起来的，而那一刻还没到：当时它还没被握着。 */
  if (since !== null && !happenedAt(since, at)) return null
  return { nodeId, since }
}

/** 线路上的一步：那一刻还没摆出来的步不进读数。 */
function cutStep(step: PathfinderStep, cycleId: string, at: Date): CutStep | null {
  const rawStart = toMoment(step.started_at)
  const rawEnd = toMoment(step.ended_at)
  /* 记录把这一步摆在了那一刻之后：那一刻它还没摆出来。没记开始时刻的，按它的落停时刻算。 */
  const placed = rawStart !== null ? happenedAt(rawStart, at) : rawEnd === null || happenedAt(rawEnd, at)
  if (!placed) return null
  const startedAt = cutAt(rawStart, at)
  const endedAt = cutAt(rawEnd, at)
  const nodeId = text(step.node) ?? null
  const result = text(step.result)
  return {
    nodeId,
    reading: {
      cycleId,
      startedAt,
      endedAt,
      seconds: secondsBetween(startedAt, endedAt),
      ...(nodeId !== null ? { node: nodeId } : {}),
      ...(result !== undefined ? { result } : {}),
    },
  }
}

/** 一个节点在那一刻的状态：记录自己的词先说话，那一刻还没写下那个词就按它走过的步判。 */
function stateOf(node: PathfinderNode, lastVerdict: StepReading | undefined, at: Date): NodeState {
  const word = text(node.status)
  const wordAtCut = writtenBy(toMoment(node.updated_at), at)
  const deliveredAt = cutAt(toMoment(node.completed_at), at)
  /* 交付时刻到了就是交付了；记录里根本没写这个时刻时，它自己那个词才算数。 */
  if (deliveredAt !== null) return 'completed'
  if (toMoment(node.completed_at) === null && word === 'completed' && wordAtCut) return 'completed'
  if (wordAtCut && word === 'shelved') return 'shelved'
  if (wordAtCut && word === 'todo') return 'todo'
  /* 词还没写下来（或者不是这三个词里的一个）：按它最后落停那一步的判决读——那一步带回
   * 未交付那两个词之一才算出局等人；它已经带着 completed 落停，这一格就回到了局中。 */
  return lastVerdict !== undefined && PARKED_RESULTS.has(lastVerdict.result ?? '') ? 'shelved' : 'todo'
}

/** 每个节点自己的事实，按记录里的顺序。 */
function readFacts(
  source: Readonly<Record<string, PathfinderNode>>,
  cut: readonly CutCycle[],
  at: Date,
): readonly NodeFacts[] {
  const stepsOf = new Map<string, StepReading[]>()
  const walkedBy = new Map<string, string[]>()
  const heldOf = new Map<string, CutHolding[]>()
  for (const cycle of cut) {
    for (const step of cycle.steps) {
      if (step.nodeId === null) continue
      collect(stepsOf, step.nodeId, step.reading)
      const walkers = walkedBy.get(step.nodeId)
      if (walkers === undefined) walkedBy.set(step.nodeId, [cycle.id])
      else if (!walkers.includes(cycle.id)) walkers.push(cycle.id)
    }
    for (const holding of cycle.holding) collect(heldOf, holding.holding.nodeId, holding)
  }

  return Object.entries(source).map(([id, node]) => {
    const steps = stepsOf.get(id) ?? []
    /* 它自己那一步：记录里最先走的那一步。重跑过的格有两步，头一步是它自己的。 */
    const firstStep = steps[0]
    /* 最后落停的那一步：重跑过的那一格，重跑那一趟就把先头那一趟的判决盖过去了。那一刻
     * 还没落停的步手上没有判决，停不了任何事。 */
    let lastVerdict: StepReading | undefined
    for (const step of steps) {
      if (step.endedAt !== null) lastVerdict = step
    }
    return {
      id,
      node,
      state: stateOf(node, lastVerdict, at),
      steps,
      walkedBy: walkedBy.get(id) ?? [],
      held: heldOf.get(id) ?? [],
      firstStep,
      lastVerdict,
    }
  })
}

function readNode(
  facts: NodeFacts,
  all: readonly NodeFacts[],
  cut: readonly CutCycle[],
  at: Date,
): NodeReading {
  const { id, node, state, steps, held, firstStep, lastVerdict } = facts
  const completedAt = cutAt(toMoment(node.completed_at), at)
  const startedAt = firstStep?.startedAt ?? null
  const endedAt = firstStep?.endedAt ?? null
  const heldByIDs: string[] = []
  const holdMoments: Date[] = []
  for (const item of held) {
    if (!heldByIDs.includes(item.cycleId)) heldByIDs.push(item.cycleId)
    if (item.holding.since !== null) holdMoments.push(item.holding.since)
  }
  const running = state === 'todo' && heldByIDs.length > 0
  const completed = new Set(all.filter((item) => item.state === 'completed').map((item) => item.id))
  const openDependencies = (node.dependencies ?? []).filter((dependency) => !completed.has(dependency))
  const recordStatus = text(node.status)
  const mode = text(node.mode)
  const title = text(node.title)
  const session = text(node.dsh_session)
  const line = facts.walkedBy[0]
  const lineLast = line === undefined ? undefined : cut.find((item) => item.id === line)?.lastStep ?? null
  const parkedSince = state === 'shelved' && lastVerdict !== undefined ? lastVerdict.endedAt : null
  const gate = gateOf({
    id,
    state,
    mode,
    parkedSince,
    startedAt,
    lineLast,
  })
  return {
    id,
    state,
    running,
    ready: state === 'todo' && openDependencies.length === 0 && !running,
    dependencies: [...(node.dependencies ?? [])],
    openDependencies,
    heldBy: heldByIDs,
    /* 把它拿起来的那一刻：最早的那一手；记录里没记就是空。 */
    heldSince: holdMoments.length > 0 ? new Date(Math.min(...holdMoments.map((d) => d.getTime()))) : null,
    createdAt: cutAt(toMoment(node.created_at), at),
    completedAt,
    startedAt,
    endedAt,
    seconds: firstStep?.seconds ?? null,
    elapsedSeconds: running && startedAt !== null ? secondsBetween(startedAt, at) : null,
    parkedSince,
    steps,
    cycleIds: [...facts.walkedBy],
    gate,
    ...(title !== undefined ? { title } : {}),
    ...(recordStatus !== undefined ? { recordStatus } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(session !== undefined ? { session } : {}),
  }
}

/**
 * 这一格要不要一个人：一个词 + 那一刻。判据全在记录里，不要人的格没有这个词。
 * @param lineLast - 走过它那条线在那一刻走过的最后一步。
 */
function gateOf(facts: {
  readonly id: string
  readonly state: NodeState
  readonly mode: string | undefined
  readonly parkedSince: Date | null
  readonly startedAt: Date | null
  readonly lineLast: StepReading | null | undefined
}): GateReading | null {
  if (facts.state === 'shelved') {
    return { kind: 'shelved', word: '等待处理', since: facts.parkedSince }
  }
  if (facts.mode === 'manual' && facts.state !== 'completed') {
    return { kind: 'manual', word: '手动节点', since: facts.startedAt }
  }
  const last = facts.lineLast
  if (facts.mode === 'checkpoint' && facts.state === 'completed' && last !== null && last !== undefined && last.node === facts.id) {
    return { kind: 'checkpoint', word: '检查点', since: last.endedAt }
  }
  return null
}

function finishCycle(cycle: CutCycle, nodes: readonly NodeReading[]): CycleReading {
  const parked = nodes.filter((node) => node.state === 'shelved' && node.cycleIds[0] === cycle.id).map((node) => node.id)
  return {
    id: cycle.id,
    inService: cycle.inService,
    holding: cycle.holding.map((item) => item.holding),
    path: cycle.path,
    lastStep: cycle.lastStep,
    parked,
    ...(cycle.title !== undefined ? { title: cycle.title } : {}),
    ...(cycle.recordStatus !== undefined ? { recordStatus: cycle.recordStatus } : {}),
  }
}

/** 四个读数各自那一栏：四栏互斥，一个节点只在一栏里。 */
function columnsOf(nodes: readonly NodeReading[]): ColumnReadings {
  const completed: NodeReading[] = []
  const running: NodeReading[] = []
  const shelved: NodeReading[] = []
  const todo: NodeReading[] = []
  const ready: NodeReading[] = []
  const blocked: NodeReading[] = []
  for (const node of nodes) {
    if (node.state === 'completed') completed.push(node)
    else if (node.state === 'shelved') shelved.push(node)
    else if (node.running) running.push(node)
    else {
      todo.push(node)
      if (node.ready) ready.push(node)
      else blocked.push(node)
    }
  }
  return { completed, running, shelved, todo, ready, blocked }
}

function collect<T>(into: Map<string, T[]>, key: string, value: T): void {
  const known = into.get(key)
  if (known === undefined) into.set(key, [value])
  else known.push(value)
}