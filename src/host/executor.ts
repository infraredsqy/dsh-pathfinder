/**
 * The host half's native executor: the session that works a node is opened
 * here, by the host's own services — no external script and no
 * platform-specific shell.
 *
 * One open, in order:
 *
 * 1. probe the host's session side (`sessions` store, `agents` registry);
 *    either missing is an explicit refusal naming the piece, never silence;
 * 2. read the plan's launch prompt for this cell out of the record store —
 *    the first instruction is exactly that line, so it agrees with the plan
 *    by construction;
 * 3. create the agent and its session under the workspace root (`cwd` is the
 *    root, which is what groups the session under that workspace instead of
 *    leaving it ungrouped), arm the opening round's listeners, hand the
 *    prompt over as the first instruction, and write the session note — the
 *    opener's own entry, in the record store's note layer;
 * 4. settle the opening round: hosts whose agents expose the wait interface
 *    get `whenIdle()`; older ones get the idle notification plus the
 *    turn-end events, resolved together.
 *
 * Step 3 touches the workspace (the session log's directory and the note
 * file) and runs inside a per-workspace queue, so two opens aimed at one
 * workspace create their sessions strictly one after another and their notes
 * never interleave mid-write. The listeners are armed before the first
 * instruction goes in: a loop that finishes its round instantly must not
 * outrun its own settlement. The settlement wait runs outside the queue: a
 * slow first round must not hold the next open of the same workspace
 * hostage.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
/* The declaration merges for `agents` and the agent events live on the package entries; type-only, nothing enters the runtime. */
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent, AgentOptions, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { RECORD_DIR } from './contract.ts'
import type { PfFailure, PfRefusalCode } from './failure.ts'
import { isAbsent, readWholeFile, type PathfinderScope } from './records.ts'
import { noteOpenedSession } from './session-note.ts'

/** What one open brought back: the session now working this node. The id is an address for the panel's navigation, not a word a reader is shown. */
export type SessionOpenOutcome =
  | { readonly ok: true; readonly session: string }
  | { readonly ok: false; readonly code: PfRefusalCode; readonly detail?: string }

/** Options an in-process caller may hand an open; over the wire the open runs to its own end. */
export interface SessionOpenOptions {
  /** Stops the settlement wait; the session and its note stay whatever this decides. */
  readonly signal?: AbortSignal
}

/**
 * One record-directory segment, guarded at the one place it becomes a path:
 * an empty id, a self or parent segment, or anything outside the record
 * tree's own character set would address a file outside that cell's own
 * place. The refusal is the argument gate's own code; the offending value
 * rides as the detail.
 */
function segmentFailure(value: string): PfFailure | undefined {
  const SAFE_SEGMENT = /^[A-Za-z0-9_.:+-]{1,200}$/
  if (value.length === 0 || value === '.' || value === '..' || !SAFE_SEGMENT.test(value)) {
    return { ok: false, code: 'arg-not-allowed', detail: value }
  }
  return undefined
}

/** Which pieces of the host's session side this open needs, fetched on the spot. */
interface SessionSide {
  readonly agents: AgentRegistry
}

/**
 * Probe the host's session side before anything else: a deployment whose
 * `sessions` store or `agents` registry is absent gets a refusal naming the
 * missing piece. An open that never happened must not read as one that
 * failed halfway.
 */
function sessionSideOf(ctx: Context): SessionSide | PfFailure {
  const sessions = ctx.get('sessions')
  if (sessions === undefined || sessions === null) return { ok: false, code: 'no-session-service', detail: 'sessions' }
  const agents = ctx.get('agents')
  if (agents === undefined || agents === null) return { ok: false, code: 'no-session-service', detail: 'agents' }
  return { agents: agents as AgentRegistry }
}

/**
 * The model selection a fresh session opens with: the deployment's current
 * choice, the same one a session opened through the host's own surface gets.
 * The service that knows it is asked for by name on the spot, structurally —
 * a host without it (or one whose answer cannot be read) simply omits the
 * selection and the loop's own defaults apply.
 */
function modelSelectionOf(ctx: Context): AgentOptions | undefined {
  const source = ctx.get('agentDefaultModel') as { currentSelection?: () => unknown } | undefined
  if (source === undefined || typeof source.currentSelection !== 'function') return undefined
  let picked: unknown
  try {
    picked = source.currentSelection()
  } catch {
    return undefined
  }
  if (picked === null || typeof picked !== 'object') return undefined
  const held = picked as { provider?: unknown; model?: unknown }
  const provider = typeof held.provider === 'string' && held.provider.length > 0 ? held.provider : undefined
  const model = typeof held.model === 'string' && held.model.length > 0 ? held.model : undefined
  if (provider === undefined && model === undefined) return undefined
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  }
}

/**
 * The per-workspace queue: opens aimed at one workspace hold its line one at
 * a time, whatever the previous open answered — a refusal must not poison
 * the line for the next open. One process, one queue: two gateway instances
 * in the same host would still be writing the same directories.
 */
const queues = new Map<string, Promise<unknown>>()

function inLine<T>(root: string, step: () => Promise<T>): Promise<T> {
  const ahead = queues.get(root) ?? Promise.resolve()
  const mine = ahead.then(step, step)
  queues.set(root, mine.then(() => undefined, () => undefined))
  return mine
}

