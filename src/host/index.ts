/**
 * 宿主半身这一个插件的入口：在宿主上装一条服务 `pathfinderRecords`。
 *
 * 它自己不带数据、也不缓存：每次调用现场按会话身份解析工作区根，再从那个工作区里把
 * 记录读出来。于是「面板印的每个字都来自当前工作区」这条在结构上就成立——换个工作区，
 * 换条会话，读到的就是那一份。
 *
 * 三件事都取自 ctx：工作区文件口子（`workspaceFiles`，读与列目录的唯一入口）、会话
 * （`sessions`，拿会话头里的工作区根）、沙箱策略（`sandboxPolicy`，会话头没写 cwd 时的
 * 落脚点——与工作区文件口子自己那条解析同一口径）。写回那一侧的口子一概没进这个模块。
 *
 * 这份源码按 DSH 的插件写法写成可直接加载的形态（没有装饰器一类的语法），因此既能在
 * 构建前由覆盖层按绝对路径加载，也能在构建后由 `lib/host/index.js` 供别的插件消费。
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
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { readReading } from './records.ts'
import type { PathfinderReading, PathfinderRecords } from './contract.ts'

export type * from './contract.ts'
export { readReading, readWholeFile } from './records.ts'
export type { PathfinderScope, WorkspaceFilesPort } from './records.ts'

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
  ctx.provide('pathfinderRecords', createRecords(ctx))
}

/** 把 ctx 的几口服务收成那条对外的接口。 */
function createRecords(ctx: Context): PathfinderRecords {
  return {
    async read(sessionId: SessionId, options = {}): Promise<PathfinderReading> {
      const signal = options.signal ?? new AbortController().signal
      const workspaceRoot = await workspaceRootOf(ctx, sessionId)
      return readReading(ctx.workspaceFiles, { sessionId, workspaceRoot }, signal)
    },
  }
}

/**
 * 按会话身份解析工作区根：先问活着的会话，**有活着的会话头就不再问落盘的头**；两处都没有
 * cwd（含整条会话没人认得）时落到沙箱策略记的那个根。工作区文件口子自己那条解析用的也是
 * 这个次序，所以这里解析出来的根与它读文件时认的那个根是同一个。
 * @param ctx - 宿主上下文。
 * @param sessionId - 会话身份。
 * @returns 那条会话的工作区根，绝对路径。
 */
async function workspaceRootOf(ctx: Context, sessionId: SessionId): Promise<string> {
  const live = ctx.sessions.get(sessionId)?.header
  const stored = live === undefined ? await ctx.get('sessionPersistence')?.stat(sessionId) : undefined
  const cwd = (live ?? stored?.header)?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return ctx.sandboxPolicy.workspaceRoot
}