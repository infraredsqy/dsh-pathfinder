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
import type { PfFailure, PfOutcome } from './failure.ts'

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
  if (unsafe !== undefined) return { ok: false, code: 'arg-not-allowed', detail: unsafe }

  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) return { ok: false, code: 'no-subprocess' }

  const launched = await launchArgs(subprocess, args, signal, said)
  if (!launched.ok) return launched

  try {
    const handle = subprocess.spawn({
      argv: launched.argv,
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
    /* The tool exiting non-zero is not this plugin's sentence to write: it said its own reason on
     * one of the two streams, and that reason travels as `detail`, verbatim. */
    if (outcome.exitCode !== 0) return { ok: false, code: 'tool-refused', ...(text.length > 0 ? { detail: text } : {}) }
    return { ok: true, text }
  } catch (error) {
    return { ok: false, code: 'spawn-failed', detail: messageOf(error) }
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
 * What the launcher produced: the argv to run, or why it could not be built.
 *
 * A refusal that a person can act on (the command is missing, its path cannot be handed to cmd,
 * no interpreter exists) is an ordinary answer here, not an exception: throwing would make the
 * reason travel as a message string, which is exactly the shape this layer is getting out of.
 */
type Launch = { readonly ok: true; readonly argv: readonly string[] } | PfFailure

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
): Promise<Launch> {
  let pf: string
  try {
    pf = await subprocess.resolveExecutable('pf', undefined, signal)
  } catch (error) {
    /* "The command does not exist on this machine" and the failure below ("it exists, but its path cannot enter cmd") are two different things, kept as two separate codes: merged into one, the reader would go reinstall an already-installed command on the first one's advice. */
    return { ok: false, code: 'pf-missing', detail: messageOf(error) }
  }
  if (process.platform !== 'win32') return { ok: true, argv: said === undefined ? [pf, ...args] : [pf, ...args, said] }
  if (said !== undefined) {
    const script = await scriptArgs(subprocess, pf, signal)
    return script.ok ? { ok: true, argv: [...script.argv, ...args, said] } : script
  }
  if (!CMD_SAFE_PATH.test(pf)) return { ok: false, code: 'pf-path-unsafe', detail: pf }
  const comspec = process.env['ComSpec'] ?? 'cmd.exe'
  return { ok: true, argv: [comspec, '/d', '/s', '/c', `${pf} ${args.join(' ')}`] }
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
async function scriptArgs(subprocess: Spawner, pf: string, signal: AbortSignal): Promise<Launch> {
  for (const [command, ...flags] of INTERPRETERS) {
    try {
      return { ok: true, argv: [await subprocess.resolveExecutable(command, undefined, signal), ...flags, join(dirname(pf), PF_SCRIPT)] }
    } catch (error) {
      /* This spelling does not exist on this machine: try the next one. When neither exists, the refusal below is the one to give. */
    }
  }
  return { ok: false, code: 'no-interpreter' }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}