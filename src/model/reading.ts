/**
 * 面板落到字面之前要的两个判定：四份来源是不是都落在同一个结局上，一条线的明细收哪些格。
 *
 * 判读归这一层，画的那一层只取着用：这两条只吃读数、不碰 DOM，在这一层才量得出、锁得住。
 */
import type { PathfinderReading, PathfinderSourceState } from '../host/contract.ts'
import type { CycleReading, NodeReading, ProjectReading } from './contract.ts'

/** 明细那五组的钥匙：等待处理、进行中、可开工、未开始、已交付。 */
export type DetailGroupKey = 'shelved' | 'run' | 'ready' | 'wait' | 'done'

/**
 * 四份来源是不是都落在同一个结局上。
 *
 * 一份来源都没有（这份读数还没列到任何一份）时不算：空集与「全都在」是两件事——前者还
 * 没读，后者才是读出来的结论。
 */
export function everySourceIs(reading: PathfinderReading, state: PathfinderSourceState): boolean {
  const states = Object.values(reading.sources)
  return states.length > 0 && states.every((one) => one === state)
}

/**
 * 一条线自己那一段明细收哪些格：走过它的算，它此刻正握着的也算。
 *
 * 已交付那段按交付时刻新的在前——读者从上往下，是刚做完的到早做完的。
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
