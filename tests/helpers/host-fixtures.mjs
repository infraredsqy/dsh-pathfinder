/* The command-plane fixtures the host-side gateway tests share: the subprocess stand-in every
 * endpoint's command line is recorded on, the minimal host context the endpoints run in, and the
 * words cut from a recorded command line.
 */

/**
 * A subprocess stand-in: every spawn's spec lands on `specs`, and each run answers with the given
 * exit code and streams. The interpreter resolution table is optional: pass one when a case needs
 * a command resolved to a named path (`host-write` passes its `python`/`py` table); omit it and
 * every command resolves to the `pf.cmd` executable (`host-config` does).
 */
export function fakeSubprocess({ executable = 'C:\\tools\\bin\\pf.cmd', interpreters = null, exitCode = 0, stdout = '', stderr = '' } = {}) {
  const specs = []
  return {
    specs,
    async resolveExecutable(command) {
      if (interpreters !== null && command in interpreters) {
        const path = interpreters[command]
        if (path === null) throw new Error(`${command} 不在 PATH 上`)
        return path
      }
      return executable
    },
    spawn(spec) {
      specs.push(spec)
      return {
        done: Promise.resolve({ exitCode }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: stderr }) },
        },
      }
    },
  }
}

/** A minimal host context, enough for this layer: the command runs at whatever root the session header points to. */
export function fakeContext({ subprocess, workspaceRoot = 'C:\\workspace' } = {}) {
  return {
    workspaceFiles: {},
    sessions: { get: () => ({ header: { cwd: workspaceRoot } }) },
    sandboxPolicy: { workspaceRoot },
    get: (service) => (service === 'subprocess' ? subprocess : undefined),
  }
}

/** The tool's own words on a recorded command line: everything after the command's name. */
export function wordsOf(spec) {
  return spec.argv[spec.argv.length - 1].split(' ').slice(1)
}
