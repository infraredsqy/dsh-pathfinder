/**
 * The engine handle, the working project, the two outward seams this process owns (git and the
 * executor), and the words for a refusal.
 *
 * The engine is reached through its package export only: `open` from `pf-core`, whose product is the
 * frozen interface (`packages/pf-core/docs/api.md`). Nothing here imports the engine's source.
 */
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** This checkout's root: `bin/lib/` sits two levels under it. */
export const REPO_ROOT = resolve(HERE, '..', '..');
/** This checkout's binary directory. */
export const BIN_DIR = join(REPO_ROOT, 'bin');

const engine = await import('pf-core');

/** This tree's own version number, read off the package manifest it ships. */
export function version() {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  return String(manifest.version ?? '0.0.0');
}

/** One `git <args>` in a directory: the exit code is an answer, not an exception. */
export const gitRunner = {
  run(cwd, args) {
    return new Promise((settle) => {
      const child = spawn('git', [...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        settle({ code: 127, stdout, stderr: `${stderr}${error.message}` });
      });
      child.on('close', (code) => {
        settle({ code: code ?? 1, stdout, stderr });
      });
    });
  },
};

/**
 * The session opener this process hands the engine.
 *
 * Opening a node's session is the execution seam (`Executor`); the engine never opens one itself.
 * With the drill switch on (`DSH_CONDUCT_SPAWN_DRY_RUN`, the same one the engine reads), a simulated
 * session is opened: the call is made in full and reported, and nothing is started. With it off this
 * checkout has no opener to hand over yet — that is the pipeline host's half — so the call refuses
 * out loud instead of pretending a session exists.
 */
export function executor() {
  const dryRun = !['', '0', 'false', 'False'].includes(process.env.DSH_CONDUCT_SPAWN_DRY_RUN ?? '');
  if (dryRun) return new engine.SimulatedExecutor();
  return {
    async dispatch() {
      throw new Error(
        'no session opener is wired into this checkout: opening a node\'s session is the pipeline ' +
          'host\'s half, handed in through the engine\'s executor seam. Set DSH_CONDUCT_SPAWN_DRY_RUN=1 ' +
          'to rehearse the call without opening one.',
      );
    },
  };
}

/**
 * The project root a command acts on: the directory named, else the current directory — as it is, with
 * one exception. Inside a linked worktree the ledger is not the worktree's own copy: in parallel mode a
 * node's code work goes into the main tree's `.pf/worktrees/<short id>`, and that checkout holds a copy
 * of `.pf/` as of the fork, so a recording command that accepted it would settle on a stale snapshot.
 * A worktree root is recognised by its `.git` being a **file** pointing at `<main>/.git/worktrees/<name>`;
 * that pointer leads back to the main tree, and only when the main tree really has a `.pf/`. Everything
 * else — a subdirectory, a submodule (its `.git` file points at `.git/modules/…`), a directory that is
 * no project at all — is answered as the directory it is. Nothing climbs to a repository root: the
 * engine itself refuses a folder with no `.pf` of its own rather than trying one above it.
 */
export function projectRoot(named) {
  const start = named === undefined || named === '' ? process.cwd() : resolve(named);
  return mainTreeOf(start) ?? start;
}

/** The main tree a linked worktree's checkout root points back at, or `null` when this is no worktree root. */
function mainTreeOf(start) {
  let firstLine;
  try {
    const dotGit = join(start, '.git');
    if (!statSync(dotGit).isFile()) return null;
    firstLine = readFileSync(dotGit, 'utf8').split('\n')[0].trim();
  } catch {
    return null;
  }
  if (!firstLine.startsWith('gitdir:')) return null;
  const target = firstLine.slice('gitdir:'.length).trim();
  if (target === '') return null;
  const gitdir = resolve(start, target);
  // `<main>/.git/worktrees/<name>` and nothing else: a submodule's `gitdir:` does not name a worktree.
  if (basename(dirname(gitdir)) !== 'worktrees') return null;
  const main = resolve(gitdir, '..', '..', '..');
  try {
    if (!statSync(join(main, '.pf')).isDirectory()) return null;
  } catch {
    return null;
  }
  return main;
}

/** The setting names the settings verbs accept here: the engine's own list plus every installed plugin's knobs. */
export async function configKeys() {
  const pf = await handleOf(projectRoot(undefined));
  return pf.config.keys();
}

/** The engine handle of one project. */
export async function handleOf(root) {
  return engine.open(root, { executor: executor(), ...homeDirOption() });
}

/** The machine-layer home, when this process was told where it is (`PF_HOME_DIR` is the engine's own switch). */
function homeDirOption() {
  const home = process.env.PF_HOME_DIR;
  return home === undefined || home === '' ? {} : { homeDir: resolve(home) };
}

/** The exact words of one refusal: the engine's own sentence when it carries one. */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Whether an engine refusal carries one of its decidable codes. */
export function codeOf(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : null;
}