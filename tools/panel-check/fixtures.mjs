/* panel-check's fixture: the stages the checks stand on. It copies the record into five scene
 * workspaces (full / empty / broken / bare / pool-only — which scenes exist is the entry's
 * `scenes` parameter), starts the real host half over them (its spawn side through a
 * hidden-window execFile stand-in, its workspace-files gate wired to the real filesystem with
 * the shared stand-in's paging), then boots jsdom + React and mounts the built browser half.
 * Boot readings print through the entry's own `check`. */
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { fakeSettingsForm, fakeSlotRoster } from '../../tests/helpers/dsh-standins.mjs'
import { absentError, readPage } from '../../tests/helpers/workspace-files-port.mjs'

/**
 * Stage everything the checks stand on and hand it over as one bundle.
 * @param scenes - The five scene descriptors from the entry: `{ main, empty, broken, bare, poor }`,
 *   each `{ name, sessionId }` (the directory under `.tmp/panel-check` and the session id the
 *   checks pin to it).
 */
export async function startFixture({ check, scenes }) {
  // React touches window/document once at load time; without them it falls back to its IE8/9 path
  // (calling `attachEvent`, which would blow up here), so it must wait until jsdom is in place.
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  const work = join(root, '.tmp', 'panel-check')
  const dirOf = (scene) => join(work, scene.name)
  const workspace = dirOf(scenes.main)
  const record = join(workspace, '.pf')
  const sessionId = scenes.main.sessionId
  const emptyWorkspace = dirOf(scenes.empty)
  const emptySessionId = scenes.empty.sessionId
  const brokenWorkspace = dirOf(scenes.broken)
  const brokenSessionId = scenes.broken.sessionId
  const bareWorkspace = dirOf(scenes.bare)
  const bareSessionId = scenes.bare.sessionId
  const poorWorkspace = dirOf(scenes.poor)
  const poorSessionId = scenes.poor.sessionId

  /** A write outcome as one reading: success prints the tool's own output, a refusal its code and detail. */
  function outcomeText(outcome) {
    return outcome.ok
      ? outcome.text
      : `${outcome.code}${outcome.detail === undefined ? '' : `: ${outcome.detail}`}`
  }

  /* Completion notice for the read pass: every read hands its promise here, and the fixture awaits
   * those promises themselves rather than guessing how long they take. The panel cell goes through the same gate. */
  const inFlight = []
  const track = (promise) => {
    inFlight.push(promise.catch(() => undefined))
    return promise
  }

  /**
   * The declarations that finally land on an element from the shipped sheet, last rule wins per
   * property: jsdom does no cascading, so this re-walks DOM matching; rules wrapped in an at-rule
   * (@media) are descended into.
   */
  function winningDeclarations(element, properties) {
    const won = {}
    const rules = [...window.document.styleSheets].flatMap((sheet) => [...(sheet.cssRules ?? [])])
    for (const rule of rules.flatMap((one) => (one.cssRules === undefined ? [one] : [...one.cssRules]))) {
      const selector = rule.selectorText
      if (selector === undefined || element.matches(selector) === false) continue
      for (const property of properties) {
        const value = (rule.style?.getPropertyValue(property) ?? '').replace(/\s+/gu, ' ').trim()
        if (value.length > 0) won[property] = value
      }
    }
    return won
  }

  /* ---- 1. A writable copy of the record ----------------------------------- */

  /** Where the record is copied from: this repo's own `.pf` snapshot. `PANEL_CHECK_RECORD` points the
   * copy at another record directory — the emptied-pool self-check runs the whole fixture against a
   * cleared copy without touching the snapshot this repo carries. */
  const recordSource = process.env.PANEL_CHECK_RECORD?.trim() || join(root, '.pf')
  /* No record, no run: every scene but `empty` and `broken` stands on a copy of it, and the readings are
   * computed from what the record holds, so there would be nothing to read. Say the path that was wanted
   * and how to point this elsewhere; exit 2 keeps it apart from a check that ran and failed. */
  if (!existsSync(recordSource)) {
    console.log(
      `没有可拷的记录：${recordSource} 不在。把 PANEL_CHECK_RECORD 指向一份 .pf 记录再跑（这一份自检要拿真记录喂真的两半身）。`
    )
    process.exit(2)
  }

  /** Copies the record. `.git` comes along: the tools must recognize the directory as their
   * own record store (`pf` verifies it); `worktrees` and each node's `temp` are scratch, copying them wastes time. */
  function copyRecord(target) {
    cpSync(recordSource, target, {
      recursive: true,
      filter: (source) => {
        const tail = source.slice(recordSource.length).replace(/\\/gu, '/')
        if (tail.startsWith('/worktrees') || tail.includes('/temp')) return false
        return true
      },
    })
  }
  if (existsSync(work)) rmSync(work, { recursive: true, force: true })
  for (const scene of Object.values(scenes)) mkdirSync(dirOf(scene), { recursive: true })
  /* The unreadable case: all four source files exist (`.pf` and `.pf/issues` both listable) but none
   * is readable JSON — the real host half reports `unusable` for all four. */
  mkdirSync(join(brokenWorkspace, '.pf', 'issues'), { recursive: true })
  for (const path of ['ideas.json', 'state.json', 'instructions.json', join('issues', 'issues.json')]) {
    writeFileSync(join(brokenWorkspace, '.pf', path), '这不是可读的 JSON 文本\n')
  }
  copyRecord(record)
  check('记录拷贝就位', existsSync(join(record, 'instructions.json')), record.replace(root, '.'))
  /* These two cases stage "record present, but one source holds no entries": one removes the issue
   * pool file, the other keeps only it. Neither is "no record" — `.pf` still lists, so the panel still draws its six panes. */
  copyRecord(join(bareWorkspace, '.pf'))
  rmSync(join(bareWorkspace, '.pf', 'issues', 'issues.json'), { force: true })
  copyRecord(join(poorWorkspace, '.pf'))
  for (const path of ['ideas.json', 'state.json', 'instructions.json']) {
    rmSync(join(poorWorkspace, '.pf', path), { force: true })
  }

  /** What the record looks like right now: the two write-free views must leave it untouched, checked by comparing this. */
  function recordDigest() {
    const walk = (dir) => readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => (entry.isDirectory()
        ? walk(join(dir, entry.name))
        : [`${join(dir, entry.name).replace(record, '')}:${String(readFileSync(join(dir, entry.name)).length)}`]))
      .sort()
    return walk(record).join('\n')
  }

  /* ---- 2. The real host half; writes go through the pf CLI ---------------- */

  const { PathfinderRecordsGateway } = await import(pathToFileURL(join(root, 'src', 'host', 'index.ts')).href)
  const { runPf } = await import(pathToFileURL(join(root, 'src', 'host', 'write.ts')).href)
  const { readProject, readSessions } = await import(pathToFileURL(join(root, 'src', 'model', 'index.ts')).href)

  /** Minimal stand-in for the spawn side: execFile like the host's own, windows hidden the same way. */
  function spawner() {
    /* In real deployment this gate resolves a name once and remembers it; this fixture runs a dozen
     * commands, and re-running `where` for each would be wasted work. Names are cached individually:
     * besides `pf` there is the interpreter needed for the quoted-command call. */
    const found = new Map()
    const whereIs = (command) => new Promise((resolve, reject) => {
      execFile('where', [command], { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
        if (error !== null) {
          reject(error)
          return
        }
        const hits = String(stdout).split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0)
        /* A same-named sh shim on PATH sorts ahead of the `.cmd`; only the entry with an executable extension can actually spawn. */
        const runnable = hits.find((line) => /\.(cmd|exe|bat|com)$/iu.test(line))
        resolve(runnable ?? hits[0] ?? command)
      })
    })
    return {
      async resolveExecutable(command) {
        if (!found.has(command)) found.set(command, await whereIs(command))
        return found.get(command)
      },
      spawn(spec) {
        const collected = {}
        const done = new Promise((resolve) => {
          execFile(
            spec.argv[0],
            spec.argv.slice(1),
            { cwd: spec.cwd, encoding: 'utf8', windowsHide: true },
            (error, stdout, stderr) => {
              collected.stdout = { readFrom: () => ({ text: stdout ?? '' }) }
              collected.stderr = { readFrom: () => ({ text: stderr ?? '' }) }
              resolve({ exitCode: error === null ? 0 : (error.code ?? 1) })
            },
          )
        })
        return { done, collected }
      },
    }
  }


  /* The workspace-files gate, wired to this fixture's real filesystem: the directory walk reads
   * from the root that pass's record lives in — the real gate resolves paths by session identity,
   * so this one honors `scope.workspaceRoot` too, and that wiring stays here in the caller. The
   * paging itself comes from the shared stand-in's `readPage` (tests/helpers/workspace-files-port.mjs):
   * offset-1 slicing, the eof arithmetic, the refusals — one implementation repo-wide, not a copy here. */
  function workspaceFiles(fallbackRoot) {
    const baseOf = (scope) => (typeof scope?.workspaceRoot === 'string' && scope.workspaceRoot.length > 0 ? scope.workspaceRoot : fallbackRoot)
    return {
      async list(scope, path) {
        const target = join(baseOf(scope), path)
        if (!existsSync(target)) throw absentError(target)
        const entries = readdirSync(target, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        }))
        return { path, entries, truncated: false }
      },
      async read(scope, path, range) {
        const target = join(baseOf(scope), path)
        if (!existsSync(target)) throw absentError(target)
        return readPage(readFileSync(target, 'utf8'), range)
      },
    }
  }

  const hostProcesses = spawner()

  /* Session-to-workspace mapping: the real host resolves it from the session header's `cwd`. */
  const sessionWorkspaces = new Map([
    [sessionId, workspace],
    [emptySessionId, emptyWorkspace],
    [brokenSessionId, brokenWorkspace],
    [bareSessionId, bareWorkspace],
    [poorSessionId, poorWorkspace],
  ])

  const hostCtx = {
    workspaceFiles: workspaceFiles(workspace),
    sessions: {
      get: (id) => (sessionWorkspaces.has(id) ? { header: { cwd: sessionWorkspaces.get(id) } } : undefined),
    },
    sandboxPolicy: { workspaceRoot: workspace },
    /* On the real host this is a service: one gate, the same instance every time. */
    get: (name) => (name === 'sessionPersistence' ? undefined : name === 'subprocess' ? hostProcesses : undefined),
    provide: () => undefined,
  }

  const gateway = new PathfinderRecordsGateway(hostCtx)

  /* What the wired remote namespace looks like: every call answers with the `{ ok, value }` face —
   * that is how the generated remote client folds results, and the panel side reads the same face. */
  const wrapped = (run) => async (...values) => {
    try {
      return { ok: true, value: await run(...values) }
    } catch (error) {
      return { ok: false, error: { code: 'panel-check', message: error instanceof Error ? error.message : String(error) } }
    }
  }
  const remoteFace = {
    read: wrapped((...values) => track(gateway.read(...values))),
    readSessions: wrapped((...values) => track(gateway.readSessions(...values))),
    addInstruction: wrapped((...values) => gateway.addInstruction(...values)),
    archiveInstruction: wrapped((...values) => gateway.archiveInstruction(...values)),
    reviveInstruction: wrapped((...values) => gateway.reviveInstruction(...values)),
    removeInstruction: wrapped((...values) => gateway.removeInstruction(...values)),
    readConfig: wrapped((...values) => gateway.readConfig(...values)),
    setConfig: wrapped((...values) => gateway.setConfig(...values)),
  }

  /* ---- 3. The browser half mounted into jsdom ----------------------------- */

  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
    url: 'http://127.0.0.1/',
    pretendToBeVisual: true,
  })
  const { window } = dom
  for (const name of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage', 'SVGElement', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true })
  }
  /* `navigator` is a getter-only property on Node, so its descriptor is overwritten separately. */
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { act } = React

  const consoleErrors = []
  const realError = console.error
  console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')); realError(...args) }

  let loaded = null
  window.__ModuleLoader__ = { load: (spec) => { loaded = spec } }
  await import(pathToFileURL(join(root, 'lib', 'client.js')).href)
  check('产物是外壳要的那个壳', loaded !== null && loaded.id === 'dsh-pathfinder', `id=${String(loaded?.id)}`)
  const client = loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error(`这个模块表上没有 ${name}`)
  })
  check('浏览器半身导出了 apply', typeof client.apply === 'function', `exports=${Object.keys(client).join(',')}`)

  /* The panel's words: with no locale service attached the port serves the bundled table — exactly
   * the deployment this fixture drives. One port, reused everywhere a check needs to spell a word, so
   * a heading read off the panel is compared against the same spelling the panel used rather than
   * against a Chinese literal that merely happens to match today. */
  const localePort = client.createLocalePort()
  const t = localePort.getSnapshot().t
  /* The spelling helpers themselves, loaded from source: a heading or a state word is spelled by the
   * same functions the panel calls, not by a copy of their rules. */
  const { groupWord, issueWord } = await import(pathToFileURL(join(root, 'src', 'client', 'words.ts')).href)
  /* The four empty-state sentences the panel body collapses to, spelled from the client's own word
   * tables: the assertions compare against the very words the panel renders, so a rewording moves
   * both sides together and no Chinese literal is pinned here. */
  const EMPTY_STATE_WORDS = client.WORD_TABLES.zh
  const saidNoRecord = EMPTY_STATE_WORDS['panel.no-record']
  const saidUnreadable = EMPTY_STATE_WORDS['panel.unreadable']
  const saidNotEnabled = EMPTY_STATE_WORDS['panel.not-enabled']
  const saidUngroupedEmpty = EMPTY_STATE_WORDS['panel.ungrouped-empty']

  /* The panel's stylesheet is normally attached to the document by `Entry` on first show (`ensureStyle`);
   * the fixture skips Entry, so it attaches **the shipped copy** the same way — the token landing checks below read this very sheet. */
  check('产物带着面板那一份样式表', typeof client.PANEL_CSS === 'string' && client.PANEL_CSS.length > 0, `css=${String(client.PANEL_CSS?.length ?? 0)} chars`)
  const styleNode = window.document.createElement('style')
  styleNode.textContent = client.PANEL_CSS
  window.document.head.appendChild(styleNode)

  const provided = {}

  /* ---- The settings document: built by the fixture itself, shaped like what `configForms` hands out ---
   * In real deployment the settings service provides it; here the shared stand-in is built (the
   * `watching` count is this fixture's extra face), and both the panel and the settings page read
   * it, so "flip one row, both sides follow at once" actually runs end to end in the fixture. */

  function makeConfigForms(seed) {
    const held = new Map()
    const asked = []
    return {
      asked,
      form: (namespace) => held.get(namespace),
      service: {
        get(namespace) {
          asked.push(namespace)
          if (!held.has(namespace)) held.set(namespace, fakeSettingsForm((seed ?? {})[namespace] ?? {}, { watchCount: true }))
          return held.get(namespace)
        },
      },
    }
  }

  /* ---- The navigation gate's stand-in -------------------------------------- */

  /** In real deployment, clicking a card goes through `ctx.uiWorkspace.openSession`: with the gate registered, cards have somewhere to go. */
  const navigationFace = {
    openSession: () => undefined,
  }

  /**
   * Boot a browser half: a minimal plugin context (`get` / `inject` / `effect` / `provide`).
   *
   * The slot roster is the shared stand-in (same protocol: registering the same id twice throws);
   * a `reuse` boot passes its ledger and calls back in so idempotency is only measured when both
   * registrations land on the same roster.
   * @param backend - Stand-in for the settings-service side.
   * @param into - The object `provide` writes onto.
   * @param reuse - Optional shared roster and call record.
   */
  function bootClient(backend, into, reuse) {
    const { ledger, calls, slots } = fakeSlotRoster({ ledger: reuse?.ledger, calls: reuse?.calls })
    const effects = reuse?.effects ?? []
    const ctx = {
      get(name) {
        if (name === 'remote.pathfinderRecords') return remoteFace
        if (name === 'slots') return slots
        if (name === 'uiWorkspace') return navigationFace
        if (name === 'configForms') return backend.service
        return undefined
      },
      inject(names, callback) { callback(ctx) },
      effect(run, name) {
        const off = run()
        const dispose = () => { if (typeof off === 'function') off() }
        effects.push({ name, run, off: dispose })
        return dispose
      },
      provide(key, value) { into[key] = value },
    }
    client.apply(ctx)
    return { panel: into[client.SERVICE_KEY], ledger, calls, effects }
  }

  /* Seed localStorage with the four legacy keys first, then check they were swept when the settings
   * form attached — seeding first makes the "sweep the whole `dsh-pathfinder.` prefix" rule hold for pre-existing origins too. */
  const LEGACY_SEEDED = [
    'dsh-pathfinder.sideWidth',
    'dsh-pathfinder.infoLevel',
    'dsh-pathfinder.defaultTab',
    'dsh-pathfinder.showOtherStates',
  ]
  for (const key of LEGACY_SEEDED) window.localStorage.setItem(key, '1')

  const backend = makeConfigForms()
  const booted = bootClient(backend, provided)
  const panel = booted.panel

  return {
    root, work, workspace, record, sessionId,
    emptyWorkspace, emptySessionId, brokenWorkspace, brokenSessionId,
    bareWorkspace, bareSessionId, poorWorkspace, poorSessionId,
    inFlight, track, recordDigest, outcomeText, winningDeclarations,
    gateway, hostCtx, runPf, readProject, readSessions,
    window, React, act, createRoot, consoleErrors, client,
    t, groupWord, issueWord, saidNoRecord, saidUnreadable, saidNotEnabled, saidUngroupedEmpty,
    makeConfigForms, bootClient, LEGACY_SEEDED,
    backend, booted, panel,
  }
}
