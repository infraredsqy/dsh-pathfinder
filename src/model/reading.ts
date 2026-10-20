/**
 * Two judgments the panel needs before it can put words on the screen: whether
 * the four sources all landed on the same outcome, and which nodes a cycle's
 * detail section collects.
 *
 * Judging belongs to this layer; the drawing layer only consumes the results:
 * these two take readings only and touch no DOM, so they can be measured and
 * pinned down here and nowhere else.
 */
import type { PathfinderReading, PathfinderSourceState } from './records.ts'
import type { CycleReading, NodeReading, ProjectReading } from './contract.ts'

/** The keys of the detail's five groups: shelved, running, ready, not started, completed. */
export type DetailGroupKey = 'shelved' | 'run' | 'ready' | 'wait' | 'done'

/**
 * Whether all four sources landed on the same outcome.
 *
 * When there is not a single source (this reading has not listed any yet), it
 * does not count: the empty set and "all of them are" are two different
 * things — the former has not been read, the latter is the conclusion drawn
 * from reading.
 */
export function everySourceIs(reading: PathfinderReading, state: PathfinderSourceState): boolean {
  const states = Object.values(reading.sources)
  return states.length > 0 && states.every((one) => one === state)
}

/**
 * Which nodes a cycle's own detail section collects: those it walked through,
 * and those it is holding right now.
 *
 * The completed section sorts newest completion first — reading top to
 * bottom, the reader goes from just-finished to finished long ago.
 */
export function nodesOf(key: DetailGroupKey, cycle: CycleReading, project: ProjectReading): readonly NodeReading[] {
  const mine = (list: readonly NodeReading[]): readonly NodeReading[] =>
    list.filter((node) => node.cycleIds[0] === cycle.id || node.heldBy.includes(cycle.id))
  if (key === 'shelved') return mine(project.columns.shelved)
  if (key === 'run') return mine(project.columns.running)
  if (key === 'ready') return mine(project.columns.ready)
  if (key === 'wait') return mine(project.columns.blocked)
  return mine(project.columns.completed)
    .slice()
    .sort((left, right) => (right.completedAt?.getTime() ?? 0) - (left.completedAt?.getTime() ?? 0))
}
