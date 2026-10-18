/**
 * 宿主半身的远端口：面板要的读数与每一次落笔，都从这里出这一层。
 *
 * 这一层与 `index.ts` 那条服务是同一条东西的两面：`read` 就是外面那条读记录的
 * 服务，另外几条是写面，末一对是这个工作区自己的项目设置（读一行、写一行，都经工具
 * 那条命令）。每个端点上挂着一枚 `Remote` 记号——DSH 的网关按类上的记号现认这些端点
 * （源码模式），所以这一格不必等一个类型生成器就能被浏览器半身叫到；
 * 记号里的方法名就是端点名，命名空间是服务键 `pathfinderRecords`。
 *
 * 记号按函数调用的形式挂上去，写在构造函数里：这个半身的源码要能被 Node 直接加载
 * （`node --test` 就是这么读 `.ts` 的），而类型剥离不认 `@Remote(...)` 那一路装饰器
 * 语法。同一枚装饰器、同一个记号，落点一处不差。
 *
 * 工作区根由调用方点名：面板顶上那枚工作区选择器挑中哪个，那个绝对路径就从参数里进来；
 * 空字符串是「没挑」，那时候才按会话身份现算。两种情况都不缓存——换一个工作区，读到的与
 * 写到的当场就是那一份。
 *
 * @module dsh-pathfinder/host/gateway
 */
import type { Context } from '@deepseek-ai/cordis'
/* 三样服务各自的声明合并住在各自的包入口上（与 `index.ts` 同一句话）。 */
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { bindTypertRemote, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertGatewayBinding } from '@deepseek-ai/dsh-typert-protocol'
import type { PathfinderReading, PathfinderReadOptions, PathfinderRecords } from './contract.ts'
import { CONFIG_KEYS, parseConfigList, type ConfigKey, type PathfinderConfigReading } from './project-config.ts'
import { readReading } from './records.ts'
import { readSessionNotes, type PathfinderSessionsReading } from './sessions.ts'
import { runPf, type PfOutcome } from './write.ts'

/** 一条线自己那三个策略数里能写的那几个键。 */
export type CyclePolicyKey = 'parallel' | 'test_seconds_limit' | 'issue_pool_weight_limit'

/** 这一类落笔认得的那几个键，与工具那边的写法逐字相同。 */
export const CYCLE_POLICY_KEYS: readonly CyclePolicyKey[] = [
  'parallel',
  'test_seconds_limit',
  'issue_pool_weight_limit',
]

/** 端点表：左边是类上的方法名，右边是浏览器半身叫的那个名字。 */
const REMOTE_METHODS: readonly (readonly [string, string])[] = [
  ['read', 'read'],
  ['archiveInstruction', 'archiveInstruction'],
  ['reviveInstruction', 'reviveInstruction'],
  ['removeInstruction', 'removeInstruction'],
  ['setCyclePolicy', 'setCyclePolicy'],
  ['readConfig', 'readConfig'],
  ['setConfig', 'setConfig'],
  ['readSessions', 'readSessions'],
]

/**
 * 给一个实例上的方法挂上端点记号。
 *
 * 标准装饰器把记号交给构造期的一段初始化回调去落；这里直接把那段回调叫一次，
 * `this` 给的是这个实例，于是记号落在它原型上的同一个位置——网关读记号的那一路
 * 分不出这两者。
 * @param instance - 刚造出来的那个实例。
 * @param method - 类上的方法名。
 * @param endpoint - 端点名。
 */
function markRemote(instance: object, method: string, endpoint: string): void {
  const implementation: unknown = Reflect.get(instance, method)
  const decorate = Remote(endpoint) as unknown as (fn: unknown, context: unknown) => void
  decorate(implementation, {
    kind: 'method',
    name: method,
    private: false,
    static: false,
    addInitializer: (callback: (this: object) => void) => { callback.call(instance) },
  })
}

/**
 * 宿主半身对浏览器半身的那一张脸。
 *
 * 它不继承 cordis 的 `Service`：这一格要的只是「把自己的名字与端点记号挂在自己
 * 身上」这一件事，`bindTypertRemote` 就够；少一层基类，测试里那份最小上下文也
 * 照旧装得上它。
 */
export class PathfinderRecordsGateway implements PathfinderRecords {
  /** 网关按它现认端点的那个绑定；名字与 `ctx.provide` 的那把钥匙必须一致。 */
  readonly typertRemote: TypertGatewayBinding<this>
  /** 这个半身拿宿主上下文的那条路——与 `Service` 那个基类同名，网关也从这里读。 */
  readonly ctx: Context

