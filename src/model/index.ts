/**
 * The model layer's entry: four records + one moment → the reading at that
 * moment.
 *
 * It fetches nothing (the records are handed in by the data bridge), draws no
 * UI, touches no DOM, and holds no global state: the same input always gives
 * the same output.
 */
export type * from './records.ts'
export type * from './contract.ts'
export { readProject } from './project.ts'
export { readDeps, readGraph } from './graph.ts'
export { groupInstructions, readInstructions } from './instructions.ts'
export { latestSessionOf, readSessions } from './sessions.ts'
export { readLine, readPool, readWeights } from './pool.ts'
export { everySourceIs, nodesOf } from './reading.ts'
export type { DetailGroupKey } from './reading.ts'
export { clock, dayParts, duration, durationParts, elapsedSince, agoParts } from './format.ts'
export type { AgoParts, DayParts, DurationParts } from './format.ts'
export { cutAt, happenedAt, secondsBetween, text, toMoment, writtenBy } from './fields.ts'