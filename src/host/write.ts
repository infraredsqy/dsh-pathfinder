/**
 * 宿主半身的写面：面板上那几处动记录的动作，一律交给工具那条命令去落笔。
 *
 * 记录只经工具读写（`.pf` 那一层的约定），所以这里不拼 JSON、不碰 `.pf` 下的文件，
 * 只把一条命令递出去再把它的输出收回来。工具自己会把拒绝的理由打出来——归档一条
 * 不在生效中的、复原一条没被归档的、删一条不认得的 id，都是它说话，这里只转述。
 *
 * 命令一律不经 shell 解释：每个参数先过一道字符闸，落在闸外的直接拒掉，再交给
 * `ctx.subprocess` 起一个隐藏窗口的子进程（Windows 上那条 `pf` 是个 `.cmd`，
 * 只能由 `cmd.exe` 带起来，所以那一支自己拼命令行——正因为拼了，参数闸才是必须的）。
 *
 * @module dsh-pathfinder/host/write
 */
import type { Context } from '@deepseek-ai/cordis'
/* 起进程的口子在 `@deepseek-ai/dsh-subprocess` 的包入口上，只为把 `subprocess` 挂到
 * Context 上——类型引用，运行时什么都不进。 */
import type {} from '@deepseek-ai/dsh-subprocess'

/** 一条写命令回来的样子。工具说了什么原样带出来，那里没有 JSON 形状可依赖。 */
export interface PfOutcome {
  /** 工具退出码是 0 才算成了。 */
  readonly ok: boolean
  /** 工具写在自己那一路上的话，原样。 */
  readonly text: string
}

/** 参数闸：命令、子命令、id、键名、值都只会是这些字符里的组合。 */
const SAFE_ARG = /^[A-Za-z0-9_.:+-]{1,200}$/

/** 一次落笔最多等多久。工具这几条都是读一份小 JSON 再写回去。 */
const GRACE_MS = 4000

/** 收输出的上限：工具的拒绝理由与那一句原话都要能装下。 */
const MAX_BYTES = 64 * 1024

/**
 * 起一条 `pf` 命令，把它的输出收回来。
 * @param ctx - 宿主上下文；起进程的口子从它上面现取。
 * @param workspaceRoot - 记录所在的那个工作区根，命令就跑在那里。
 * @param args - 命令与参数，逐项过闸。
 * @param signal - 调用方取消。
 * @returns 工具退出码是不是 0，以及它说了什么。
 */
export async function runPf(
  ctx: Context,
  workspaceRoot: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<PfOutcome> {
  const unsafe = args.find((arg) => !SAFE_ARG.test(arg))
  if (unsafe !== undefined) return { ok: false, text: `该参数不能进入命令：${unsafe}` }

  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) return { ok: false, text: '该宿主没有可用的进程通道，无法执行这次写入。' }

  let argv: readonly string[]
  try {
    argv = await launchArgs(subprocess, args, signal)
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

/** 起进程那一侧认得的最小形状：这一层只用得上 `resolveExecutable` 与 `spawn`。 */
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
 * 一次落笔的 argv。
 *
 * 可执行文件的绝对路径由口子自己解析——这一层不写死任何一台机器的路径。Windows 上
 * `pf` 落在 `pf.cmd` 上，而 `.cmd` 只有 `cmd.exe` 带得起来（直接起它，Node 会以
 * `EINVAL` 拒掉），所以这一支换成「解释器 + 一条命令行」。
 *
 * 这一条命令行里的路径**不能加引号**：Node 在 Windows 上按 C 运行时的规矩重新拼一遍
 * 命令行，加上的引号会变成 `\"`，cmd 认不出那个程序（实测：裸路径 exit 0，加引号
 * exit 1）。路径里真带空格或 cmd 元字符时，这一手就落不了笔——如实说出来，不硬拼。
 */
async function launchArgs(
  subprocess: Spawner,
  args: readonly string[],
  signal: AbortSignal,
): Promise<readonly string[]> {
  let pf: string
  try {
    pf = await subprocess.resolveExecutable('pf', undefined, signal)
  } catch (error) {
    /* 「这台机器上没有这条命令」与下面那一条「有，但它的路径送不进 cmd」是两件事，
     * 两句话分开说：混成一句，读者会照着第一句去装一个已经装好了的命令。 */
    throw new Error(`未找到 pf 命令：${messageOf(error)}`)
  }
  if (process.platform !== 'win32') return [pf, ...args]
  if (!CMD_SAFE_PATH.test(pf)) {
    throw new Error(`pf 命令的路径中含有 cmd 无法处理的字符（${pf}），无法执行这次写入。`)
  }
  const comspec = process.env['ComSpec'] ?? 'cmd.exe'
  return [comspec, '/d', '/s', '/c', `${pf} ${args.join(' ')}`]
}

/** 路径里只认这些字符；逗号、空格、引号、cmd 的元字符都在闸外。 */
const CMD_SAFE_PATH = /^[A-Za-z0-9_.:\\/-]+$/

/** 一个错误说成一句话。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}