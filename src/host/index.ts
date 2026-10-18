/**
 * 宿主半身这一个插件的入口：在宿主上装一条服务 `pathfinderRecords`。
 *
 * 它自己不带数据、也不缓存：每次调用现场按会话身份解析工作区根。起进程的口子不在 `inject` 里，
 * 写面现取，取不到就把那一手拒掉，不让整条插件卡在待装状态。
 */
import type { Context } from '@deepseek-ai/cordis'
/* 三样服务的声明合并住在各自的包入口里：只引 `…/types` 子路径拿不到那一段（`SessionId` 那个
 * 类型就在子路径上，`sessions` 服务不在这里）。三个包各引一次只为把 `workspaceFiles`／
 * `sessions`／`sandboxPolicy` 挂到 Context 上，全是类型引用，运行时与产物里什么都不进。 */
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import { PathfinderRecordsGateway } from './gateway.ts'
import type { PathfinderRecords } from './contract.ts'

export type * from './contract.ts'
export { Config } from './config.ts'
export { PathfinderRecordsGateway, rootFor, workspaceRootOf, CYCLE_POLICY_KEYS } from './gateway.ts'
export type { CyclePolicyKey } from './gateway.ts'
export { runPf } from './write.ts'
export type { PfOutcome } from './write.ts'
export { readReading, readWholeFile } from './records.ts'
export type { PathfinderScope, WorkspaceFilesPort } from './records.ts'
export { CONFIG_KEYS, parseConfigList } from './project-config.ts'
export type { ConfigEntry, ConfigKey, ConfigLayer, PathfinderConfigReading } from './project-config.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 宿主半身的读记录服务；浏览器半身这一格要的那条接口就是它。 */
    pathfinderRecords: PathfinderRecords
  }
}

/** 插件名。 */
export const name = 'pathfinder-records'

/** 这三样到齐之后 `apply` 才会跑。 */
export const inject = ['workspaceFiles', 'sessions', 'sandboxPolicy']

/**
 * 装上 `ctx.pathfinderRecords`。服务随这条插件所在的那根 fiber 一起卸载。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx: Context): void {
  ctx.provide('pathfinderRecords', new PathfinderRecordsGateway(ctx))
}