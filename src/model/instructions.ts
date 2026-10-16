/**
 * 指令的可见性：那一刻哪几句还算数。
 *
 * 只从指令自己的字段算：`state` 说的是一句结没结掉、`at` 与 `resolved_at` 说的是那一刻它
 * 有没有发生、`scope` 说的是它管在谁头上。三样都得站得住，这一句才算数。
 *
 * 量不着的东西一律**算**：记录里没写的词、绑上一条记录里已经不在的线或者一格、范围是这里
 * 不认识的写法——这些都按算数读。一句读者看不见的要求，对读者来说等于不存在。
 *
 * @module dsh-pathfinder/model/instructions
 */
import type { PathfinderInstruction } from '../host/contract.ts'
import type { CycleReading, InstructionReading, NodeReading } from './contract.ts'
import { cutAt, text, toMoment } from './fields.ts'

/**
 * 终局词：写下这几个词里的一个，这一句就不算数了。
 * 别的写法（含没写）都按还算数读；记录里没有的写法，不替它折算成终局。
 */
const TERMINAL_STATES = new Set(['done', 'applied', 'n/a', 'withdrawn', 'superseded'])

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
    const closedRaw = toMoment(entry.resolved_at)
    const closedAt = cutAt(closedRaw, at)
    const recordState = text(entry.state)
    const scope = text(entry.scope)
    const cycleId = text(entry.cycle) ?? null
    const nodeId = text(entry.node) ?? null
    /* 收掉了没：那一刻之前收掉的就算收掉了；记录里根本没有那个时刻的时候，它自己那个终局 */
    /* 词才算数。两个字段说的是同一件事，哪一个先把话说死都按它读。 */
    const wordTerminal = recordState !== undefined && TERMINAL_STATES.has(recordState)
    const standing = closedAt === null && !(closedRaw === null && wordTerminal)
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