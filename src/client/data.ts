/**
 * 浏览器半身取数与落笔的那一条路。
 *
 * 读数一律从宿主半身来：这一层只把「哪条会话」递出去，把那一份读数拿回来。两条线
 * 都通到同一个端点，先走 DSH 那条装好的远程命名空间（`remote.pathfinderRecords`），
 * 命名空间没装上的部署退到载体那一层直接叫 `/api` 上的同一条端点——那条路正是生成
 * 出来的远程客户端自己走的路，只是省掉了一层类型外观。
 *
 * 端点名字符串只在这一份里出现一次；调用方拿到的是一条 `read`／几条写。
 *
 * @module dsh-pathfinder/client/data
 */
import type { PathfinderReading } from '../host/contract.ts'
import type { PathfinderConfigReading } from '../host/project-config.ts'
import type { PathfinderSessionsReading } from '../host/sessions.ts'
import type { PfOutcome } from '../host/write.ts'
import type { CyclePolicyKey } from '../host/gateway.ts'

/** 命名空间，与宿主半身那条服务键同名。 */
export const NAMESPACE = 'pathfinderRecords'

/** 写面认得的三个动作。 */
export type WriteVerb = 'archive' | 'revive' | 'remove'

/** 一条写命令对应宿主上的哪个端点、带哪几个参数。 */
const WRITE_ENDPOINTS: Readonly<Record<WriteVerb, string>> = {
  archive: 'archiveInstruction',
  revive: 'reviveInstruction',
  remove: 'removeInstruction',
}

/**
 * 面板要与宿主说话的那条口子。
 *
 * `source` 说的是这一条口子最后是从哪一层接上的：`remote` 是装好的远程命名空间，
 * `carrier` 是载体那一层，`none` 是两条都没接上——那时候每一次读都直接给出失败，
 * 面板照「取不到」画，编不出读数来。
 */
export interface PanelPort {
  readonly source: 'remote' | 'carrier' | 'none'
  /** 那条会话所在工作区里的四份记录。 */
  read(sessionId: string, signal?: AbortSignal): Promise<PathfinderReading>
  /** 这个工作区里每一格最近开过的那条会话：卡上那一下要去的地方。 */
  readSessions(sessionId: string): Promise<PathfinderSessionsReading>
  /** 归档 / 复原 / 删除一条指令。 */
  write(verb: WriteVerb, sessionId: string, id: string): Promise<PfOutcome>
  /** 写一条线自己的一个策略数。 */
  setPolicy(sessionId: string, cycle: string, key: CyclePolicyKey, value: string): Promise<PfOutcome>
  /** 这个工作区的项目设置：有效值与它住在哪一层，从工具那一条命令上来。 */
  readConfig(sessionId: string): Promise<PathfinderConfigReading>
  /** 写一条项目设置；落的永远是这个项目那一层。 */
  setConfig(sessionId: string, key: string, value: string): Promise<PfOutcome>
}

/** 一条读数回来的样子：成了给值，没成给一句能读的话。 */
type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/** 一个服务的最小形状：这一层只用得上它下面那几条方法。 */
type Service = Readonly<Record<string, unknown>>

/** 载体那一层的最小形状。 */
interface Carrier {
  readonly rpc?: {
    call(
      path: string,
      endpoint: string,
      payload: { readonly args: Readonly<Record<string, unknown>> },
      signal: AbortSignal | undefined,
    ): Promise<unknown>
  }
}

/**
 * 从上下文的几处入口现取一条服务。
 *
 * 三处都试：先问上下文自己的工作台，再问属性代理。取不到就是取不到——这一层不
 * 抛，调用方按「没有」处置。
 * @param owner - 一个上下文（插件自己的，或注入回调给的那个）。
 * @param name - 服务名。
 * @returns 那个服务，或 `undefined`。
 */
export function serviceAt(owner: unknown, name: string): Service | undefined {
  const holder = owner as { get?: (key: string) => unknown } | null | undefined
  if (holder !== null && holder !== undefined && typeof holder.get === 'function') {
    try {
      const value = holder.get(name)
      if (value !== undefined && value !== null) return value as Service
    } catch (error) {
      /* 没声明过的名字问上去会抛，这跟「没有」是同一件事。 */
    }
  }
  try {
    const value = (owner as Record<string, unknown> | null | undefined)?.[name]
    return value === undefined || value === null ? undefined : (value as Service)
  } catch (error) {
    return undefined
  }
}

/**
 * 接一条口子。
 * @param ctx - 插件上下文。
 * @returns 面板用的那条口子。
 */
export function createPanelPort(ctx: unknown): PanelPort {
  const remote = remoteNamespace(ctx)
  if (remote !== undefined) return remotePort(remote)
  const carrier = serviceAt(ctx, 'connection') as Carrier | undefined
  if (carrier?.rpc !== undefined) return carrierPort(carrier.rpc)
  return absentPort()
}

/** 装好的远程命名空间，两条取法都试一遍。 */
function remoteNamespace(ctx: unknown): Service | undefined {
  const direct = serviceAt(ctx, `remote.${NAMESPACE}`)
  if (direct !== undefined) return direct
  const remote = serviceAt(ctx, 'remote')
  if (remote === undefined) return undefined
  try {
    const namespace = remote[NAMESPACE]
    return namespace === undefined || namespace === null ? undefined : (namespace as Service)
  } catch (error) {
    /* 没声明过的命名空间在代理上读一下就会抛：这里按「没装上」处置。 */
    return undefined
  }
}

