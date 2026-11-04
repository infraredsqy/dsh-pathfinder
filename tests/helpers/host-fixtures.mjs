/* The command-plane fixtures the host-side gateway tests share: the subprocess stand-in every
 * endpoint's command line is recorded on, the minimal host context the endpoints run in, and the
 * words cut from a recorded command line.
 */

/**
 * A subprocess stand-in: every spawn's spec lands on `specs`, and each run answers with the given
 * exit code and streams. `resolveExecutable` answers with `executable` for every command — pass a
 * different one to move the command that PATH would hand back.
 */
export function fakeSubprocess({ executable = 'C:\\tools\\bin\\pf.cmd', exitCode = 0, stdout = '', stderr = '' } = {}) {
  const specs = []
  return {
    specs,
    async resolveExecutable() {
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
