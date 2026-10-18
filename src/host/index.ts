/**
 * 宿主半身这一个插件的入口：在宿主上装一条服务 `pathfinderRecords`。
 *
 * 它自己不带数据、也不缓存：每次调用现场按会话身份解析工作区根，再从那个工作区里把
 * 记录读出来。于是「面板印的每个字都来自当前工作区」这条在结构上就成立——换个工作区，
 * 换条会话，读到的就是那一份。
 *
 * 三件事都取自 ctx：工作区文件口子（`workspaceFiles`，读与列目录的唯一入口）、会话
 * （`sessions`，拿会话头里的工作区根）、沙箱策略（`sandboxPolicy`，会话头没写 cwd 时的
 * 落脚点——与工作区文件口子自己那条解析同一口径）。写回那一侧不走工作区文件口子：它经
 * 工具那条命令落笔，见 `gateway.ts` 与 `write.ts`。
 *
 * 这条服务同时是远端口：类上那几枚 `@Remote` 记号就是浏览器半身叫得到的几个端点，
 * 命名空间与服务键同名（`pathfinderRecords`）。起进程的口子不在 `inject` 里——这一格
 * 的读面不靠它，写面现取，取不到就把那一手拒掉，不让整条插件卡在待装状态。
 *
 * 这份源码按 DSH 的插件写法写成可直接加载的形态，因此既能在构建前由覆盖层按绝对路径
 * 加载，也能在构建后由 `lib/host/index.js` 供别的插件消费。
 *
 * 这一份还交出 `Config`：DSH 里一条插件行就是一个设置命名空间，面板自己的那几个偏好
 * 因此住在这条插件行的设置文档里，schema 住在 `config.ts`。
 *
 * @module dsh-pathfinder/host
 */
import type { Context } from '@deepseek-ai/cordis'
/* 三样服务各自的声明合并住在各自的**包入口**里：只引 `…/types` 子路径拿不到那一段（`SessionId`
 * 那个类型就在子路径上，`sessions` 服务不在这里）。所以三个包各引一次，只为把 `workspaceFiles`／
 * `sessions`／`sandboxPolicy` 挂到 Context 上——全是类型引用，运行时与产物里什么都不进。 */
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