  /**
   * @param ctx - 宿主上下文。
   * @param serviceKey - 服务键，也就是远程命名空间；平常不必给。
   */
  constructor(ctx: Context, serviceKey = 'pathfinderRecords') {
    this.ctx = ctx
    for (const [method, endpoint] of REMOTE_METHODS) markRemote(this, method, endpoint)
    this.typertRemote = bindTypertRemote(this, serviceKey)
  }

  /**
   * 把点名那个工作区里的四份记录读出来。
   *
   * 参数表里不给默认值、末尾不留逗号：网关按方法源码认参数，那两种写法都会被它判成
   * 「签名说不清」而整条端点叫不动。省掉最后那个取消信号跟传一个空对象是同一件事。
   * @param sessionId - 会话身份；工作区文件口子按它认路径。
   * @param workspaceRoot - 要读的那个工作区根；空字符串＝这条会话自己那个根。
   * @param options - 可选的取消信号。
   * @returns 那个工作区里的记录，原样。
   */
  async read(sessionId: SessionId, workspaceRoot: string, options?: PathfinderReadOptions): Promise<PathfinderReading> {
    const signal = options?.signal ?? new AbortController().signal
    const root = await rootFor(this.ctx, sessionId, workspaceRoot)
    return readReading(this.ctx.workspaceFiles, { sessionId, workspaceRoot: root }, signal)
  }

  /**
   * 归档一条指令：它从记录里还在生效的那一堆挪进归档，句子留在原处。
   * @param sessionId - 会话身份。
   * @param workspaceRoot - 要写的那个工作区根；空字符串＝这条会话自己那个根。
   * @param id - 指令身份。
   * @returns 工具说了什么。
   */
  async archiveInstruction(sessionId: SessionId, workspaceRoot: string, id: string): Promise<PfOutcome> {
    return this.pf(sessionId, workspaceRoot, ['instruction', 'resolve', id, '--state', 'withdrawn'])
  }

  /**
   * 把一条归档的指令放回生效那一堆。
   * @param sessionId - 会话身份。
   * @param workspaceRoot - 要写的那个工作区根；空字符串＝这条会话自己那个根。
   * @param id - 指令身份。
   * @returns 工具说了什么。
   */
  async reviveInstruction(sessionId: SessionId, workspaceRoot: string, id: string): Promise<PfOutcome> {
    return this.pf(sessionId, workspaceRoot, ['instruction', 'revive', id])
  }

  /**
   * 把一条指令连正文一起从记录里拿走；这一步退不回去，界面落手前要先把原话摆出来。
   * @param sessionId - 会话身份。
   * @param workspaceRoot - 要写的那个工作区根；空字符串＝这条会话自己那个根。
   * @param id - 指令身份。
   * @returns 工具说了什么。
   */
  async removeInstruction(sessionId: SessionId, workspaceRoot: string, id: string): Promise<PfOutcome> {
    return this.pf(sessionId, workspaceRoot, ['instruction', 'rm', id])
  }

  /**
   * 写一条线自己的一个策略数。
   *
   * 参数表写在一行里、末尾不留逗号：网关按方法源码切参数，它先按逗号分段再逐段认
   * 名字，末尾那一个逗号会切出一段空字符串，于是整条端点被它判成「签名说不清」。
   * @param sessionId - 会话身份。
   * @param workspaceRoot - 要写的那个工作区根；空字符串＝这条会话自己那个根。
   * @param cycle - 线路身份。
   * @param key - 三个键里的一个。
   * @param value - 正整数；`off` 是「这条线没立这一条」。
   * @returns 工具说了什么。
   */
  async setCyclePolicy(sessionId: SessionId, workspaceRoot: string, cycle: string, key: CyclePolicyKey, value: string): Promise<PfOutcome> {
    if (!CYCLE_POLICY_KEYS.includes(key)) return { ok: false, text: `无法识别的策略键：${key}` }
    return this.pf(sessionId, workspaceRoot, ['cycle', 'policy', cycle, key, value])
  }

  /**
   * 把点名那个工作区的项目设置读出来。
   *
   * 读的是工具印的那四行——值住三层（出厂默认 / 全局 / 项目），有效值与它来自哪一层都只有
   * 工具说得清：全局那一层住在家目录里，工作区文件口子看不进去。所以这一手起一条命令，而不是
   * 读一份文件。
   * @param sessionId - 会话身份。
   * @param workspaceRoot - 要读的那个工作区根；空字符串＝这条会话自己那个根。
   * @returns 工具印出来的每一行，连同它这一趟成了没有。
   */
  async readConfig(sessionId: SessionId, workspaceRoot: string): Promise<PathfinderConfigReading> {
    const project = await rootFor(this.ctx, sessionId, workspaceRoot)
    const outcome = await runPf(this.ctx, project, ['config', 'list'], new AbortController().signal)
    return {
      project,
      ok: outcome.ok,
      text: outcome.text,
      entries: outcome.ok ? parseConfigList(outcome.text) : {},
    }
  }

