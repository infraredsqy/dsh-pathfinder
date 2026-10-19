/**
 * 宿主半身这一个插件的入口：在宿主上装一条服务 `pathfinderRecords`。
 *
 * 它自己不带数据、也不缓存：每次调用现场按会话身份解析工作区根。起进程的口子不在 `inject` 里，
 * 写面现取，取不到就把那一手拒掉，不让整条插件卡在待装状态。
 *
 * 出口面只有插件协议要的那四样（`name` / `inject` / `apply` / `Config`）外加网关类本身：装这一
 * 行的是 DSH 的插件行装载器（挂载点见 `cordis.patch.yml`），它只读那四样，仓内另一处消费者是
 * `tests/host-plugin`；网关类的读者是自证夹具 `tools/panel-check.mjs`——它拿一份假宿主上下文
 * 现造一个网关来驱动面板。其余都是内部件，各有各的模块；浏览器半身与测试都走深路径直引，
 * 不从入口过一遍——入口面上没人用的名字一律不摆。
 */
import type { Context } from '@deepseek-ai/cordis'
/* 三样服务的声明合并住在各自的包入口里：`apply` 装服务前它们得先在 Context 的类型上站住。
 * 全是类型引用，运行时与产物里什么都不进。 */
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import { Config } from './config.ts'
import { PathfinderRecordsGateway } from './gateway.ts'
import type { PathfinderRecords } from './contract.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 宿主半身的读记录服务；浏览器半身这一格要的那条接口就是它。 */
    pathfinderRecords: PathfinderRecords
  }
}

/** 插件行自己的名字；DSH 的插件协议按它认这一行。 */
export const name = 'pathfinder-records'

/** 这三样到齐之后 `apply` 才会跑；DSH 的插件协议在装配前读它。 */
export const inject = ['workspaceFiles', 'sessions', 'sandboxPolicy']

/**
 * 这一行的设置 schema；DSH 的插件协议拿它建那一节的设置命名空间。
 * 宿主没摆 schemastery 时它是 `undefined`——DSH 照这一条认出「没有表单」，这一行也就不
 * 占设置里的位置。
 */
export { Config }

/** 网关类本身；自证夹具 `tools/panel-check.mjs` 用假宿主上下文现造一个来驱动面板。 */
export { PathfinderRecordsGateway }

/**
 * 装上 `ctx.pathfinderRecords`。服务随这条插件所在的那根 fiber 一起卸载。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx: Context): void {
  ctx.provide('pathfinderRecords', new PathfinderRecordsGateway(ctx))
}
