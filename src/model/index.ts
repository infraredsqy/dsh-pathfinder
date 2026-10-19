/**
 * 模型层的入口：四份记录 + 一个时刻 → 那一刻的读数。
 *
 * 它不取数（记录由数据桥那一格递进来）、不画界面、不碰 DOM，也没有全局状态：同一份输入给
 * 同一份输出。
 */
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