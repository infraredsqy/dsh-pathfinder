/**
 * Instructions' visibility and the ledger's grouping: which sentences still
 * count at that moment, and which group they land in on the page.
 *
 * Everything is computed from the instruction's own fields: `state` says
 * whether it is still in force, `at` and `resolved_at` say whether it had
 * happened by that moment, `scope` says whose head it sits on and which group
 * it belongs to — all three must hold. The state has only two words, `live`
 * and `withdrawn`, judged by a single comparison against `live`; legacy
 * values left over in existing records that the tool no longer claims are not
 * folded and all
 * read as archived, and reading one must never throw. What cannot be measured
 * always counts: a binding to a cycle or node no longer present, or an
 * unrecognized scope spelling, all read as in force.
 */
import type { PathfinderInstruction } from './records.ts'
import type { CycleReading, InstructionGroupReading, InstructionReading, NodeReading, ProjectReading } from './contract.ts'
import { cutAt, text, toMoment } from './fields.ts'

/**
 * Read the instructions at that moment.
 *
 * Sentences not yet spoken by that moment (`at` unwritten, or later than it)
 * are not in this reading: no moment in the record, no sentence. Whether one
 * counts is judged only among the spoken ones.
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
    /* Still standing = the word says `live` and no already-reached moment has collected it. A different word in the record (legacy values included), or no readable word at all, counts as archived: anything but `live` is never in force. */
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
 * Group the ledger's entries by scope.
 *
 * The scope word is read exactly once, here: unrecognized spellings get no
 * word list of their own — their reading defers to the scope reading (in
 * scope), and they land in the "this node" group. Within a group,
 * still-counting entries come first, newly spoken ones first, so the reader
 * meets the sentences currently governing them first; empty groups are not
 * collected.
 * @param entries - The entries that truly go on the page at this moment; whether archived ones show is the caller's prior filter.
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