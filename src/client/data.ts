/**
 * 浏览器半身取数与落笔的那一条路：把「哪条会话」递出去，把那一份读数拿回来。
 *
 * 两条线都通到同一个端点：先走 DSH 那条装好的远程命名空间，命名空间没装上的部署退到载体那一层
 * 直接叫 `/api` 上的同一条端点。端点名字符串只在这一份里出现一次。
 */
import type { PathfinderReading } from '../host/contract.ts'
import type { PathfinderConfigReading } from '../host/project-config.ts'
import type { PathfinderSessionsReading } from '../host/sessions.ts'
import type { PfOutcome } from '../host/write.ts'
import type { CyclePolicyKey, InstructionScope } from '../host/gateway.ts'

/** 命名空间，与宿主半身那条服务键同名。 */
export const NAMESPACE = 'pathfinderRecords'

export type WriteVerb = 'archive' | 'revive' | 'remove'

/** 一条写命令对应宿主上的哪个端点。 */
const WRITE_ENDPOINTS: Readonly<Record<WriteVerb, string>> = {
  archive: 'archiveInstruction',
  revive: 'reviveInstruction',
  remove: 'removeInstruction',
}

/**
 * 面板要与宿主说话的那条口子。
 *
 * 每条口子都带一个 `workspaceRoot`：面板顶上那枚工作区选择器挑中的那个根（绝对路径），空字符串
 * ＝没挑，按这条会话自己那个根读。挑哪一个读哪一个——与这条会话落在哪个工作区无关。
 *
 * `source` 说的是这一条口子最后是从哪一层接上的：`remote` 是装好的远程命名空间，`carrier` 是
 * 载体那一层，`none` 是两条都没接上——那时候每一次读都直接给出失败，编不出读数来。
 */
export interface PanelPort {
  readonly source: 'remote' | 'carrier' | 'none'
  /** 点名那个工作区里的四份记录。 */
  read(sessionId: string, workspaceRoot: string, signal?: AbortSignal): Promise<PathfinderReading>
  /** 点名那个工作区里每一格最近开过的那条会话：卡上那一下要去的地方。 */
  readSessions(sessionId: string, workspaceRoot: string, signal?: AbortSignal): Promise<PathfinderSessionsReading>
  /** 记下一条指令：把用户的原话与范围递给工具。 */
  say(sessionId: string, workspaceRoot: string, text: string, scope: InstructionScope, cycle: string, node: string): Promise<PfOutcome>
  /** 归档 / 复原 / 删除一条指令。 */
  write(verb: WriteVerb, sessionId: string, workspaceRoot: string, id: string): Promise<PfOutcome>
  /** 写一条线自己的一个策略数。 */
  setPolicy(sessionId: string, workspaceRoot: string, cycle: string, key: CyclePolicyKey, value: string): Promise<PfOutcome>
  /** 点名那个工作区的项目设置：有效值与它住在哪一层，从工具那一条命令上来。 */
  readConfig(sessionId: string, workspaceRoot: string, signal?: AbortSignal): Promise<PathfinderConfigReading>
  /** 写一条项目设置；落的永远是这个项目那一层。 */
  setConfig(sessionId: string, workspaceRoot: string, key: string, value: string): Promise<PfOutcome>
}

type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/** 一个服务的最小形状：这一层只用得上它下面那几条方法。 */
type Service = Readonly<Record<string, unknown>>

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
 * 两处都试：先问上下文自己的 `get`，再问属性代理。取不到就是取不到——这一层不抛，调用方按
 * 「没有」处置。
 * @param owner - 一个上下文（插件自己的，或注入回调给的那个）。
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

/** 一条读调用的参数：三个位置都在。 */
function readArgs(sessionId: string, workspaceRoot: string): Readonly<Record<string, unknown>> {
  return { sessionId, workspaceRoot, options: {} }
}

/**
 * 每条端点按什么次序收实参：远程那一层按位置递参，实参照这张表摆。
 *
 * 端点换签名时这里跟着换——不靠「对象键序＝端点形参序」那条没有单一出处的约定，键序一变
 * 就静默错位的债不留在这一层。
 */
const REMOTE_PARAM_ORDER: Readonly<Record<string, readonly string[]>> = {
  read: ['sessionId', 'workspaceRoot', 'options'],
  readSessions: ['sessionId', 'workspaceRoot'],
  addInstruction: ['sessionId', 'workspaceRoot', 'text', 'scope', 'cycle', 'node'],
  archiveInstruction: ['sessionId', 'workspaceRoot', 'id'],
  reviveInstruction: ['sessionId', 'workspaceRoot', 'id'],
  removeInstruction: ['sessionId', 'workspaceRoot', 'id'],
  setCyclePolicy: ['sessionId', 'workspaceRoot', 'cycle', 'key', 'value'],
  readConfig: ['sessionId', 'workspaceRoot'],
  setConfig: ['sessionId', 'workspaceRoot', 'key', 'value'],
}

