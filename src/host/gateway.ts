/**
 * 宿主半身的远端口：面板要的读数与每一次落笔，都从这里出这一层。
 *
 * 这一层与 `index.ts` 那条服务是同一条东西的两面：`read` 就是外面那条读记录的
 * 服务，另外四条是写面。每个端点上挂着一枚 `Remote` 记号——DSH 的网关按类上的记号
 * 现认这些端点（源码模式），所以这一格不必等一个类型生成器就能被浏览器半身叫到；
 * 记号里的方法名就是端点名，命名空间是服务键 `pathfinderRecords`。
 *
 * 记号按函数调用的形式挂上去，写在构造函数里：这个半身的源码要能被 Node 直接加载
 * （`node --test` 就是这么读 `.ts` 的），而类型剥离不认 `@Remote(...)` 那一路装饰器
 * 语法。同一枚装饰器、同一个记号，落点一处不差。
 *
 * 工作区根一律按会话身份现算、不缓存：换个工作区或换条会话，读到的与写到的都是
 * 那一份。
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
import { readReading } from './records.ts'
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
   * 把那条会话所在工作区里的四份记录读出来。
   *
   * 第二个参数写成可选、**不给默认值**：网关按方法源码认参数，带默认值的那一版会被
   * 它判成「签名说不清」而整条端点叫不动。省掉它跟传一个空对象是同一件事。
   * @param sessionId - 会话身份；工作区根由它自己的会话头解析。
   * @param options - 可选的取消信号。
   * @returns 那个工作区里的记录，原样。
   */
  async read(sessionId: SessionId, options?: PathfinderReadOptions): Promise<PathfinderReading> {
    const signal = options?.signal ?? new AbortController().signal
    const workspaceRoot = await workspaceRootOf(this.ctx, sessionId)
    return readReading(this.ctx.workspaceFiles, { sessionId, workspaceRoot }, signal)
  }

  /**
   * 归档一条指令：它从记录里还在生效的那一堆挪进归档，句子留在原处。
   * @param sessionId - 会话身份。
   * @param id - 指令身份。
   * @returns 工具说了什么。
   */
  async archiveInstruction(sessionId: SessionId, id: string): Promise<PfOutcome> {
    return this.pf(sessionId, ['instruction', 'resolve', id, '--state', 'withdrawn'])
  }

  /**
   * 把一条归档的指令放回生效那一堆。
   * @param sessionId - 会话身份。
   * @param id - 指令身份。
   * @returns 工具说了什么。
   */
  async reviveInstruction(sessionId: SessionId, id: string): Promise<PfOutcome> {
    return this.pf(sessionId, ['instruction', 'revive', id])
  }

  /**
   * 把一条指令连正文一起从记录里拿走；这一步退不回去，界面落手前要先把原话摆出来。
   * @param sessionId - 会话身份。
   * @param id - 指令身份。
   * @returns 工具说了什么。
   */
  async removeInstruction(sessionId: SessionId, id: string): Promise<PfOutcome> {
    return this.pf(sessionId, ['instruction', 'rm', id])
  }

  /**
   * 写一条线自己的一个策略数。
   *
   * 参数表写在一行里、末尾不留逗号：网关按方法源码切参数，它先按逗号分段再逐段认
   * 名字，末尾那一个逗号会切出一段空字符串，于是整条端点被它判成「签名说不清」。
   * @param sessionId - 会话身份。
   * @param cycle - 线路身份。
   * @param key - 三个键里的一个。
   * @param value - 正整数；`off` 是「这条线没立这一条」。
   * @returns 工具说了什么。
   */
  async setCyclePolicy(sessionId: SessionId, cycle: string, key: CyclePolicyKey, value: string): Promise<PfOutcome> {
    if (!CYCLE_POLICY_KEYS.includes(key)) return { ok: false, text: `不认得这个策略键：${key}` }
    return this.pf(sessionId, ['cycle', 'policy', cycle, key, value])
  }

  /** 一条写命令：现算工作区根，再交给工具那一层。 */
  private async pf(sessionId: SessionId, args: readonly string[]): Promise<PfOutcome> {
    const workspaceRoot = await workspaceRootOf(this.ctx, sessionId)
    return runPf(this.ctx, workspaceRoot, args, new AbortController().signal)
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
export async function workspaceRootOf(ctx: Context, sessionId: SessionId): Promise<string> {
  const live = ctx.sessions.get(sessionId)?.header
  const stored = live === undefined ? await ctx.get('sessionPersistence')?.stat(sessionId) : undefined
  const cwd = (live ?? stored?.header)?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return ctx.sandboxPolicy.workspaceRoot
}