/** 一条读调用的参数：远程那一层按端点上的参数名摆，两个位置都在。 */
function readArgs(sessionId: string): Readonly<Record<string, unknown>> {
  return { sessionId, options: {} }
}

/** 远程命名空间那一条路。 */
function remotePort(namespace: Service): PanelPort {
  const call = async <T>(method: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Answer<T>> => {
    const implementation = namespace[method]
    if (typeof implementation !== 'function') return { ok: false, message: `这条口子上没有 ${method} 这一手。` }
    try {
      const answer = await (implementation as (...values: unknown[]) => Promise<unknown>).call(
        namespace,
        ...Object.values(args),
        ...(signal === undefined ? [] : [signal]),
      )
      return unwrap<T>(answer)
    } catch (error) {
      return { ok: false, message: textOf(error) }
    }
  }
  return {
    source: 'remote',
    async read(sessionId, signal) {
      const answer = await call<PathfinderReading>('read', readArgs(sessionId), signal)
      if (!answer.ok) throw new Error(answer.message)
      return answer.value
    },
    async readSessions(sessionId) {
      const answer = await call<PathfinderSessionsReading>('readSessions', { sessionId })
      if (!answer.ok) throw new Error(answer.message)
      return answer.value
    },
    async write(verb, sessionId, id) {
      const answer = await call<PfOutcome>(WRITE_ENDPOINTS[verb], { sessionId, id })
      return answer.ok ? answer.value : { ok: false, text: answer.message }
    },
    async setPolicy(sessionId, cycle, key, value) {
      const answer = await call<PfOutcome>('setCyclePolicy', { sessionId, cycle, key, value })
      return answer.ok ? answer.value : { ok: false, text: answer.message }
    },
    async readConfig(sessionId) {
      const answer = await call<PathfinderConfigReading>('readConfig', { sessionId })
      if (!answer.ok) throw new Error(answer.message)
      return answer.value
    },
    async setConfig(sessionId, key, value) {
      const answer = await call<PfOutcome>('setConfig', { sessionId, key, value })
      return answer.ok ? answer.value : { ok: false, text: answer.message }
    },
  }
}

/** 载体那一层：自己拼端点与参数，回来的还是 `{ ok, value }` 那一副脸。 */
function carrierPort(rpc: NonNullable<Carrier['rpc']>): PanelPort {
  const call = async <T>(method: string, args: Readonly<Record<string, unknown>>): Promise<Answer<T>> => {
    try {
      const answer = await rpc.call('/api', `${NAMESPACE}/${method}`, { args }, undefined)
      return unwrap<T>(answer)
    } catch (error) {
      return { ok: false, message: textOf(error) }
    }
  }
  return {
    source: 'carrier',
    async read(sessionId) {
      const answer = await call<PathfinderReading>('read', readArgs(sessionId))
      if (!answer.ok) throw new Error(answer.message)
      return answer.value
    },
    async readSessions(sessionId) {
      const answer = await call<PathfinderSessionsReading>('readSessions', { sessionId })
      if (!answer.ok) throw new Error(answer.message)
      return answer.value
    },
    async write(verb, sessionId, id) {
      const answer = await call<PfOutcome>(WRITE_ENDPOINTS[verb], { sessionId, id })
      return answer.ok ? answer.value : { ok: false, text: answer.message }
    },
    async setPolicy(sessionId, cycle, key, value) {
      const answer = await call<PfOutcome>('setCyclePolicy', { sessionId, cycle, key, value })
      return answer.ok ? answer.value : { ok: false, text: answer.message }
    },
    async readConfig(sessionId) {
      const answer = await call<PathfinderConfigReading>('readConfig', { sessionId })
      if (!answer.ok) throw new Error(answer.message)
      return answer.value
    },
    async setConfig(sessionId, key, value) {
      const answer = await call<PfOutcome>('setConfig', { sessionId, key, value })
      return answer.ok ? answer.value : { ok: false, text: answer.message }
    },
  }
}

/** 两条都没接上时的那条口子：每一次读都明说取不到。 */
function absentPort(): PanelPort {
  const missing = async (): Promise<never> => {
    throw new Error('这个部署上没接上寻路记录的远程端，读数取不回来。')
  }
  const refused = async (): Promise<PfOutcome> => ({ ok: false, text: '这个部署上没有落笔那条口子。' })
  return { source: 'none', read: missing, readSessions: missing, write: refused, setPolicy: refused, readConfig: missing, setConfig: refused }
}

/** 把 `{ ok, value }` 那一副脸摊成这一层用的两分支。 */
function unwrap<T>(answer: unknown): Answer<T> {
  if (typeof answer !== 'object' || answer === null) return { ok: false, message: '宿主回了一个读不出来的东西。' }
  const held = answer as { ok?: unknown; value?: unknown; error?: unknown }
  if (held.ok === true) return { ok: true, value: held.value as T }
  return { ok: false, message: failureText(held.error) }
}

/** 远程失败说成一句话。 */
function failureText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const held = error as { message?: unknown; code?: unknown }
    if (typeof held.message === 'string' && held.message.length > 0) {
      return typeof held.code === 'string' && held.code.length > 0 ? `${held.code}: ${held.message}` : held.message
    }
  }
  return textOf(error)
}

/** 一个未知的东西说成一句话。 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}