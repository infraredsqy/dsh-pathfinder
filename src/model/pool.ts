/**
 * 问题池那一份读数：一份登记簿怎么读。
 *
 * 在不在册看它发现的那一刻到了没；落在哪个状态取记录自己那个词，而那个词属于写它的那一刻，
 * 最后改动时刻还没到就按还没结掉读（`open`）；多重取重量表里它那一档算几倍，判成 `external`
 * 的那几条还在册、还算站着，只是不进加权和。
 *
 * 重量表与策略线在记录里都不在现成字段上：前者写在某条维护活儿自己的说明里
 * （`P3/P2/P1/P0 = 1/2/4/8`），后者是某条线路自己立的 `issue_pool_weight_limit`。
 */
import type { PathfinderCycle, PathfinderIssue, PathfinderNode } from './records.ts'
import type {
  IssueGroupReading,
  IssueReading,
  IssueState,
  PoolCensus,
  PoolReading,
  PoolWeights,
} from './contract.ts'
import { cutAt, text, toMoment, writtenBy } from './fields.ts'

/** 重量表那句话：几个等级各算几倍。 */
const WEIGHT_MAP = /P3\s*\/\s*P2\s*\/\s*P1\s*\/\s*P0\s*=\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/u

/** 策略线那一条策略的名字，与工具那边逐字相同。 */
const WEIGHT_LIMIT = 'issue_pool_weight_limit'

/** 重量表里那四档的次序，最重的在前；表里没写的那一档排在最后。 */
const SEVERITY_RANK: Readonly<Record<string, number>> = { P0: 0, P1: 1, P2: 2, P3: 3 }

/**
 * 四个状态各自读作哪个词：这一份词面只在模型层写一处，登记簿的组头与面板上那一排数说的是
 * 同一套。空堆不进读数的组，词面照旧问得到。
 */
export const ISSUE_STATE_WORDS: Readonly<Record<IssueState, string>> = {
  open: '未解决',
  acknowledged: '已承认',
  rejected: '已驳回',
  resolved: '已解决',
}

/** 四堆的次序，与各堆算不算池子还欠着的；词面在 {@link ISSUE_STATE_WORDS} 里。 */
const GROUP_WORDS: readonly { readonly key: IssueState; readonly standing: boolean }[] = [
  { key: 'open', standing: true },
  { key: 'acknowledged', standing: true },
  { key: 'rejected', standing: false },
  { key: 'resolved', standing: false },
]

/**
 * 读那一刻的问题池。
 */
export function readPool(
  nodes: Readonly<Record<string, PathfinderNode>>,
  cycles: readonly PathfinderCycle[],
  issues: Readonly<Record<string, PathfinderIssue>>,
  at: Date,
): PoolReading {
  const weights = readWeights(nodes)
  const line = readLine(cycles)

  const rows: IssueReading[] = []
  for (const entry of Object.values(issues)) {
    const discoveredAt = cutAt(toMoment(entry.discovered), at)
    /* 还没发现的那一条不在册：登记簿只记已经登记过的。 */
    if (discoveredAt === null) continue
    const written = toMoment(entry.updated_at)
    const updatedAt = cutAt(written, at)
    const recordStatus = text(entry.status)
    const severity = text(entry.severity)
    const decision = text(entry.decision)
    const id = text(entry.id) ?? ''
    /* 压不压那条线由判决自己说：判成 `external` 的掉出加权和——算进来是一块谁也挪不动的
     * 底板，阈值永远回不到线下，池子的正本读数 `pf issue weight` 就这么排它。条数走另一条
     * 口径（工具的 `status`）：它还在册、还算站着，只是不压这条线。 */
    const payable = decision !== 'external'
    rows.push({
      id,
      weight: severity === undefined ? 0 : (weights?.[severity] ?? 0),
      status: statusOf(recordStatus, written, at),
      discoveredAt,
      updatedAt,
      checkCount: typeof entry.check_count === 'number' ? entry.check_count : null,
      files: [...(entry.files ?? [])],
      payable,
      ...field('title', text(entry.title)),
      ...field('severity', severity),
      ...field('recordStatus', recordStatus),
      ...field('module', text(entry.module)),
      ...field('source', text(entry.source)),
      ...field('decision', decision),
      ...field('description', text(entry.description)),
      ...field('suggestion', text(entry.suggestion)),
      ...field('reason', text(entry.reason)),
      ...field('planPath', text(entry.plan_path)),
    })
  }

  const groups: IssueGroupReading[] = []
  for (const word of GROUP_WORDS) {
    const entries = rows
      .filter((row) => row.status === word.key)
      .sort(word.standing ? standingOrder : closedOrder)
    if (entries.length === 0) continue
    groups.push({
      key: word.key,
      label: ISSUE_STATE_WORDS[word.key],
      standing: word.standing,
      entries,
      count: entries.length,
      weight: sumWeight(entries),
    })
  }

  const open = rows.filter((row) => row.status === 'open')
  const acknowledged = rows.filter((row) => row.status === 'acknowledged')
  const standing = [...open, ...acknowledged]
  const census: PoolCensus = {
    total: rows.length,
    standing: standing.length,
    open: open.length,
    acknowledged: acknowledged.length,
    rejected: rows.filter((row) => row.status === 'rejected').length,
    resolved: rows.filter((row) => row.status === 'resolved').length,
  }

  return {
    line,
    weights,
    rows,
    groups,
    standing,
    weight: weights === null ? null : sumWeight(standing),
    census,
  }
}

