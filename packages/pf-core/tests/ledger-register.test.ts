import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeDriverCommand } from '../src/initledger';
import { open } from '../src/open';
import { git, gitRunner as realGit, makeRepo } from './helpers/git-runner';

/**
 * `register` on its own: the two merge-driver keys go into this project's git config through git
 * (`git config --local`), and the engine lays down no layout file and writes no config byte itself.
 *
 * The registration string is computed at write time, and in a linked worktree the keys land in the
 * common git config — because git owns that decision, not the engine.
 */

/** The one line this engine owns: a repository-root-anchored `.pf/`. */
function excludeLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => /^\s*\/.*\.pf\/\s*$/.test(line));
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pf-register-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
});

describe('ledger.register', () => {
  it("writes the two keys into this project's git config and lays down no layout", async () => {
    await git(root, 'init', '-b', 'master');
    await open(root).ledger.register({ git: realGit });
    expect((await git(root, 'config', '--local', '--get', 'merge.pf.driver')).trim())
      .toBe(mergeDriverCommand());
    expect(existsSync(join(root, '.pf'))).toBe(false);
  });

  it('without git it is a silent no-op, and not a throw', async () => {
    await expect(open(root).ledger.register()).resolves.toBeUndefined();
    expect(existsSync(join(root, '.pf'))).toBe(false);
    expect(existsSync(join(root, '.git'))).toBe(false);
  });

  it('in a linked worktree the keys land in the common git config (git decides where, not the engine)', async () => {
    await makeRepo(root);
    const worktree = join(mkdtempSync(join(tmpdir(), 'pf-register-wt-')), 'tree');
    try {
      await git(root, 'worktree', 'add', worktree, '-b', 'side');
      await open(worktree).ledger.init({ git: realGit });
      const driver = (await git(root, 'config', '--local', '--get', 'merge.pf.driver')).trim();
      expect(driver).toBe(mergeDriverCommand());
      // One exclude file for the whole repository: the line is there once, anchored at the root.
      expect(excludeLines(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')))
        .toEqual(['/.pf/']);
    } finally {
      rmSync(join(worktree, '..'), { recursive: true, force: true });
    }
  }, 20000);
});
