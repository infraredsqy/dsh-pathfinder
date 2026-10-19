/**
 * 宿主半身与浏览器半身之间的类型契约：记录落点的位置与取数服务的形状。
 *
 * 记录原形（四份记录的字段直通副本）与取数结果的类型归模型层所有，住在 `src/model/records.ts`，
 * 宿主半身从这里转手再出口；本模块自己只留路径常量与服务的形状。
 *
 * 路径一律工作区相对：绝对根由宿主半身按会话身份解析，本模块里没有一台机器的路径。
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PathfinderReading, RecordSourceKey } from '../model/records.ts'

export type {
  PathfinderCycle,
  PathfinderHolding,
  PathfinderInstruction,
  PathfinderIssue,
  PathfinderNode,
  PathfinderReading,
  PathfinderSourceState,
  PathfinderStep,
} from '../model/records.ts'

/** 记录所在的那一层目录，工作区相对。 */
export const RECORD_DIR = '.pf'

/** 四份来源的工作区相对位置；键与模型层那份来源键（{@link RecordSourceKey}）一一对应。 */
export const RECORD_SOURCES: Readonly<Record<RecordSourceKey, string>> = {
  /** `ideas.json` 的 `nodes`，键是节点身份。 */
  nodes: `${RECORD_DIR}/ideas.json`,
  /** `state.json` 的 `cycles`，每条线自己带着走过的 `path`。 */
  cycles: `${RECORD_DIR}/state.json`,
  /** `instructions.json` 的 `instructions`。 */
  instructions: `${RECORD_DIR}/instructions.json`,
  /** `issues/issues.json` 的 `issues`，键是问题身份。 */
  issues: `${RECORD_DIR}/issues/issues.json`,
}

/**
 * 会话笔记住的那一层目录，工作区相对：一格一份小文件，文件名就是节点身份。
 *
 * 会话身份是这台机器自己的事，不跟着记录本体走——换一台机器、新克隆一份记录，
 * 这一层目录都不跟着走，面板据此把那几格读作「这台机器上没有去处」。
 */
export const RECORD_SESSIONS = `${RECORD_DIR}/meta/sessions`

/** 取数时可以带的东西。 */
export interface PathfinderReadOptions {
  readonly signal?: AbortSignal
}

/**
 * 宿主半身交给浏览器半身的那条服务：给它一条会话身份与一个工作区根，它把那个工作区里的
 * 记录读成一份读数。记录不在就是空读数（四份来源全 `missing`、集合全空）。
 *
 * 工作区根由调用方点名，挑哪一个读哪一个；空字符串是「没挑」，那时候按会话身份解析。
 */
export interface PathfinderRecords {
  /**
   * @param sessionId - 会话身份；工作区文件口子按它认路径，`workspaceRoot` 空着时也由它定根。
   * @param workspaceRoot - 要读的那个工作区根，绝对路径；空字符串＝这条会话自己那个根。
   * @param options - 可选的取消信号。
   * @returns 那个工作区里的记录，原样。
   */
  read(sessionId: SessionId, workspaceRoot: string, options?: PathfinderReadOptions): Promise<PathfinderReading>
}