/**
 * 记录里写着的那份重量表。
 */
export function readWeights(nodes: Readonly<Record<string, PathfinderNode>>): PoolWeights | null {
  for (const node of Object.values(nodes)) {
    const said = `${node.title ?? ''} ${node.description ?? ''}`
    const found = WEIGHT_MAP.exec(said)
    if (found !== null) {
      return { P3: Number(found[1]), P2: Number(found[2]), P1: Number(found[3]), P0: Number(found[4]) }
    }
  }
  return null
}

/**
 * 那条策略线：哪条线自己立了 `issue_pool_weight_limit`。
 */
export function readLine(cycles: readonly PathfinderCycle[]): number | null {
  for (const cycle of cycles) {
    const held = cycle.policies?.[WEIGHT_LIMIT]
    if (typeof held === 'number') return held
  }
  return null
}

/**
 * 那一刻这一条落在哪个状态。
 *
 * 记录自己的词属于写它的那一刻：最后改动时刻还没到，那个词就还没生效，这一条按还没结掉
 * 读。记录里写的不是那四个词（或者根本没写），也按还没结掉读——没人结掉它。
 */
function statusOf(recordStatus: string | undefined, written: Date | null, at: Date): IssueState {
  if (recordStatus === undefined || !writtenBy(written, at)) return 'open'
  return recordStatus === 'acknowledged' || recordStatus === 'rejected' || recordStatus === 'resolved'
    ? recordStatus
    : 'open'
}

/** 还欠着的读法：最重的在前，同档里搁得久的在前。 */
function standingOrder(left: IssueReading, right: IssueReading): number {
  const rank = SEVERITY_RANK[left.severity ?? ''] ?? 9
  const other = SEVERITY_RANK[right.severity ?? ''] ?? 9
  if (rank !== other) return rank - other
  return (left.discoveredAt?.getTime() ?? 0) - (right.discoveredAt?.getTime() ?? 0)
}

/** 放下的读法：新近动过的在前。 */
function closedOrder(left: IssueReading, right: IssueReading): number {
  return touchedAt(right) - touchedAt(left)
}

/** 这一条最后动过的那一刻：记录里没记最后改动，就取它发现的那一刻。 */
function touchedAt(row: IssueReading): number {
  return (row.updatedAt ?? row.discoveredAt)?.getTime() ?? 0
}

/** 一堆的加权和：不压线的那几条不进这个和。 */
function sumWeight(entries: readonly IssueReading[]): number {
  return entries.filter((entry) => entry.payable).reduce((total, entry) => total + entry.weight, 0)
}

/** 写下来的那一段字才出的字段：没写（或者不是一段字）就没有这个字段，不拿空串顶位。 */
function field<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {}
  if (value !== undefined) out[key] = value
  return out
}