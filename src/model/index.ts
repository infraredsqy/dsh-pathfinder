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
export { depsWord, readGraph } from './graph.ts'
export { groupInstructions, readInstructions } from './instructions.ts'
export { latestSessionOf, readSessions } from './sessions.ts'
export { ISSUE_STATE_WORDS, readLine, readPool, readWeights } from './pool.ts'
export { everySourceIs, nodesOf } from './reading.ts'
export type { DetailGroupKey } from './reading.ts'
export { clock, dayLabel, duration, elapsedSince } from './format.ts'
export { cutAt, happenedAt, secondsBetween, text, toMoment, writtenBy } from './fields.ts'