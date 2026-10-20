/**
 * The host half's write surface: every record-touching action on the panel is
 * handed to the tool's command to write.
 *
 * No JSON is assembled here and nothing under `.pf` is touched; a command is
 * handed out, its output collected, and the tool prints its own reasons for
 * refusal. Commands never go through shell interpretation: every argument
 * passes a character gate first, then goes to `ctx.subprocess`.
 *
 * The user's verbatim sentence is the only thing that cannot pass that gate —
 * it may be any sentence, with spaces and punctuation. On Windows such a
 * sentence cannot travel the cmd command line (see `launchArgs`), so the run
 * that carries it gets its own argv.
 */
import type { Context } from '@deepseek-ai/cordis'
import { dirname, join } from 'node:path'
/* The subprocess gateway lives on the `@deepseek-ai/dsh-subprocess` package entry, only to attach `subprocess` to the Context: a type-only import, nothing enters the runtime. */
import type {} from '@deepseek-ai/dsh-subprocess'

/** What a write command returns. Whatever the tool said is carried out verbatim; there is no JSON shape to rely on. */
export interface PfOutcome {
  readonly ok: boolean
  readonly text: string
}

/** The argument gate: commands, subcommands, ids, key names, and values are all combinations of just these characters; the verbatim sentence stays outside the gate, see `runPf`. */
const SAFE_ARG = /^[A-Za-z0-9_.:+-]{1,200}$/

/** How long a single write may take at most. Each of these tool commands reads a small JSON and writes it back. */
const GRACE_MS = 4000

/** Output collection cap: the tool's refusal reason and the verbatim sentence must both fit. */
const MAX_BYTES = 64 * 1024

/**
 * Run a `pf` command and collect its output.
 * @param said - The user's verbatim sentence, appended to the end of the command as-is; when given, a shell-free argv is used instead.
 */
export async function runPf(
  ctx: Context,
  workspaceRoot: string,
  args: readonly string[],
  signal: AbortSignal,
  said?: string,
): Promise<PfOutcome> {
  const unsafe = args.find((arg) => !SAFE_ARG.test(arg))
  if (unsafe !== undefined) return { ok: false, text: `该参数不能进入命令：${unsafe}` }

  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) return { ok: false, text: '该宿主没有可用的进程通道，无法执行这次写入。' }

  let argv: readonly string[]
  try {
    argv = await launchArgs(subprocess, args, signal, said)
  } catch (error) {
    return { ok: false, text: messageOf(error) }
  }

  try {
    const handle = subprocess.spawn({
      argv,
      cwd: workspaceRoot,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_BYTES },
        stderr: { maxBytes: MAX_BYTES },
      },
      graceMs: GRACE_MS,
      signal,
    })
    const outcome = await handle.done
    const out = handle.collected.stdout?.readFrom(0).text ?? ''
    const err = handle.collected.stderr?.readFrom(0).text ?? ''
    const text = [out, err].filter((part) => part.length > 0).join('\n').trim()
    return { ok: outcome.exitCode === 0, text }
  } catch (error) {
    return { ok: false, text: messageOf(error) }
  }
}

/** The minimal shape the subprocess side needs: this layer uses only `resolveExecutable` and `spawn`. */
interface Spawner {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: {
      stdin: 'ignore'
      stdout: { maxBytes: number }
      stderr: { maxBytes: number }
    }
    graceMs: number
    signal: AbortSignal
  }): { readonly done: Promise<{ readonly exitCode: number | null }>; readonly collected: { readonly stdout?: { readFrom(from: number): { text: string } }; readonly stderr?: { readFrom(from: number): { text: string } } } }
}

/**
 * The argv for one write.
 *
 * The executable's absolute path is resolved by the gateway itself; this
 * layer hard-codes no machine's path. On Windows `pf` lands on `pf.cmd`, and
 * `.cmd` can only be launched by `cmd.exe` (spawned directly, Node rejects it
 * with `EINVAL`), so that branch becomes "interpreter + one command line".
 *
 * Paths in that command line must not be quoted: on Windows Node rebuilds the
 * command line per the C runtime's rules, and the added quotes become `\"`,
 * which cmd cannot recognize as the program (measured: bare path exits 0,
 * quoted path exits 1). If the path truly contains spaces or cmd
 * metacharacters, this write cannot happen — say so plainly instead of
 * forcing it.
 *
 * The run carrying the verbatim sentence does not take that command line:
 * cmd would split the sentence on spaces and would execute an `&` inside it
 * (measured: `--text a & echo x` really runs the second command). Instead it
 * launches `pf.py`, which sits beside `pf.cmd`, and hands the whole sentence
 * to the interpreter as one argument — the argument is quoted by Node itself
 * per the C runtime's rules, and `&` arrives there still `&`.
 */
async function launchArgs(
  subprocess: Spawner,
  args: readonly string[],
  signal: AbortSignal,
  said: string | undefined,
): Promise<readonly string[]> {
  let pf: string
  try {
    pf = await subprocess.resolveExecutable('pf', undefined, signal)
  } catch (error) {
    /* "The command does not exist on this machine" and the failure below ("it exists, but its path cannot enter cmd") are two different things, kept as two separate messages: merged into one, the reader would go reinstall an already-installed command on the first message's advice. */
    throw new Error(`未找到 pf 命令：${messageOf(error)}`)
  }
  if (process.platform !== 'win32') return said === undefined ? [pf, ...args] : [pf, ...args, said]
  if (said !== undefined) return [...(await scriptArgs(subprocess, pf, signal)), ...args, said]
  if (!CMD_SAFE_PATH.test(pf)) {
    throw new Error(`pf 命令的路径中含有 cmd 无法处理的字符（${pf}），无法执行这次写入。`)
  }
  const comspec = process.env['ComSpec'] ?? 'cmd.exe'
  return [comspec, '/d', '/s', '/c', `${pf} ${args.join(' ')}`]
}

/** Only these characters are allowed in the path; commas, spaces, quotes, and cmd's metacharacters all stay outside the gate. */
const CMD_SAFE_PATH = /^[A-Za-z0-9_.:\\/-]+$/

/** The Python entry sitting next to `pf.cmd`: in the end `pf.cmd` just hands the arguments to it. */
const PF_SCRIPT = 'pf.py'

/** The interpreter's two spellings, probed in the same order as `pf.cmd`'s own probe; `-X utf8` aligns with its two spots. */
const INTERPRETERS: readonly (readonly [string, ...string[]])[] = [
  ['python', '-X', 'utf8'],
  ['py', '-3', '-X', 'utf8'],
]

/**
 * The head of the argv that carries the verbatim sentence: the interpreter,
 * its flags, and `pf.py`.
 */
async function scriptArgs(subprocess: Spawner, pf: string, signal: AbortSignal): Promise<readonly string[]> {
  for (const [command, ...flags] of INTERPRETERS) {
    try {
      return [await subprocess.resolveExecutable(command, undefined, signal), ...flags, join(dirname(pf), PF_SCRIPT)]
    } catch (error) {
      /* This spelling does not exist on this machine: try the next one. When neither exists, the error below is the one to raise. */
    }
  }
  throw new Error('这台机器上没有能把原话送进 pf 的解释器：`python` 与 `py` 都不在 PATH 上。')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}