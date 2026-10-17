/**
 * 指令的可见性：那一刻哪几句还算数。
 *
 * 只从指令自己的字段算：`state` 说的是一句还在不在生效中、`at` 与 `resolved_at` 说的是那一刻
 * 它有没有发生、`scope` 说的是它管在谁头上。三样都得站得住，这一句才算数。
 *
 * 状态只有两个词：`live`（生效中）与 `withdrawn`（已归档），工具那一头的读法是「不是 `live`
 * 的一律算已归档」。存量记录里还留着它不再认领的旧值（`done`、`superseded`、`applied`、
 * `n/a` 这些词）——没人认领的写法不折算、也不替它改写，一律按已归档读。所以这里没有取值集
 * 合，也不另写一份词表：判据就是与 `live` 这一个词比一次，读到旧值不许抛。
 *
 * 量不着的东西一律**算**：绑上一条记录里已经不在的线或者一格、范围是这里不认识的写法——
 * 这些都按算数读。一句读者看不见的要求，对读者来说等于不存在。
 *
 * @module dsh-pathfinder/model/instructions
 */
import type { PathfinderInstruction } from '../host/contract.ts'
import type { CycleReading, InstructionReading, NodeReading } from './contract.ts'
import { cutAt, text, toMoment } from './fields.ts'

/**
 * 读那一刻的指令。
 *
 * 那一刻还没说出口的那几句（`at` 没写、或者晚于那一刻）**不在这份读数里**：记录里没有那
 * 一刻，就没有这一句。算不算数只在说出口的那几句里判。
 *
 * @param source - 指令那一份，记录原样。
 * @param nodeById - 那一刻的节点读数：绑在某一格上的句子，按那一格在那一刻的状态量。
 * @param cycleById - 那一刻的线路读数：绑在某条线上的句子，按那条线在不在服务里量。
 * @param at - 读到哪一刻。
 */
export function readInstructions(
  source: readonly PathfinderInstruction[],
  nodeById: Readonly<Record<string, NodeReading>>,
  cycleById: Readonly<Record<string, CycleReading>>,
  at: Date,
): readonly InstructionReading[] {
  const out: InstructionReading[] = []
  for (const entry of source) {
    const saidAt = cutAt(toMoment(entry.at), at)
    if (saidAt === null) continue
    const closedAt = cutAt(toMoment(entry.resolved_at), at)
    const recordState = text(entry.state)
    const scope = text(entry.scope)
    const cycleId = text(entry.cycle) ?? null
    const nodeId = text(entry.node) ?? null
    /* 还站着 ＝ 词说的是 `live`，且没有一个已经到的那一刻把它收掉。记录里写的是别的词
     * （含存量旧值）、或者这里根本读不出一个词，都算已归档：非 `live` 一律不生效。 */
    const standing = recordState === 'live' && closedAt === null
    const inScope = scope === 'cycle' && cycleId !== null
      ? (cycleById[cycleId]?.inService ?? true)
      : scope === 'node' && nodeId !== null
        ? nodeById[nodeId]?.state !== 'completed'
        : true
    const text_ = text(entry.text)
    out.push({
      id: text(entry.id) ?? '',
      saidAt,
      closedAt,
      cycleId,
      nodeId,
      standing,
      inScope,
      inForce: standing && inScope,
      ...(text_ !== undefined ? { text: text_ } : {}),
      ...(recordState !== undefined ? { recordState } : {}),
      ...(scope !== undefined ? { scope } : {}),
    })
  }
  return out
}