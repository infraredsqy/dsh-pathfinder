import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source guard: the engine's purity boundary.
 *
 * - src carries no wording about a host or about the network; execution can only come in through
 *   the injected executor seam.
 * - the source tree holds no .py file: there is only TypeScript here.
 * - the shape of the package: private, zero runtime dependencies, build and test depending only on
 *   typescript / tsdown / vitest, and **exactly one process entry** — `pf-merge-ledger`, the command
 *   git calls as a merge driver. A command surface (subcommands, a route table, install-time
 *   scripts) stays forbidden; a `bin/` directory stays forbidden too (the source lives in `src/`
 *   and the product in `dist/`).
 *
 * Note: `\bspawn\b` matches whole words only -- `spawner` is part of a policy key in a cycle
 * record, which is data, so it is let past; the bare verb spawn may not appear even once in the
 * code or the comments of the source.
 * **String literals do not count as source**: the plan the planning step hands back carries copied
 * command-line text (things like `pf next --spawn --json`), which is deliverable body, a sentence
 * for a reader, and has nothing to do with whether the engine launches processes; the shape that
 * really must be blocked -- a `spawn(` call -- is checked separately, before literals are stripped.
 * Writing the function name into a string key (`(process as any)['spawn'](...)`) is the same thing
 * in another shape: after stripping literals that key is gone, so the shape `['spawn']` /
 * `["spawn"]` is checked against the raw text as well.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const srcFiles = listFiles(join(repoRoot, 'src')).filter((f) => f.endsWith('.ts'));
const srcAndTestFiles = [...srcFiles, ...listFiles(join(repoRoot, 'tests')).filter((f) => f.endsWith('.ts'))];