/** 端点这一趟收的那串实参：照形参表摆，表上没有的键不带。 */
function positional(method: string, args: Readonly<Record<string, unknown>>): readonly unknown[] {
  return (REMOTE_PARAM_ORDER[method] ?? []).map((key) => args[key])
}

/** 两条取数路各自交出的那一手：一条调用，回来的已经是摊开过的两分支。 */
type PortCall = <T>(
  method: string,
  args: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
) => Promise<Answer<T>>

/**
 * 面板那条口子的共同骨架：七条口子写一遍，两条路只差 call 那一层与 signal 怎么递。
 * @param source - 这一条口子最后是从哪一层接上的。
 * @param call - 端点名字、具名参数与中止信号递给它，它把答案摊成两分支。
 */
function portFromCall(source: PanelPort['source'], call: PortCall): PanelPort {
  return {
    source,
    async read(sessionId, workspaceRoot, signal) {
      const answer = await call<PathfinderReading>('read', readArgs(sessionId, workspaceRoot), signal)
      if (!answer.ok) throw new Error(answer.message)
      return answer.value
    },
    async readSessions(sessionId, workspaceRoot, signal) {
      const answer = await call<PathfinderSessionsReading>('readSessions', { sessionId, workspaceRoot }, signal)
      if (!answer.ok) throw new Error(answer.message)
      return answer.value
    },
    async say(sessionId, workspaceRoot, text, scope, cycle, node) {
      const answer = await call<PfOutcome>('addInstruction', { sessionId, workspaceRoot, text, scope, cycle, node })
      return answer.ok ? answer.value : { ok: false, text: answer.message }
    },
    async write(verb, sessionId, workspaceRoot, id) {
      const answer = await call<PfOutcome>(WRITE_ENDPOINTS[verb], { sessionId, workspaceRoot, id })
      return answer.ok ? answer.value : { ok: false, text: answer.message }
    },
    async setPolicy(sessionId, workspaceRoot, cycle, key, value) {
      const answer = await call<PfOutcome>('setCyclePolicy', { sessionId, workspaceRoot, cycle, key, value })
      return answer.ok ? answer.value : { ok: false, text: answer.message }
    },
    async readConfig(sessionId, workspaceRoot, signal) {
      const answer = await call<PathfinderConfigReading>('readConfig', { sessionId, workspaceRoot }, signal)
      if (!answer.ok) throw new Error(answer.message)
      return answer.value
    },
    async setConfig(sessionId, workspaceRoot, key, value) {
      const answer = await call<PfOutcome>('setConfig', { sessionId, workspaceRoot, key, value })
      return answer.ok ? answer.value : { ok: false, text: answer.message }
    },
  }
}

/** 远程命名空间那一条路：按形参表把实参摆成位置实参，signal 跟在最后。 */
function remotePort(namespace: Service): PanelPort {
  const call: PortCall = async <T>(
    method: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<Answer<T>> => {
    const implementation = namespace[method]
    if (typeof implementation !== 'function') return { ok: false, message: `这条通道上没有 ${method} 这个操作。` }
    try {
      const answer = await (implementation as (...values: unknown[]) => Promise<unknown>).call(
        namespace,
        ...positional(method, args),
        ...(signal === undefined ? [] : [signal]),
      )
      return unwrap<T>(answer)
    } catch (error) {
      return { ok: false, message: textOf(error) }
    }
  }
  return portFromCall('remote', call)
}

/** 载体那一层：自己拼端点与参数，回来的还是 `{ ok, value }` 那一副脸。 */
function carrierPort(rpc: NonNullable<Carrier['rpc']>): PanelPort {
  const call: PortCall = async <T>(
    method: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<Answer<T>> => {
    try {
      const answer = await rpc.call('/api', `${NAMESPACE}/${method}`, { args }, signal)
      return unwrap<T>(answer)
    } catch (error) {
      return { ok: false, message: textOf(error) }
    }
  }
  return portFromCall('carrier', call)
}

/** 两条都没接上时的那条口子：每一次读都明说取不到。 */
function absentPort(): PanelPort {
  const missing = async (): Promise<never> => {
    throw new Error('该部署未连接寻路记录服务，无法读取记录。')
  }
  const refused = async (): Promise<PfOutcome> => ({ ok: false, text: '该部署没有可用的写入通道。' })
  return { source: 'none', read: missing, readSessions: missing, say: refused, write: refused, setPolicy: refused, readConfig: missing, setConfig: refused }
}

/** 把 `{ ok, value }` 那一副脸摊成这一层用的两分支。 */
function unwrap<T>(answer: unknown): Answer<T> {
  if (typeof answer !== 'object' || answer === null) return { ok: false, message: '宿主返回了无法解析的数据。' }
  const held = answer as { ok?: unknown; value?: unknown; error?: unknown }
  if (held.ok === true) return { ok: true, value: held.value as T }
  return { ok: false, message: failureText(held.error) }
}

function failureText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const held = error as { message?: unknown; code?: unknown }
    if (typeof held.message === 'string' && held.message.length > 0) {
      return typeof held.code === 'string' && held.code.length > 0 ? `${held.code}: ${held.message}` : held.message
    }
  }
  return textOf(error)
}

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}