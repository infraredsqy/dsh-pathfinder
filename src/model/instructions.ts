/**
 * 指令的可见性与登记簿的分堆：那一刻哪几句还算数、摆上页面时归哪一组。
 *
 * 只从指令自己的字段算：`state` 说它还在不在生效中、`at` 与 `resolved_at` 说那一刻它有没有发生、
 * `scope` 说它管在谁头上、归哪一组，三样都得站得住。状态只有两个词：`live` 与 `withdrawn`，判据就是与
 * `live` 比一次；存量记录里那些工具不再认领的旧值不折算、一律按已归档读，读到旧值不许抛。
 * 量不着的东西一律算：绑上一条已经不在的线或一格、范围是不认识的写法，这些都按算数读。
 */
import type { PathfinderInstruction } from '../host/contract.ts'
import type { CycleReading, InstructionGroupReading, InstructionReading, NodeReading, ProjectReading } from './contract.ts'
import { cutAt, text, toMoment } from './fields.ts'

/**
 * 读那一刻的指令。
 *
 * 那一刻还没说出口的那几句（`at` 没写、或者晚于那一刻）不在这份读数里：记录里没有那一刻，
 * 就没有这一句。算不算数只在说出口的那几句里判。
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
    const note = text(entry.note)
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
      ...(note !== undefined ? { note } : {}),
      ...(recordState !== undefined ? { recordState } : {}),
      ...(scope !== undefined ? { scope } : {}),
    })
  }
  return out
}

/**
 * 把要摆上登记簿的那几条按范围分成组。
 *
 * 范围那个词只在这里读这一遍：认不得的写法不另立词表——它的读法以范围读数为准（管得着），
 * 组里落在「这一格」。组内还算数的排在前头、新说的在前，读者先遇到此刻正管着他的那几句；
 * 空组不收。
 * @param project - 那一刻的项目读数，分组用的几条线从它来。
 * @param entries - 这一刻真的要摆上页面的那几条；已归档的露不露面由调用方先筛过。
 */
export function groupInstructions(
  project: ProjectReading,
  entries: readonly InstructionReading[],
): readonly InstructionGroupReading[] {
  const groups = new Map<string, { label: string; entries: InstructionReading[] }>()
  const group = (key: string, label: string): { label: string; entries: InstructionReading[] } => {
    const held = groups.get(key)
    if (held !== undefined) return held
    const fresh = { label, entries: [] as InstructionReading[] }
    groups.set(key, fresh)
    return fresh
  }
  group('global', '全局')
  for (const cycle of project.cycles) group(`cycle:${cycle.id}`, cycle.id)
  group('cycle:', '未分组')
  group('node', '这一格')

  for (const entry of entries) {
    const key = entry.scope === 'global'
      ? 'global'
      : entry.scope === 'cycle'
        ? (entry.cycleId === null ? 'cycle:' : `cycle:${entry.cycleId}`)
        : 'node'
    group(key, key).entries.push(entry)
  }

  const order = ['global', ...[...groups.keys()].filter((key) => key.startsWith('cycle:') && key !== 'cycle:'), 'cycle:', 'node']
  const out: InstructionGroupReading[] = []
  for (const key of order) {
    const held = groups.get(key)
    if (held === undefined || held.entries.length === 0) continue
    held.entries.sort((left, right) => {
      const byForce = (left.inForce ? 0 : 1) - (right.inForce ? 0 : 1)
      if (byForce !== 0) return byForce
      return (right.saidAt?.getTime() ?? 0) - (left.saidAt?.getTime() ?? 0)
    })
    out.push({ key, label: held.label, entries: held.entries })
  }
  return out
}