const FORBIDDEN_LITERALS = ['@deepseek-ai/', 'session/create', 'session/prompt', '3080', '.py', 'bin/'];
const FORBIDDEN_WORDS = [/\bspawn\b/i];
/** The **code** shape of the path that launches a process: command text copied into a string does not count, a call does. */
const FORBIDDEN_CALLS = [/\bspawn\s*\(/, /\bchild_process\b/];
/**
 * The shape that reaches a function through a string key: `(process as any)['spawn'](...)`,
 * `process["spawn"]`. The key name sits inside a literal, so stripping literals makes it
 * invisible; that is why this is checked against the raw text together with `FORBIDDEN_CALLS`.
 */
const FORBIDDEN_KEYED_CALLS = [/\[\s*['"]spawn['"]\s*\]/i];

/** What the text looks like with string literals stripped: single quotes, double quotes and template strings (with `${}`) all fold into empty strings. */
function withoutStringLiterals(text: string): string {
  return text
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

describe('src content guard', () => {
  it('src carries no wording about a host or the network', () => {
    const offenders: string[] = [];
    for (const file of srcFiles) {
      const text = readFileSync(file, 'utf8');
      const lower = text.toLowerCase();
      for (const literal of FORBIDDEN_LITERALS) {
        if (lower.includes(literal)) offenders.push(`${file}: contains "${literal}"`);
      }
      for (const pattern of [...FORBIDDEN_CALLS, ...FORBIDDEN_KEYED_CALLS]) {
        if (pattern.test(text)) offenders.push(`${file}: contains call shape ${pattern}`);
      }
      const code = withoutStringLiterals(text);
      for (const pattern of FORBIDDEN_WORDS) {
        if (pattern.test(code)) offenders.push(`${file}: contains forbidden word ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src imports only relative paths and node: built-ins: zero outside dependencies', () => {
    // The base layer (shared record IO) needs disk IO to read and write records: node: built-ins
    // are part of the Node 22+ platform surface and fall under "zero runtime dependencies"; what is
    // blocked here is outside packages -- anything without a ./ ../ or node: prefix counts.
    const offenders: string[] = [];
    for (const file of srcFiles) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        if (!spec.startsWith('.') && !spec.startsWith('node:')) offenders.push(`${file}: import '${spec}'`);
      }
      for (const m of text.matchAll(/import\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        if (!spec.startsWith('.') && !spec.startsWith('node:')) offenders.push(`${file}: import '${spec}'`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('source tree guard', () => {
  it('there is no .py file under src or tests', () => {
    const py = srcAndTestFiles.filter((f) => f.toLowerCase().endsWith('.py'));
    expect(py).toEqual([]);
  });

  it('the repo root has no bin dir', () => {
    expect(existsSync(join(repoRoot, 'bin'))).toBe(false);
  });
});

describe('package shape guard (package.json)', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    private?: boolean;
    bin?: unknown;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('a private package with exactly one process entry: never published', () => {
    expect(pkg.private).toBe(true);
    // One entry, and only one: `pf-merge-ledger`, answered by the built product of
    // `src/merge-ledger-bin.ts`. A second key would be a command surface.
    const entries = pkg.bin as Record<string, unknown> | undefined;
    expect(Object.keys(entries ?? {})).toEqual(['pf-merge-ledger']);
    expect(String(entries?.['pf-merge-ledger'])).toBe('./dist/merge-ledger.mjs');
  });

  it('zero runtime dependencies', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });

  it('build and test depend on typescript / tsdown / vitest only', () => {
    expect(Object.keys(pkg.devDependencies ?? {}).sort()).toEqual(['tsdown', 'typescript', 'vitest']);
  });

  it('no install-time lifecycle scripts (postinstall and the like)', () => {
    const scripts = Object.keys(pkg.scripts ?? {});
    const lifecycle = scripts.filter((s) =>
      ['preinstall', 'install', 'postinstall', 'prepublish', 'prepare', 'prepack', 'postpack'].includes(s),
    );
    expect(lifecycle).toEqual([]);
  });
});

/**
 * The name of the audit-time draft dir, assembled from pieces: the English family in the
 * source-word list also holds this spelling, so the guard would go red on itself. Here it is only
 * a path.
 */
function draftDir(): string {
  return 'migra' + 'ted';
}

describe('the temporary draft dir at the repo root', () => {
  it('no draft dir: the audit-time inventory, generating script and drafts are cleared together with the audit', () => {
    expect(existsSync(join(repoRoot, draftDir()))).toBe(false);
  });
});

/**
 * The source-word guard: this repository should read as a native TypeScript project that never
 * says it was carried in from somewhere else.
 *
 * The scan covers **the tracked text files** (the set `git ls-files` yields: `.pf/`,
 * `node_modules/`, `dist/` and a pile of temporary drafts are naturally not in it). The word list
 * is assembled from pieces so that the guard never goes red on itself. The whitelist is that one
 * sentence in the root `AGENTS.md` saying where this came from, allowed **line by line** -- only a
 * line whose trimmed start matches that sentence's lead is let past, and the other lines of the
 * same file are scanned as usual.
 *
 * The list covers: the language it came from (the word starting with `Py`), two Chinese verbs for
 * moving code (one the "shift" verb, one the "plant" verb), the English word for "was carried
 * across" (matched as a whole word, so `reported` / `exported` / `unsupported` do not count), the
 * four English endings of that same move family (`migra` joined to `t`, then `e` / `ion` / `ed` /
 * `ing`, Latin letters in either case -- the English sentence in the fixture is exactly the one
 * this family used to miss; the family is matched strictly, never excused by path), the name of
 * the checkout it came from, the two-character phrase that turns another one into the yardstick
 * (`\u53c2\u8003` -- the variants going on with `\u5b9e\u73b0` / `\u6811` / `CLI` tails are all
 * inside it, and a previous round missed exactly that while a repository full of sentences stayed
 * green), the English phrase joining `reference` and `implementation`, and the Chinese phrase for
 * "that such-and-such tree" (`\u5de5\u5177\u6811`).
 */
const SOURCE_WORDS: ReadonlyArray<readonly [string, RegExp]> = [
  ['the source language', new RegExp(`\\b${'Py'}${'thon'}\\b`, 'i')],
  ['the chinese shift verb', new RegExp('\u8fc1\u79fb')],
  ['the transplant verb', new RegExp('\u79fb\u690d')],
  ['the carried-over word', new RegExp(`\\b${'por'}${'ted'}\\b`, 'i')],
  ['the english move-word family', new RegExp(`\\bmigra${'t(e|ion|ed|ing)'}\\b`, 'i')],
  ['the source checkout', new RegExp(`${'agent-'}${'pathfinder'}`, 'i')],
  ['any mention of the other one', new RegExp('\u53c2\u8003')],
  ['the english phrase', new RegExp(`${'reference'}[- ]${'implementation'}`, 'i')],
  ['the tool tree', new RegExp('\u5de5\u5177\u6811')],
];

const WHITELIST_FILE = 'AGENTS.md';
const WHITELIST_LEAD = '\u6765\u6e90\u8bf4\u660e\uff1a';

/** The tracked text files: the `git ls-files` set, with binaries (anything holding a NUL byte) skipped. */
function trackedTextFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  const out: string[] = [];
  for (const rel of listed.split('\u0000')) {
    if (rel === '') continue;
    const full = join(repoRoot, rel);
    if (!existsSync(full) || !statSync(full).isFile()) continue;
    const bytes = readFileSync(full);
    if (bytes.subarray(0, 8192).includes(0)) continue;
    out.push(full);
  }
  return out;
}

function linesOf(file: string): string[] {
  return readFileSync(file, 'utf8').split(/\r?\n/);
}

describe('source-word guard (tracked text)', () => {
  const files = trackedTextFiles();

  it('the scan surface is real: every tracked text file is taken, and the whitelist file is among them', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((file) => relative(repoRoot, file).split('\\').join('/'))).toContain(WHITELIST_FILE);
  });

  it('the whitelist is one line: the sentence in the root AGENTS.md saying where this came from', () => {
    const allowed = linesOf(join(repoRoot, WHITELIST_FILE)).filter((line) =>
      line.trimStart().startsWith(WHITELIST_LEAD),
    );
    expect(allowed).toHaveLength(1);
    // That line really does carry a source word -- it is exactly what the whitelist lets past.
    expect(SOURCE_WORDS.some(([, pattern]) => pattern.test(allowed[0]!))).toBe(true);
  });

  it('apart from that line, no text file carries a source word', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(repoRoot, file).split('\\').join('/');
      linesOf(file).forEach((line, index) => {
        if (rel === WHITELIST_FILE && line.trimStart().startsWith(WHITELIST_LEAD)) return;
        for (const [label, pattern] of SOURCE_WORDS) {
          if (pattern.test(line)) offenders.push(`${rel}:${index + 1}: ${label} — ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