  /**
   * 写一条项目设置。改的永远是**这个项目那一层**：不带 `--global`（那一层跟着人走，面板这一格
   * 改的是这个工作区自己的事）。
   *
   * 没有 `--project <根>` 这一手：命令就跑在工作区根上，`config set` 的 `--project` 默认是当前
   * 目录——落点一处不差，而写面那条命令行里的路径一律不过参数闸（它只放行 `[A-Za-z0-9_.:+-]`，
   * Windows 的路径带反斜杠，加引号又会被 cmd 认错）。
   *
   * 值合不合法由工具判：它那一条 `parse_value` 是唯一的判据，非零退出时什么都没落盘。这一手
   * 只拦键——不认得的键不往命令行上递。
   * @param sessionId - 会话身份。
   * @param workspaceRoot - 要写的那个工作区根；空字符串＝这条会话自己那个根。
   * @param key - 设置键。
   * @param value - 要写进去的值。
   * @returns 工具说了什么。
   */
  async setConfig(sessionId: SessionId, workspaceRoot: string, key: string, value: string): Promise<PfOutcome> {
    if (!CONFIG_KEYS.includes(key as ConfigKey)) return { ok: false, text: `无法识别的设置键：${key}` }
    return this.pf(sessionId, workspaceRoot, ['config', 'set', key, value])
  }

  /**
   * 把点名那个工作区里每一格的会话笔记读出来。
   *
   * 读的是记录库里那一层按节点分的小份笔记——会话身份住在这台机器自己的笔记上（一条会话
   * 只在开它的那台机器上活着）。它与四份记录一样住在工作区里，所以走同一条只读口子。
   * @param sessionId - 会话身份。
   * @param workspaceRoot - 要读的那个工作区根；空字符串＝这条会话自己那个根。
   * @returns 每一格最近开过的那条会话，连同这一层笔记的结局。
   */
  async readSessions(sessionId: SessionId, workspaceRoot: string): Promise<PathfinderSessionsReading> {
    const root = await rootFor(this.ctx, sessionId, workspaceRoot)
    return readSessionNotes(this.ctx.workspaceFiles, { sessionId, workspaceRoot: root }, new AbortController().signal)
  }

  /** 一条写命令：先定根（点名的那个，或这条会话自己那个），再交给工具那一层。 */
  private async pf(sessionId: SessionId, workspaceRoot: string, args: readonly string[]): Promise<PfOutcome> {
    const root = await rootFor(this.ctx, sessionId, workspaceRoot)
    return runPf(this.ctx, root, args, new AbortController().signal)
  }
}

/**
 * 这一次动的是哪个工作区根：调用方点名了就用它，没点名（空字符串，或这一格压根没带这个参数）
 * 才按会话身份解析。
 *
 * 点名优先是这一层的全部意义：面板顶上那枚选择器让读者挑一个工作区，而那条会话此刻落在哪个
 * 工作区与读者要看哪一个没有关系。
 * @param ctx - 宿主上下文。
 * @param sessionId - 会话身份。
 * @param workspaceRoot - 点名的工作区根，绝对路径；空字符串＝没点名。
 * @returns 这一次的工作区根，绝对路径。
 */
export async function rootFor(ctx: Context, sessionId: SessionId, workspaceRoot: string): Promise<string> {
  if (typeof workspaceRoot === 'string' && workspaceRoot.length > 0) return workspaceRoot
  return workspaceRootOf(ctx, sessionId)
}

/**
 * 按会话身份解析工作区根：先问活着的会话，**有活着的会话头就不再问落盘的头**；两处都没有
 * cwd（含整条会话没人认得）时落到沙箱策略记的那个根。工作区文件口子自己那条解析用的也是
 * 这个次序，所以这里解析出来的根与它读文件时认的那个根是同一个。
 * @param ctx - 宿主上下文。
 * @param sessionId - 会话身份。
 * @returns 那条会话的工作区根，绝对路径。
 */
export async function workspaceRootOf(ctx: Context, sessionId: SessionId): Promise<string> {
  const live = ctx.sessions.get(sessionId)?.header
  const stored = live === undefined ? await ctx.get('sessionPersistence')?.stat(sessionId) : undefined
  const cwd = (live ?? stored?.header)?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return ctx.sandboxPolicy.workspaceRoot
}