/** Why an open stopped after (or without) a session: the reason rides verbatim as the refusal's detail. */
function openFailure(reason: string): { ok: false; code: PfRefusalCode; detail: string } {
  return { ok: false, code: 'open-failed', detail: reason }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Open the session that works one node, and settle its opening round.
 *
 * The plan's launch prompt (`<pf>/meta/launch/<line>/<node>/prompt.txt`) is
 * the first instruction, read verbatim out of the record store; the note
 * naming the session is written by this side once the session exists. See
 * the module comment for the whole order and why the queue holds only the
 * workspace-touching stretch.
 */
export async function openNodeSession(
  ctx: Context,
  sessionId: SessionId,
  workspaceRoot: string,
  cycle: string,
  node: string,
  options?: SessionOpenOptions,
): Promise<SessionOpenOutcome> {
  const side = sessionSideOf(ctx)
  if ('code' in side) return side
  const named = segmentFailure(cycle) ?? segmentFailure(node)
  if (named !== undefined) return named

  const signal = options?.signal ?? new AbortController().signal
  const scope: PathfinderScope = { sessionId, workspaceRoot }
  let prompt: string
  try {
    prompt = await readWholeFile(ctx.workspaceFiles, scope, `${RECORD_DIR}/meta/launch/${cycle}/${node}/prompt.txt`, signal)
  } catch (error) {
    if (isAbsent(error)) return { ok: false, code: 'prompt-missing', detail: `${cycle}/${node}` }
    return openFailure(messageOf(error))
  }
  if (prompt.trim().length === 0) return { ok: false, code: 'prompt-missing', detail: `${cycle}/${node}` }

  /* The session identity is this host's own mint, spelled the way the host spells its own: `session-` + a fresh uuid. The brand is a compile-time fact; the string is what crosses. */
  const opened = `session-${randomUUID()}` as SessionId
  const selection = modelSelectionOf(ctx)

  /* The workspace-touching stretch, queued: create the session under the root (the grouping fact), arm the round's listeners, hand the prompt over, then write the note while the line still holds — the note names a session that exists on disk. */
  let settlement: Settlement
  try {
    settlement = await inLine(workspaceRoot, async () => {
      const handle = await side.agents.create({
        sessionId: opened,
        meta: { cwd: workspaceRoot },
        ...(selection === undefined ? {} : { agentOptions: selection }),
      })
      const armed = armSettlement(ctx, handle.agent, opened)
      try {
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        }))
        await noteOpenedSession(workspaceRoot, node, opened)
      } catch (error) {
        armed.drop()
        throw error
      }
      return armed
    })
  } catch (error) {
    /* The session may be out already and the note missing: say so plainly instead of letting the next open run a second session on this cell. */
    return openFailure(messageOf(error))
  }

  try {
    await settlement.wait(signal)
  } catch (error) {
    settlement.drop()
    /* The wait ended without a settled round: the session is open and its note is on disk, but
     * this open cannot vouch for the round. The refusal names the cell — line and node — because
     * this sentence reaches a reader through the panel's {detail}, and a session id is an address
     * for navigation, not a word a reader is shown (docs/design-principles.md §三). */
    return openFailure(`${cycle}/${node} is open but its opening round was not seen to settle: ${messageOf(error)}`)
  }
  return { ok: true, session: opened }
}

/** The opening round's wait, once it is armed. */
interface Settlement {
  /** Wait the opening round out; the signal cuts the wait short. */
  wait(signal: AbortSignal): Promise<void>
  /** Take the listeners back down: the open failed before its round, or the wait already answered. */
  drop(): void
}

/**
 * Arm the opening round's listeners before the first instruction goes in —
 * a loop that finishes its round instantly settles while the listeners are
 * already on, not after they would have been missed. The wait adapts to the
 * host in front of us: agents that carry the wait interface answer through
 * `whenIdle()`; hosts whose agents lack it answer through the idle
 * notification (`agent/status` flipping to `idle`) together with the
 * turn-end events (`session/event` carrying `turn/end`) — both must be seen.
 * A session torn down before its first round answers nothing further: there
 * is no round left to settle.
 */
function armSettlement(ctx: Context, agent: Agent, sessionId: SessionId): Settlement {
  let turnEnded = false
  let idle = false
  let met = false
  let detached = false
  let wake: (() => void) | undefined
  const offs: (() => void)[] = []
  const detach = (): void => {
    if (detached) return
    detached = true
    for (const off of offs) off()
  }
  const answer = (): void => {
    met = true
    detach()
    const release = wake
    wake = undefined
    release?.()
  }
  offs.push(ctx.on('agent/status', (payload) => {
    if (payload.agent !== agent) return
    idle = payload.status === 'idle'
    if (turnEnded && idle) answer()
  }))
  offs.push(ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId) return
    if (event.type === 'turn/end') {
      turnEnded = true
      if (idle) answer()
    }
  }))
  offs.push(ctx.on('agent/disposed', (payload) => {
    if (payload.agent === agent) answer()
  }))
  return {
    wait(signal) {
      /* The wait interface, when the host carries it, is the whole answer: the fallback listeners stand down unused. */
      if (typeof agent.whenIdle === 'function') {
        detach()
        return raceAbort(agent.whenIdle(), signal)
      }
      /* The round may have settled while the listeners were the only ones watching: the answer is already in. */
      if (met) return Promise.resolve()
      return raceAbort(new Promise<void>((resolve) => { wake = resolve }), signal)
    },
    drop: detach,
  }
}

/**
 * Run one wait against the caller's signal: the wait's own answer wins, the
 * signal's rejection cuts in. The signal rejects with its own reason, so a
 * cancelled wait reads as a cancelled wait. A signal that already fired
 * rejects on the spot — the abort event never replays for a late listener.
 */
function raceAbort<T>(wait: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    let done = false
    const onAbort = (): void => settleWith(() => reject(signal.reason))
    const settleWith = (run: () => void): void => {
      if (done) return
      done = true
      signal.removeEventListener('abort', onAbort)
      run()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    wait.then(
      (value) => settleWith(() => resolve(value)),
      (error) => settleWith(() => reject(error)),
    )
  })
}
