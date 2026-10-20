/**
 * The browser half's single path for fetching data and writing back: hands over "which session"
 * and brings the reading back.
 *
 * Both lines reach the same endpoint: first through DSH's mounted remote namespace; deployments
 * without that namespace fall back to the carrier layer calling the same endpoint on `/api`
 * directly. The endpoint name string appears only once, here.
 */
import type { PathfinderReading } from '../host/contract.ts'
import type { PathfinderConfigReading } from '../host/project-config.ts'
import type { PathfinderSessionsReading } from '../host/sessions.ts'
import type { PfOutcome } from '../host/write.ts'
import type { CyclePolicyKey, InstructionScope } from '../host/gateway.ts'

/** The namespace, named after the host-half service key. */
export const NAMESPACE = 'pathfinderRecords'

export type WriteVerb = 'archive' | 'revive' | 'remove'

/** Which host endpoint each write verb maps to. */
const WRITE_ENDPOINTS: Readonly<Record<WriteVerb, string>> = {
  archive: 'archiveInstruction',
  revive: 'reviveInstruction',
  remove: 'removeInstruction',
}

/**
 * The port the panel uses to talk to the host.
 *
 * Every method carries a `workspaceRoot`: the root picked in the workspace selector at the top of
 * the panel (an absolute path); an empty string means nothing was picked, and the read falls back
 * to this session's own root. Whichever is picked is read — unrelated to which workspace the
 * session belongs to.
 *
 * `source` says which layer this port ultimately connected through: `remote` is the mounted remote
 * namespace, `carrier` is the carrier layer, `none` is neither — every read then fails outright,
 * since no reading can be fabricated.
 */
export interface PanelPort {
  readonly source: 'remote' | 'carrier' | 'none'
  /** Read the four records of the named workspace. */
  read(sessionId: string, workspaceRoot: string, signal?: AbortSignal): Promise<PathfinderReading>
  /** The most recent session opened for each cell in the named workspace: where card clicks go. */
  readSessions(sessionId: string, workspaceRoot: string, signal?: AbortSignal): Promise<PathfinderSessionsReading>
  /** Record an instruction: hand the user's verbatim text and scope to the tool. */
  say(sessionId: string, workspaceRoot: string, text: string, scope: InstructionScope, cycle: string, node: string): Promise<PfOutcome>
  /** Archive / revive / delete an instruction. */
  write(verb: WriteVerb, sessionId: string, workspaceRoot: string, id: string): Promise<PfOutcome>
  /** Write one policy number of a line. */
  setPolicy(sessionId: string, workspaceRoot: string, cycle: string, key: CyclePolicyKey, value: string): Promise<PfOutcome>
  /** The named workspace's project settings: effective values and which layer each lives on, from the tool's command. */
  readConfig(sessionId: string, workspaceRoot: string, signal?: AbortSignal): Promise<PathfinderConfigReading>
  /** Write one project setting; it always lands on this project's layer. */
  setConfig(sessionId: string, workspaceRoot: string, key: string, value: string): Promise<PfOutcome>
}

type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/** The minimal shape of a service: this layer only needs the few methods below. */
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
 * Fetch a service from the context's several entrances, on the spot.
 *
 * Both are tried: first the context's own `get`, then the property proxy. If it cannot be fetched,
 * it cannot be fetched — this layer does not throw; callers treat it as "absent".
 * @param owner - A context (the plugin's own, or the one given to the inject callback).
 */
export function serviceAt(owner: unknown, name: string): Service | undefined {
  const holder = owner as { get?: (key: string) => unknown } | null | undefined
  if (holder !== null && holder !== undefined && typeof holder.get === 'function') {
    try {
      const value = holder.get(name)
      if (value !== undefined && value !== null) return value as Service
    } catch (error) {
      /* Asking for an undeclared name throws, which counts the same as "absent". */
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

/** The mounted remote namespace; both lookups are tried. */
function remoteNamespace(ctx: unknown): Service | undefined {
  const direct = serviceAt(ctx, `remote.${NAMESPACE}`)
  if (direct !== undefined) return direct
  const remote = serviceAt(ctx, 'remote')
  if (remote === undefined) return undefined
  try {
    const namespace = remote[NAMESPACE]
    return namespace === undefined || namespace === null ? undefined : (namespace as Service)
  } catch (error) {
    /* Reading an undeclared namespace off the proxy throws: treated here as "not mounted". */
    return undefined
  }
}

/** Arguments for a read call: all three positions present. */
function readArgs(sessionId: string, workspaceRoot: string): Readonly<Record<string, unknown>> {
  return { sessionId, workspaceRoot, options: {} }
}

/**
 * The order in which each endpoint takes its arguments: the remote layer passes them by position,
 * so actual arguments follow this table.
 *
 * When an endpoint changes signature, this table changes with it — the layer refuses to lean on the
 * unsourced convention "object key order = endpoint parameter order", whose silent misalignment on
 * a key reorder is debt this layer does not carry.
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

/** The arguments this endpoint call receives: laid out per the parameter table; keys absent from it are dropped. */
function positional(method: string, args: Readonly<Record<string, unknown>>): readonly unknown[] {
  return (REMOTE_PARAM_ORDER[method] ?? []).map((key) => args[key])
}

/** What each of the two fetch paths yields: one call whose answer already arrives unfolded into the two branches. */
type PortCall = <T>(
  method: string,
  args: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
) => Promise<Answer<T>>

/**
 * The common skeleton of the panel's port: the seven methods written once, with the two paths
 * differing only in the `call` layer and how the signal is passed.
 * @param source - Which layer this port ultimately connected through.
 * @param call - Given the endpoint name, named arguments, and abort signal; it unfolds the answer into the two branches.
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

/** The remote-namespace path: lays arguments out positionally per the parameter table, signal last. */
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

/** The carrier layer: assembles endpoint and arguments itself; the answer still wears the `{ ok, value }` shape. */
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

/** The port used when neither path connects: every read states the failure outright. */
function absentPort(): PanelPort {
  const missing = async (): Promise<never> => {
    throw new Error('该部署未连接寻路记录服务，无法读取记录。')
  }
  const refused = async (): Promise<PfOutcome> => ({ ok: false, text: '该部署没有可用的写入通道。' })
  return { source: 'none', read: missing, readSessions: missing, say: refused, write: refused, setPolicy: refused, readConfig: missing, setConfig: refused }
}

/** Unfolds the `{ ok, value }` shape into the two branches this layer uses. */
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