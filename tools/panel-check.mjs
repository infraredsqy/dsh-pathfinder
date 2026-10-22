// The panel's self-check fixture: real records → real host half → real panel, all three in one run.
// Every item prints its reading; any error on the console is a failure.
//
//   node tools/panel-check.mjs
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'

// React touches window/document once at load time; without them it falls back to its IE8/9 path
// (calling `attachEvent`, which would blow up here), so it must wait until jsdom is in place.

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const work = join(root, '.tmp', 'panel-check')
const workspace = join(work, 'workspace')
const record = join(workspace, '.pf')
const sessionId = 'panel-check-session'
/** Second workspace: empty, no `.pf` at all — the "current workspace has no pathfinder records" case. */
const emptyWorkspace = join(work, 'empty')
const emptySessionId = 'panel-check-empty'
/** Third workspace: `.pf` and its four files exist, but none is readable JSON — the "records unreadable" case. */
const brokenWorkspace = join(work, 'broken')
const brokenSessionId = 'panel-check-broken'
/** Fourth workspace: the three pipeline files exist, the issue pool file does not — the "issue pane collapses to one line" case. */
const bareWorkspace = join(work, 'bare')
const bareSessionId = 'panel-check-bare'
/** Fifth workspace: issue pool only (what `pf issue scan` writes in a repo with no pipeline yet),
 * none of the three pipeline files — the "board collapses to one line" case. */
const poorWorkspace = join(work, 'poor')
const poorSessionId = 'panel-check-poor'

const failures = []
const lines = []
function check(what, ok, reading) {
  lines.push(`${ok ? 'ok  ' : 'FAIL'}  ${what}  ${reading}`)
  if (!ok) failures.push(what)
}

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

function detailReadings(scope) {
  return [...scope.querySelectorAll('#pane-detail .pf-sec')].map((section) => ({
    label: section.querySelector('.pf-rowhead-key')?.textContent ?? '',
    folded: section.classList.contains('is-folded'),
    rows: [...section.querySelectorAll('.pf-row')].map((row) => ({
      id: row.getAttribute('data-id') ?? '',
      name: row.querySelector('.pf-rowtitle')?.textContent ?? '',
    })),
  }))
}

/**
 * Which groups the instructions pane should show: recomputed from the record as of now, ordered by
 * the panel pane's reader order — global first, then the record's cycles, then unrecognized scopes,
 * then the last group; empty groups are not drawn.
 *
 * The reading carries a key per group and nothing else; what that group is CALLED is the client's
 * word, so the heading is spelled through the shipped lookup table (`groupWord`) rather than carried
 * out of the model — the panel compares its head against this same spelling.
 */
function expectedNoteGroups(project, showArchived) {
  const groups = new Map()
  const hold = (key) => {
    if (!groups.has(key)) groups.set(key, [])
    return groups.get(key)
  }
  hold('global')
  for (const cycle of project.cycles) hold(`cycle:${cycle.id}`)
  hold('cycle:')
  hold('node')
  for (const entry of project.instructions) {
    /* Archived entries stay hidden by default: they return to their groups only once the settings switch is on. */
    if (showArchived !== true && entry.standing !== true) continue
    const key = entry.scope === 'global'
      ? 'global'
      : entry.scope === 'cycle'
        ? (entry.cycleId === null ? 'cycle:' : `cycle:${entry.cycleId}`)
        : 'node'
    hold(key).push(entry)
  }
  const order = ['global', ...[...groups.keys()].filter((key) => key.startsWith('cycle:') && key !== 'cycle:'), 'cycle:', 'node']
  return order
    .filter((key) => groups.get(key).length > 0)
    .map((key) => ({
      label: groupWord(t, { key }),
      rows: groups.get(key)
        .slice()
        .sort((left, right) => ((left.inForce ? 0 : 1) - (right.inForce ? 0 : 1))
          || ((right.saidAt?.getTime() ?? 0) - (left.saidAt?.getTime() ?? 0)))
        .map((entry) => entry.text ?? ''),
    }))
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

/** Copies this repo's `.pf`. `.git` comes along: the tools must recognize the directory as their
 * own record store (`pf` verifies it); `worktrees` and each node's `temp` are scratch, copying them wastes time. */
function copyRecord(target) {
  cpSync(join(root, '.pf'), target, {
    recursive: true,
    filter: (source) => {
      const tail = source.slice(join(root, '.pf').length).replace(/\\/gu, '/')
      if (tail.startsWith('/worktrees') || tail.includes('/temp')) return false
      return true
    },
  })
}

if (existsSync(work)) rmSync(work, { recursive: true, force: true })
mkdirSync(workspace, { recursive: true })
mkdirSync(emptyWorkspace, { recursive: true })
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

/** Minimal stand-in for the workspace-files gate: paged by line, reading from the root that pass's record lives in.
 * The real gate resolves paths by session identity, so this one honors `scope.workspaceRoot` too — each record points at its own root. */
function workspaceFiles(fallbackRoot) {
  const baseOf = (scope) => (typeof scope?.workspaceRoot === 'string' && scope.workspaceRoot.length > 0 ? scope.workspaceRoot : fallbackRoot)
  const absent = () => {
    const error = new Error('no entry here')
    error.code = 'workspace-file/not-found'
    return error
  }
  return {
    async list(scope, path) {
      const target = join(baseOf(scope), path)
      if (!existsSync(target)) throw absent()
      const entries = readdirSync(target, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }))
      return { path, entries, truncated: false }
    },
    async read(scope, path, range) {
      const target = join(baseOf(scope), path)
      if (!existsSync(target)) throw absent()
      const lines = readFileSync(target, 'utf8').split('\n')
      const offset = range?.offset ?? 1
      const limit = range?.limit ?? 400
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      return { text: slice.join('\n'), lines: slice.length, eof: offset - 1 + slice.length >= lines.length }
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
  setCyclePolicy: wrapped((...values) => gateway.setCyclePolicy(...values)),
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

/* The panel's stylesheet is normally attached to the document by `Entry` on first show (`ensureStyle`);
 * the fixture skips Entry, so it attaches **the shipped copy** the same way — the token landing checks below read this very sheet. */
check('产物带着面板那一份样式表', typeof client.PANEL_CSS === 'string' && client.PANEL_CSS.length > 0, `css=${String(client.PANEL_CSS?.length ?? 0)} chars`)
const styleNode = window.document.createElement('style')
styleNode.textContent = client.PANEL_CSS
window.document.head.appendChild(styleNode)

const provided = {}

/* ---- The settings document: built by the fixture itself, shaped like what `configForms` hands out ---
 * In real deployment the settings service provides it; here a same-shaped stand-in is built, and
 * both the panel and the settings page read it, so "flip one row, both sides follow at once"
 * actually runs end to end in the fixture. */

function fakeSettingsForm(initial) {
  let value = { ...initial }
  let revision = 1
  let refuse = false
  const listeners = new Set()
  return {
    document: () => value,
    getSnapshot: () => ({ status: 'ready', value, base: undefined, user: undefined, revision, writable: true }),
    /* How many subscribers are attached to this form: whether the disposer was returned is judged by this count alone. */
    watching: () => listeners.size,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    mutate(ops, expected) {
      /* A revision mismatch refuses the write: same contract as the real controller, and the write-back path assembles the same way. */
      if (refuse || (expected !== undefined && expected !== revision)) return Promise.resolve(false)
      for (const op of ops) if (op.op === 'set') value = { ...value, [op.path[0]]: op.value }
      revision += 1
      for (const listener of [...listeners]) listener()
      return Promise.resolve(true)
    },
    /* This document refuses all writes: it backs the "no silence when both writes are voided" rule. */
    refuse: (on = true) => { refuse = on },
  }
}

function makeConfigForms(seed) {
  const held = new Map()
  const asked = []
  return {
    asked,
    form: (namespace) => held.get(namespace),
    service: {
      get(namespace) {
        asked.push(namespace)
        if (!held.has(namespace)) held.set(namespace, fakeSettingsForm((seed ?? {})[namespace] ?? {}))
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
 * `slots` is a stand-in written to the real protocol: registering the same id twice throws —
 * exactly the accident to avoid. `reuse` boots again onto the same roster: idempotency is only
 * measurable when both registrations land on the same roster.
 * @param backend - Stand-in for the settings-service side.
 * @param into - The object `provide` writes onto.
 * @param reuse - Optional shared roster and call record.
 */
function bootClient(backend, into, reuse) {
  const ledger = reuse?.ledger ?? new Map()
  const calls = reuse?.calls ?? []
  const effects = reuse?.effects ?? []
  const slots = {
    inject(key, register) {
      calls.push(`inject/${key}`)
      const off = register()
      return typeof off === 'function' ? off : () => undefined
    },
    register(options, component) {
      /* Single and list seats match by `id`; the keyed slot matches by `key` — that is how the real protocol identifies entries. */
      const id = `${options.name}:${options.id ?? options.key}`
      calls.push(`register/${id}`)
      if (ledger.has(id)) throw new Error(`list slot "${options.name}" already has an entry with id "${options.id ?? options.key}"`)
      ledger.set(id, { options, component })
      return () => { ledger.delete(id) }
    },
  }
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
check('面板装成了一条服务', panel !== undefined && panel.id === 'pathfinder', `key=${client.SERVICE_KEY} id=${String(panel?.id)}`)

/* This layer registers three entries: the settings section plus the two dispatch-center seats.
 * The central slot is keyed: its roster matches by `key`, the other two by `id`. */
const SEAT_ENTRIES = [
  { key: `${client.SECTION_SLOT}:${client.SETTINGS_NAMESPACE}`, order: client.SECTION_ORDER, word: '设置里那一节' },
  { key: `sidebar.panellist:${client.PANEL_ID}`, order: client.PANEL_ORDER, word: '侧栏那一项' },
  { key: `main:${client.PANEL_ID}`, order: undefined, word: '中央栏那一格' },
]
const rosterOf = (ledger) => [...ledger.entries()].map(([key, entry]) => ({ key, order: entry.options.order }))
/** Sorted by key: the three entries sit in **different** slots, so registration order carries no
 * meaning in DSH (`order` only matters inside one list slot); the two rosters below therefore
 * compare "which entries are on it, each with what order" without pinning sequence. */
const byKey = (roster) => [...roster].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
const sameRoster = (left, right) => JSON.stringify(byKey(left)) === JSON.stringify(byKey(right))
const registeredIds = [...booted.ledger.keys()]
check(
  '这一层注册的是哪三条：槽位＋id/key 逐条摆出来',
  sameRoster(registeredIds.map((key) => ({ key })), SEAT_ENTRIES.map(({ key }) => ({ key }))),
  registeredIds.length === 0 ? 'slots 上一个注册都没有' : `注册=${registeredIds.join(', ')}`,
)
check(
  '三条各自的 order 对上，侧栏那一项落在「插件」0 与「排期」10 之间',
  sameRoster(rosterOf(booted.ledger), SEAT_ENTRIES.map(({ key, order }) => ({ key, order })))
    && client.PANEL_ORDER > 0 && client.PANEL_ORDER < 10,
  `名册=${JSON.stringify(byKey(rosterOf(booted.ledger)))} ｜ 插件=0 排期=10 这一项=${String(client.PANEL_ORDER)}`,
)
check(
  '侧栏那一行上的名字是「调度中心」，中央栏那一格与它同一个 id',
  booted.ledger.get(`sidebar.panellist:${client.PANEL_ID}`)?.options.label() === t(client.SEAT_WORD)
    && client.SEAT_WORD === 'seat.label' && t(client.SEAT_WORD) === '调度中心'
    && booted.ledger.get(`main:${client.PANEL_ID}`)?.options.key === client.PANEL_ID,
  `label()=${String(booted.ledger.get(`sidebar.panellist:${client.PANEL_ID}`)?.options.label())} ｜ 词键=${String(client.SEAT_WORD)} 词典里=${t(client.SEAT_WORD)} ｜ main key=${String(booted.ledger.get(`main:${client.PANEL_ID}`)?.options.key)}`,
)

/* Registration discipline: booting the same plugin again onto the same roster (profile reload, HMR
 * both land here) must be idempotent. `slots.register` throws when the same id is already on the
 * roster, and that throw lands inside the slot registry's notification, where React's own
 * subscription also sits — nothing shows on screen, but mouse and keyboard are all dead. */
const reuse = { ledger: new Map(), calls: [], effects: [] }
bootClient(backend, {}, reuse)
bootClient(backend, {}, reuse)
check(
  '同一本名册上再起一条插件：没有重复登记，那一下抛也停在这一层里',
  reuse.ledger.size === SEAT_ENTRIES.length
    && [...reuse.ledger.keys()].every((key) => SEAT_ENTRIES.some((one) => one.key === key))
    && reuse.calls.filter((call) => call.startsWith('register/')).length === SEAT_ENTRIES.length * 2,
  `名册 ${String(reuse.ledger.size)} 条：${[...reuse.ledger.keys()].join(', ')} ｜ 试过注册 ${String(reuse.calls.filter((call) => call.startsWith('register/')).length)} 次`,
)

/* The same effect is disposed and run again (the fiber re-entrancy pass): dispose the previous run,
 * then re-register. Disposing the seats effect takes its two entries with it while the settings
 * section stays; disposing the settings-form effect hands its subscribers back. */
const sectionEffect = reuse.effects.find((one) => one.name === 'dsh-pathfinder: settings page')
const formEffect = reuse.effects.find((one) => one.name === 'dsh-pathfinder: settings form')
const seatsEffect = reuse.effects.find((one) => one.name === 'dsh-pathfinder: seats')
const sharedForm = backend.form(client.SETTINGS_NAMESPACE)
check(
  '接设置表单那一手、登记那一页那一手与座席那一手各是一条 effect',
  formEffect !== undefined && sectionEffect !== undefined && seatsEffect !== undefined
    && new Set([formEffect, sectionEffect, seatsEffect]).size === 3,
  `effect=${reuse.effects.map((one) => String(one.name)).join(', ')}`,
)
check(
  '三趟 apply 各在设置表单上接了一个订阅者',
  sharedForm?.watching() === 3,
  `订阅者=${String(sharedForm?.watching())}`,
)
seatsEffect.off()
check(
  '收掉座席那一条 effect：那两条从名册上撤下来，设置那一节还站着',
  reuse.ledger.size === 1 && reuse.ledger.has(`${client.SECTION_SLOT}:${client.SETTINGS_NAMESPACE}`),
  `名册=${[...reuse.ledger.keys()].join(', ') || '（空）'}`,
)
seatsEffect.run()
check(
  '它再跑一遍：两条又登记回来，没有重复',
  reuse.ledger.size === SEAT_ENTRIES.length
    && sameRoster(rosterOf(reuse.ledger), SEAT_ENTRIES.map(({ key, order }) => ({ key, order }))),
  `名册=${[...reuse.ledger.keys()].join(', ') || '（空）'}`,
)
sectionEffect.off()
check(
  '收掉设置那一页那条 effect：设置那一节下来，两处座席还站着',
  reuse.ledger.size === SEAT_ENTRIES.length - 1
    && reuse.ledger.has(`${client.SECTION_SLOT}:${client.SETTINGS_NAMESPACE}`) === false,
  `名册=${[...reuse.ledger.keys()].join(', ') || '（空）'}`,
)
sectionEffect.run()
check(
  'effect 再跑一遍：又登记回同一条，没有重复',
  reuse.ledger.size === SEAT_ENTRIES.length
    && reuse.ledger.has(`${client.SECTION_SLOT}:${client.SETTINGS_NAMESPACE}`)
    && [...reuse.ledger.keys()].sort().join(' | ')
      === SEAT_ENTRIES.map((one) => one.key).sort().join(' | '),
  `名册=${[...reuse.ledger.keys()].join(', ') || '（空）'}`,
)
formEffect?.off()
check(
  '收掉接设置表单那条 effect：接在设置表单上那个订阅者还回去了',
  sharedForm?.watching() === 2,
  `订阅者=${String(sharedForm?.watching())}`,
)
formEffect?.run()
check(
  '它再跑一遍：订阅者又接回来一个',
  sharedForm?.watching() === 3,
  `订阅者=${String(sharedForm?.watching())}`,
)

/* ---- 4. Draw it, open each view in turn ---------------------------------- */

const container = window.document.getElementById('app')
const reactRoot = createRoot(container)

/* How many times the write face was called: clicking through the views must leave this count frozen. */
const writeCalls = []
/** Which roots the panel asked the host for: what the top workspace picker selects is visible here. */
const askedRoots = []
const trackedPort = {
  ...panel.port,
  read(id, workspaceRoot, signal) {
    askedRoots.push(workspaceRoot)
    return track(panel.port.read(id, workspaceRoot, signal))
  },
  readSessions(id, workspaceRoot) {
    return track(panel.port.readSessions(id, workspaceRoot))
  },
  write(verb, id, workspaceRoot, target) {
    writeCalls.push(`write/${verb}`)
    return track(panel.port.write(verb, id, workspaceRoot, target))
  },
  say(id, workspaceRoot, text, scope, cycle, node) {
    writeCalls.push(`say/${scope}`)
    return track(panel.port.say(id, workspaceRoot, text, scope, cycle, node))
  },
  setPolicy(id, workspaceRoot, cycle, key, value) {
    writeCalls.push(`setPolicy/${key}`)
    return track(panel.port.setPolicy(id, workspaceRoot, cycle, key, value))
  },
  readConfig(id, workspaceRoot) {
    return track(panel.port.readConfig(id, workspaceRoot))
  },
  setConfig(id, workspaceRoot, key, value) {
    writeCalls.push(`setConfig/${key}`)
    return track(panel.port.setConfig(id, workspaceRoot, key, value))
  },
}
/** Wait out the panel's actions for this pass: after a write it reads once more, so wait until nothing is in flight. */
const settle = async () => {
  for (let round = 0; round < 6; round++) {
    const pending = inFlight.splice(0)
    if (pending.length === 0) return
    await act(async () => { await Promise.all(pending) })
  }
}

await act(async () => {
  reactRoot.render(React.createElement(panel.Panel, { port: trackedPort, sessionId, prefs: panel.prefs }))
})
await settle()

const text = () => container.textContent ?? ''
const tabs = [...container.querySelectorAll('.pf-tab')]
check('六个标签都在', tabs.length === 6, tabs.map((tab) => tab.textContent).join('/'))

const views = ['当前', '明细', '指令', '依赖', '问题', '设置']
for (const [index, label] of views.entries()) {
  await act(async () => { tabs[index].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  const pane = container.querySelector(`#pane-${['now', 'detail', 'notes', 'wires', 'issue', 'config'][index]}`)
  check(`看法「${label}」渲染出内容`, pane !== null && pane.hidden === false, pane === null ? '没有这一格' : `pane-${pane.id}`)
}

/* Fill follows the view: Now does not fill, the detail pane fills. */
await act(async () => { tabs[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const frameNow = container.querySelector('#frame')
check('当前那一格不撑满', frameNow.classList.contains('is-fill') === false, `class=${frameNow.className}`)
await act(async () => { tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('明细那一格撑满', container.querySelector('#frame').classList.contains('is-fill') === true, 'is-fill')

/* The Now pane's readings must match the record: the four pill counts and the three column card
 * counts, each compared against values computed from the record. "The pane has text"-style asserts
 * would not do — the three static column headers in #pane-now alone would satisfy them, regardless of the record. */
await act(async () => { tabs[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const reading = await gateway.read(sessionId, '', {})
const project = readProject({ nodes: reading.nodes, cycles: reading.cycles, instructions: reading.instructions, issues: reading.issues, at: new Date() })
lines.push(`      记录里的读数：${JSON.stringify(reading.sources)}`)
/* This pass never touched the cards-per-column setting: it stays on the default "expanded", at most three per column. */
const infoCap = 3
const expectedPills = [
  ...(project.columns.shelved.length > 0 ? [['等待处理', project.columns.shelved.length]] : []),
  ['已交付', project.columns.completed.length],
  ['进行中', project.columns.running.length],
  ['未开始', project.columns.todo.length],
]
const pillReadings = [...container.querySelectorAll('#census .pf-pill')].map((pill) => [
  pill.getAttribute('title'),
  Number.parseInt((pill.querySelector('.pf-num')?.textContent ?? '').replace(/[^\d]/gu, ''), 10),
])
const expectedCards = [
  Math.min(infoCap, project.columns.shelved.length + project.columns.running.length),
  Math.min(infoCap, project.columns.completed.length),
  Math.min(infoCap, project.columns.ready.length),
]
const cardReadings = [...container.querySelectorAll('#cols .pf-col')].map((column) => column.querySelectorAll('.pf-card').length)
const sum = (list) => list.reduce((total, one) => total + one, 0)
check(
  '看板上的数从记录里来：胶囊与三列卡片数逐项对上',
  JSON.stringify(pillReadings) === JSON.stringify(expectedPills)
    && JSON.stringify(cardReadings) === JSON.stringify(expectedCards)
    && sum(cardReadings) === sum(expectedCards),
  `记录现算 胶囊=${JSON.stringify(expectedPills)} 三列=${JSON.stringify(expectedCards)} ｜ 面板上 胶囊=${JSON.stringify(pillReadings)} 三列=${JSON.stringify(cardReadings)} 总卡=${String(sum(cardReadings))}`,
)

/* Session notes: the host half hauls that directory back as-is, and the model layer reads "which
 * session each pane points to" against it. The fixture recomputes the mapping from the copied
 * record itself to audit the haul → read chain — keys are file names minus the extension; when a
 * pane has several, the latest timestamp wins, and a same-timestamp run beats a discussion. */
const sessionsDir = join(record, 'meta', 'sessions')
const wantSessions = {}
for (const name of existsSync(sessionsDir) ? readdirSync(sessionsDir) : []) {
  if (!name.endsWith('.json')) continue
  let note
  try {
    note = JSON.parse(readFileSync(join(sessionsDir, name), 'utf8'))
  } catch {
    continue
  }
  let best
  for (const [rank, kind] of [[1, 'run'], [0, 'discussion']]) {
    for (const ref of Array.isArray(note?.[kind]) ? note[kind] : []) {
      if (typeof ref?.session !== 'string' || ref.session.length === 0) continue
      const at = typeof ref.at === 'string' ? ref.at : ''
      if (best === undefined || at > best.at || (at === best.at && rank > best.rank)) best = { session: ref.session, at, rank }
    }
  }
  if (best !== undefined) wantSessions[name.slice(0, -'.json'.length)] = best.session
}
const hauled = await gateway.readSessions(sessionId, '')
const gotSessions = readSessions(hauled.notes)
check(
  '会话笔记：宿主搬回的原样经模型层读出，每一格该去的那条与夹具现算的对上',
  JSON.stringify(gotSessions) === JSON.stringify(wantSessions),
  `夹具现算 ${String(Object.keys(wantSessions).length)} 格 ｜ 链上读出 ${String(Object.keys(gotSessions).length)} 格`,
)

/* ---- 3c. The two dispatch-center seats: the real product mounted, each shown once ----
 *
 * The sidebar item and the central slot render their registered components in their real shape —
 * the former draws an icon, the latter is the panel body (it draws the record of whichever
 * workspace's session it asks the host for). `useSessions` in the seat's standard props is a
 * projected hook: `ids` is the host's list order (another session first), and the current session's
 * entry in `byId` carries `retainedBy.mainView`. `seatReads` records whether the two seats picked
 * the right session.
 */
const otherSessionId = 'panel-check-other'
const snapshotAt = (id) => ({
  ids: [otherSessionId, id],
  byId: {
    [otherSessionId]: { id: otherSessionId, retainedBy: {} },
    [id]: { id, retainedBy: { mainView: 1 } },
  },
  phase: 'ready',
  projectionsBySession: {},
})
const sessionsAt = (id) => (select) => select(snapshotAt(id))
/** Session ids the two seats hand to the host gate, recorded in order. */
const seatReads = []
const seatPortRead = panel.port.read
panel.port.read = (id, signal) => {
  seatReads.push(id)
  return seatPortRead(id, signal)
}
const seatHost = window.document.createElement('div')
window.document.body.appendChild(seatHost)
const seatRoot = createRoot(seatHost)
const seatEntries = {
  side: booted.ledger.get(`sidebar.panellist:${client.PANEL_ID}`),
  main: booted.ledger.get(`main:${client.PANEL_ID}`),
}
check(
  '两处各有一条注册，整条 entry 只注册一次',
  seatEntries.side !== undefined && seatEntries.main !== undefined
    && [...booted.ledger.keys()].filter((key) => key.startsWith('sidebar.panellist:')).length === 1
    && [...booted.ledger.keys()].filter((key) => key.startsWith('main:')).length === 1,
  `名册=${[...booted.ledger.keys()].join(', ')}`,
)

await act(async () => {
  seatRoot.render(React.createElement(React.Fragment, null,
    React.createElement(seatEntries.side.component, { size: 16 }),
    React.createElement(seatEntries.main.component, {
      ...seatEntries.main.options.inject(), useSessions: sessionsAt(sessionId),
    }),
  ))
})
await settle()

check(
  '当前会话落在 ids 第二位时，两处座席向宿主问的仍是它（retainedBy.mainView 那条）',
  seatReads.length > 0 && seatReads.every((id) => id === sessionId)
    && snapshotAt(sessionId).ids[0] === otherSessionId,
  `清单次序=${JSON.stringify(snapshotAt(sessionId).ids)} 当前会话=${sessionId} ｜ 座席问过的会话=${JSON.stringify([...new Set(seatReads)])}`,
)

const sideGlyph = seatHost.querySelector('svg')
check(
  '侧栏那一项自画一枚内联 SVG：产物里只有 react 是 external，DSH 的图标包引不得',
  sideGlyph !== null && sideGlyph.getAttribute('width') === '16' && sideGlyph.getAttribute('height') === '16'
    && sideGlyph.getAttribute('aria-hidden') === 'true',
  sideGlyph === null
    ? '没有画出来'
    : `svg ${String(sideGlyph.getAttribute('width'))}×${String(sideGlyph.getAttribute('height'))} aria-hidden=${String(sideGlyph.getAttribute('aria-hidden'))} 子元素=${String(sideGlyph.children.length)} 枚`,
)

/* The empty-record workspace case: no `.pf` at all, the read succeeds and all four sources report
 * `missing`. The panel body collapses to one line, and the tabs, the top-right counts and the six
 * panes are withdrawn with it (the testbed's synthetic workspace is exactly this case). */
const flat = (node) => (node?.textContent ?? '').replace(/\s+/gu, ' ').trim()
const emptyHost = window.document.createElement('div')
window.document.body.appendChild(emptyHost)
const emptyRoot = createRoot(emptyHost)
await act(async () => {
  emptyRoot.render(React.createElement(panel.Panel, { port: trackedPort, sessionId: emptySessionId, prefs: panel.prefs }))
})
await settle()
const emptySaid = flat(emptyHost.querySelector('.pf-none p'))
check(
  '空记录的工作区：面板正文只留「当前工作区没有 pathfinder 的记录」，标签、计数与六格一起收走',
  emptyHost.querySelector('.pf-none') !== null
    && emptySaid === '当前工作区没有 pathfinder 的记录。'
    && emptyHost.querySelector('.pf-tabs') === null
    && emptyHost.querySelector('.pf-count') === null
    && emptyHost.querySelectorAll('.pf-pane').length === 0,
  `工作区=${emptyWorkspace.replace(root, '.')}（没有 .pf） ｜ .pf-none p=${JSON.stringify(emptySaid)} ｜ 标签 ${String(emptyHost.querySelectorAll('.pf-tabs').length)} 处、计数 ${String(emptyHost.querySelectorAll('.pf-count').length)} 处、六格 ${String(emptyHost.querySelectorAll('.pf-pane').length)} 处`,
)

/* The unreadable-record case: `.pf` exists, all four files exist, but none parses (all four sources
 * `unusable`). The panel body shows a **different sentence** — not the same thing as the "no record" case above. */
const brokenHost = window.document.createElement('div')
window.document.body.appendChild(brokenHost)
const brokenRoot = createRoot(brokenHost)
await act(async () => {
  brokenRoot.render(React.createElement(panel.Panel, { port: trackedPort, sessionId: brokenSessionId, prefs: panel.prefs }))
})
await settle()
const brokenSaid = flat(brokenHost.querySelector('.pf-none p'))
check(
  '记录读不动的工作区：面板正文摆「无法读取当前工作区的记录」，与「没有记录」那句分得开',
  brokenHost.querySelector('.pf-none') !== null
    && brokenSaid === '无法读取当前工作区的记录。'
    && brokenSaid !== '当前工作区没有 pathfinder 的记录。'
    && brokenHost.querySelector('.pf-tabs') === null
    && brokenHost.querySelector('.pf-count') === null
    && brokenHost.querySelectorAll('.pf-pane').length === 0,
  `工作区=${brokenWorkspace.replace(root, '.')}（.pf 在、四份读不动） ｜ .pf-none p=${JSON.stringify(brokenSaid)} ｜ 标签 ${String(brokenHost.querySelectorAll('.pf-tabs').length)} 处、计数 ${String(brokenHost.querySelectorAll('.pf-count').length)} 处、六格 ${String(brokenHost.querySelectorAll('.pf-pane').length)} 处`,
)

/* Pipeline present, issue pool absent: the five node-following panes stay as usual (the board has
 * cards, the settings pane shows controls), and the issue pane collapses to "Pathfinder is not
 * enabled for this workspace" — it follows the issue file alone. */
const bareHost = window.document.createElement('div')
window.document.body.appendChild(bareHost)
const bareRoot = createRoot(bareHost)
await act(async () => {
  bareRoot.render(React.createElement(panel.Panel, { port: trackedPort, sessionId: bareSessionId, prefs: panel.prefs }))
})
await settle()
const bareSaid = flat(bareHost.querySelector('#pane-issue .pf-innone'))
check(
  '有节点、问题池空的工作区：五个跟节点走的格子照旧，问题那一格收成「当前工作区尚未启用 Pathfinder」',
  bareHost.querySelector('.pf-none') === null
    && bareHost.querySelector('#pane-now .pf-boardbar') !== null
    && bareHost.querySelectorAll('#pane-now .pf-card').length > 0
    && bareHost.querySelector('#census .pf-pill') !== null
    && bareHost.querySelector('#pane-config .pf-configwrap') !== null
    && bareSaid === '当前工作区尚未启用 Pathfinder。'
    && bareHost.querySelector('#pane-issue .pf-split') === null,
  `工作区=${bareWorkspace.replace(root, '.')}（管线在、问题池那一份不在） ｜ 看板 ${String(bareHost.querySelectorAll('#pane-now .pf-card').length)} 张卡 ｜ 问题那一格说=${JSON.stringify(bareSaid)}`,
)

/* The issue-pool-only case (what `pf issue scan` writes in a repo with no pipeline yet): each of
 * the five node-following panes collapses to the same sentence, and the header counts stop
 * reporting three zeros; the issue pane is the exception — it still draws the pool, every entry of it. */
const poorHost = window.document.createElement('div')
window.document.body.appendChild(poorHost)
const poorRoot = createRoot(poorHost)
await act(async () => {
  poorRoot.render(React.createElement(panel.Panel, { port: trackedPort, sessionId: poorSessionId, prefs: panel.prefs }))
})
await settle()
const poorSaid = ['now', 'detail', 'wires', 'notes', 'config']
  .map((id) => flat(poorHost.querySelector(`#pane-${id} .pf-innone`)))
/* What the issue pane draws is computed from the pool's readings, not from an assumption that the
   register still holds open rows: this fixture is live data and the open set will eventually empty —
   the lean tier (the default) draws only the open rows, none once cleared, with the register itself
   still standing; when the pool is empty the whole pane collapses to the same sentence (pool.tsx's
   `pool.rows.length === 0` early exit). Row identity is compared entry by entry against the record's
   open pile, in the same way as the 4c fold-pile section. */
const poorOpenIds = project.pool.groups.find((group) => group.key === 'open')?.entries.map((entry) => entry.id) ?? []
const poorRows = [...poorHost.querySelectorAll('#pane-issue .pf-row[data-issue]')]
const poorIssueSaid = flat(poorHost.querySelector('#pane-issue .pf-innone'))
check(
  '只有问题池的工作区：五个跟节点走的格子各自收成同一句话，问题那一格照池子读数走——有行画登记簿（精简档=未解决那几条），一条不剩收成同一句话',
  poorHost.querySelector('.pf-none') === null
    && poorSaid.every((said) => said === '当前工作区尚未启用 Pathfinder。')
    && poorHost.querySelectorAll('.pf-tabs').length === 1
    && poorHost.querySelectorAll('.pf-pane').length === 6
    && poorHost.querySelector('#pane-now .pf-boardbar') === null
    && poorHost.querySelector('#census') === null
    && (project.pool.rows.length === 0
      ? poorIssueSaid === '当前工作区尚未启用 Pathfinder。'
      : poorIssueSaid === ''
        && poorHost.querySelector('#pane-issue .pf-split') !== null
        && JSON.stringify(poorRows.map((row) => row.getAttribute('data-issue'))) === JSON.stringify(poorOpenIds)),
  `工作区=${poorWorkspace.replace(root, '.')}（只有问题池） ｜ 五格=${JSON.stringify(poorSaid)} ｜ 页头计数 ${String(poorHost.querySelectorAll('#census').length)} 处、六格 ${String(poorHost.querySelectorAll('.pf-pane').length)} 格 ｜ 池子读数 共 ${String(project.pool.rows.length)} 条、未解决 ${String(poorOpenIds.length)} 条 ｜ 问题那一格 ${String(poorRows.length)} 行`,
)

/* The panes left with one sentence: the module fills its area. Unfilled, the stage centers the
 * module vertically, so the sentence floats mid-pane one step right of the header's left edge
 * (measured in a 1400-wide window: 300px from the left edge, 317px below the tabs); filled, it sits
 * at this pane's own top-left, the same spot as the other five. jsdom does no layout, so what is
 * measured here is the marker class. */
const poorFrame = poorHost.querySelector('#frame')
check(
  '只剩一句话的那几格：模块撑满地界（那句话因此落在这一格自己的左上角）',
  poorFrame !== null && poorFrame.classList.contains('is-fill'),
  `模块 class=${JSON.stringify(poorFrame?.className ?? null)}`,
)

/* The readable record stays as usual: tabs, counts and six panes all present, no such sentence in the body. */
check(
  '这一份记录读得回来：六格标签、右上那排计数与六格正文照旧画着，正文里没有那句话',
  tabs.length === 6 && container.querySelector('.pf-count') !== null
    && container.querySelectorAll('.pf-pane').length === 6
    && container.querySelector('.pf-none') === null,
  `标签 ${String(tabs.length)} 枚 ｜ 计数 ${String(container.querySelectorAll('.pf-count').length)} 处 ｜ 六格 ${String(container.querySelectorAll('.pf-pane').length)} 格 ｜ .pf-none ${container.querySelector('.pf-none') === null ? '（没有）' : '画了出来'}`,
)

/* ---- 3d. The top workspace picker: whichever is picked is the one read ----
 *
 * The list follows DSH's manifest (titles plus the trailing "Ungrouped" entry), the default stays
 * on the bucket this session falls in, and switching entries hands that root to the host with the
 * screen swapping to what that root reads. Switches hand over absolute paths (`askedRoots` compares
 * per entry); "Ungrouped" is not a root, and splits in two (the afb7ca0 contract): when the session
 * belongs to some bucket, no read is issued at all and the panel collapses to the "no records under
 * Ungrouped" sentence with the picker kept; when the session belongs to no bucket, it counts as
 * Ungrouped and an empty string is handed over, still reading its own root.
 */
const spaceItems = [
  { workspaceId: 'w-main', path: workspace, title: '主工作区', sessionIds: [sessionId] },
  { workspaceId: 'w-empty', path: emptyWorkspace, title: '空工作区', sessionIds: [emptySessionId] },
  { workspaceId: 'w-broken', path: brokenWorkspace, title: '读不动的工作区', sessionIds: [brokenSessionId] },
]
/* The snapshot must be the same object: `getSnapshot` assembling a fresh one each call would look like constant change to React. */
const spaceSnapshot = { items: spaceItems }
const spaceSource = { getSnapshot: () => spaceSnapshot, subscribe: () => () => undefined }
const spaceHost = window.document.createElement('div')
window.document.body.appendChild(spaceHost)
const spaceRoot = createRoot(spaceHost)
askedRoots.length = 0
await act(async () => {
  spaceRoot.render(React.createElement(panel.Panel, {
    port: trackedPort, sessionId, prefs: panel.prefs, workspaces: spaceSource,
  }))
})
await settle()

/* These two scope to the one in the page header: `.pf-pick` appears more than once (the instructions
   pane's scope field is the same class), and without narrowing, that one's options would be counted
   into the workspace list. */
const spaceSelect = () => spaceHost.querySelector('.pf-head .pf-pick select')
const spaceOptions = () => [...spaceHost.querySelectorAll('.pf-head .pf-pick select option')]
check(
  '顶上那枚选择器：名单就是 DSH 那份清单的标题，末尾一档是「未分组」，默认停在会话落的那个桶',
  spaceSelect() !== null
    && JSON.stringify(spaceOptions().map((option) => option.textContent)) === JSON.stringify(['主工作区', '空工作区', '读不动的工作区', '未分组'])
    && spaceSelect().value === 'w-main'
    && askedRoots.length > 0 && askedRoots.every((one) => one === workspace),
  `候选=${JSON.stringify(spaceOptions().map((option) => option.textContent))} 选中=${JSON.stringify(spaceSelect()?.value)} ｜ 问过的根=${JSON.stringify([...new Set(askedRoots)].map((one) => (one === '' ? '（空：会话自己那个）' : one.replace(root, '.'))))}`,
)

const pickWorkspace = async (value) => {
  await act(async () => {
    spaceSelect().value = value
    spaceSelect().dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await settle()
}

askedRoots.length = 0
await pickWorkspace('w-empty')
const spaceEmpty = flat(spaceHost.querySelector('.pf-none p'))
check(
  '拨到空记录那个工作区：递出去的是它的绝对路径，正文当场换成「当前工作区没有 pathfinder 的记录」',
  askedRoots.includes(emptyWorkspace) && spaceEmpty === '当前工作区没有 pathfinder 的记录。'
    && spaceHost.querySelector('.pf-tabs') === null && spaceHost.querySelectorAll('.pf-pane').length === 0,
  `问过的根=${JSON.stringify([...new Set(askedRoots)].map((one) => (one === '' ? '（空）' : one.replace(root, '.'))))} ｜ .pf-none p=${JSON.stringify(spaceEmpty)}`,
)

askedRoots.length = 0
await pickWorkspace('w-broken')
const spaceBroken = flat(spaceHost.querySelector('.pf-none p'))
check(
  '拨到读不动那个工作区：正文摆的是另一句，与「没有记录」分得开',
  askedRoots.includes(brokenWorkspace) && spaceBroken === '无法读取当前工作区的记录。'
    && spaceBroken !== '当前工作区没有 pathfinder 的记录。',
  `问过的根=${JSON.stringify([...new Set(askedRoots)].map((one) => (one === '' ? '（空）' : one.replace(root, '.'))))} ｜ .pf-none p=${JSON.stringify(spaceBroken)}`,
)

askedRoots.length = 0
await pickWorkspace('')
const spaceUngrouped = flat(spaceHost.querySelector('.pf-none p'))
const ungroupedSelect = spaceHost.querySelector('.pf-head .pf-pick select')
check(
  '拨到「未分组」：这条会话有归属，一趟读数都不发，正文收成「未分组名下没有记录」那一句，选择器还留着',
  askedRoots.length === 0 && spaceUngrouped === '未分组名下没有记录；这条会话属于清单里的某个工作区。'
    && ungroupedSelect !== null && ungroupedSelect.value === ''
    && spaceHost.querySelector('.pf-tabs') === null && spaceHost.querySelectorAll('.pf-pane').length === 0,
  `问过的根=${JSON.stringify([...new Set(askedRoots)])} ｜ .pf-none p=${JSON.stringify(spaceUngrouped)} ｜ 选择器=${ungroupedSelect === null ? '（没了）' : `选中=${JSON.stringify(ungroupedSelect.value)}`} ｜ 六格 ${String(spaceHost.querySelectorAll('.pf-pane').length)} 格`,
)

await act(async () => { spaceRoot.unmount() })

/* The session truly outside every workspace: the same manifest, only no bucket carries this session —
 * DSH files it under "Ungrouped" and defaults there. afb7ca0's "still reads its own root" is this branch. */
const loneSnapshot = { items: spaceItems.map((item) => ({ ...item, sessionIds: [] })) }
const loneSource = { getSnapshot: () => loneSnapshot, subscribe: () => () => undefined }
const loneHost = window.document.createElement('div')
window.document.body.appendChild(loneHost)
const loneRoot = createRoot(loneHost)
askedRoots.length = 0
await act(async () => {
  loneRoot.render(React.createElement(panel.Panel, {
    port: trackedPort, sessionId, prefs: panel.prefs, workspaces: loneSource,
  }))
})
await settle()
const loneSelect = () => loneHost.querySelector('.pf-head .pf-pick select')
check(
  '谁的桶都不在的会话：默认就停在「未分组」，照旧递空字符串读它自己那个根，六格与计数都在',
  loneSelect() !== null && loneSelect().value === ''
    && askedRoots.length > 0 && askedRoots.every((one) => one === '')
    && loneHost.querySelector('.pf-none') === null
    && loneHost.querySelectorAll('.pf-pane').length === 6 && loneHost.querySelector('.pf-count') !== null,
  `选中=${JSON.stringify(loneSelect()?.value)} ｜ 问过的根=${JSON.stringify([...new Set(askedRoots)].map((one) => (one === '' ? '（空：会话自己那个）' : one.replace(root, '.'))))} ｜ 六格 ${String(loneHost.querySelectorAll('.pf-pane').length)} 格 ｜ .pf-none ${loneHost.querySelector('.pf-none') === null ? '（没有）' : '画了出来'}`,
)

/* Switching away and back to "Ungrouped" is the same branch: pickedSpace lands on null while the
 * session has no bucket, so the read still goes out — the collapse-to-one-sentence branch only
 * applies to sessions with a bucket (the previous pass). */
await act(async () => {
  loneSelect().value = 'w-empty'
  loneSelect().dispatchEvent(new window.Event('change', { bubbles: true }))
})
await settle()
askedRoots.length = 0
await act(async () => {
  loneSelect().value = ''
  loneSelect().dispatchEvent(new window.Event('change', { bubbles: true }))
})
await settle()
check(
  '拨去别处再拨回「未分组」：没有归属的会话照旧读它自己那个根，六格与计数都在',
  askedRoots.length > 0 && askedRoots.every((one) => one === '')
    && loneHost.querySelector('.pf-none') === null
    && loneHost.querySelectorAll('.pf-pane').length === 6 && loneHost.querySelector('.pf-count') !== null,
  `问过的根=${JSON.stringify([...new Set(askedRoots)].map((one) => (one === '' ? '（空：会话自己那个）' : one.replace(root, '.'))))} ｜ 六格 ${String(loneHost.querySelectorAll('.pf-pane').length)} 格 ｜ .pf-none ${loneHost.querySelector('.pf-none') === null ? '（没有）' : '画了出来'}`,
)

await act(async () => { loneRoot.unmount() })

/* The nine `--pf-*` declaration points in the shipped css, measured by the values resolved on the
 * panel's DOM: when a declaration lands on a selector matching nothing (`.pf-page body` /
 * `.pf-page :root`), this reads an empty string — and the fallback-less `var(--pf-ink-2)` reads go
 * void with it.
 *
 * The same ruler covers the `box-sizing` reset in `src/client/styles/tokens.css`: written as
 * `.pf-page, .pf-page *`, it must catch the panel root itself alongside its descendants — miss the
 * root and 24px comes back below. */
const TOKEN_VALUES = {
  '--pf-mark-floor': '3',
  '--pf-mark-floor-dense': '1.5',
  '--pf-ink-1': 'var(--dsw-alias-label-primary)',
  '--pf-ink-2': 'var(--dsw-alias-label-secondary)',
  '--pf-ink-3': 'var(--dsw-alias-label-tertiary)',
  '--pf-ink-4': 'color-mix(in srgb, var(--dsw-alias-label-tertiary) 50%, transparent)',
  '--pf-pad': '24px',
  '--pf-row': '30px',
  '--pf-mark': '14px',
}
const panelRoot = container.querySelector('.pf-page')
const rootStyle = window.getComputedStyle(panelRoot)
const tokenReadings = Object.entries(TOKEN_VALUES).map(([token, want]) => {
  const got = rootStyle.getPropertyValue(token).replace(/\s+/gu, ' ').trim()
  return `${token}=${got === want ? 'ok' : `"${got}"（要 "${want}"）`}`
})
const rootWon = winningDeclarations(panelRoot, ['box-sizing'])
check(
  '面板根吃到了蓝本固定在页面根 / 全局上的那一批（九个 --pf-* 令牌 + reset 的 box-sizing）',
  panelRoot !== null
    && Object.entries(TOKEN_VALUES).every(([token, want]) => rootStyle.getPropertyValue(token).replace(/\s+/gu, ' ').trim() === want)
    && rootWon['box-sizing'] === 'border-box',
  `${tokenReadings.join(' ')} ｜ box-sizing=${rootWon['box-sizing'] === undefined ? '（没有规则落在它身上）' : `"${rootWon['box-sizing']}"`}`,
)

/* `settings.css` ships as the seven rules that land on the panel; the settings page's own furniture
 * is drawing rather than shipping, and lives with the design snapshot outside this repo. Two of the
 * seven (stage and frame) are what centres the pane: this walks DOM matching to see whose
 * declaration lands on `.pf-stage` and `.pf-frame`. */
const stageWon = winningDeclarations(container.querySelector('.pf-stage'), ['padding', 'align-items', 'height'])
const frameWon = winningDeclarations(container.querySelector('.pf-frame'), ['width', 'max-height', 'min-height'])
const carriedOk = stageWon.padding === '20px 0' && stageWon['align-items'] === 'center' && stageWon.height === '100%'
  && frameWon.width === 'var(--pf-frame-w, 800px)' && frameWon['max-height'] === '100%' && frameWon['min-height'] === '0'
check(
  '舞台与框在蓝本里的有效值进了包',
  carriedOk,
  `stage padding=${JSON.stringify(stageWon.padding)} align-items=${JSON.stringify(stageWon['align-items'])} height=${JSON.stringify(stageWon.height)} ｜ frame width=${JSON.stringify(frameWon.width)} max-height=${JSON.stringify(frameWon['max-height'])} min-height=${JSON.stringify(frameWon['min-height'])}`,
)

/* The equivalence ruler lived here: it compared the shipped css against the blueprint's sheets rule by
 * rule, sheet by sheet, and the two embedded panes' landing against a copy of those sheets. It
 * existed to prove the build's scoping pass faithful, and that pass is gone — `src/client/styles/`
 * is read in order as the shipped bytes, so there is nothing left to compare them to. The notches
 * it guarded (`.is-embed.pf-wires X`, `.pf-issue .pf-register .pf-row`) are written out plainly in
 * those sheets, where an editor sees them. What stands in its place: the build's own layer ruler (a
 * selector escaping its layer stops the build), the token probe just above, and 4b / 4c below.
 */

/* ---- 4a. The settings section: a navigation row + the page it opens, reading the same settings form as the panel ----
 * This section lives in DSH's own settings panel, not in the main panel's tree, so the product's
 * registered component is mounted into a DOM of its own here. The criterion: flip one row and the
 * panel's corresponding reading follows at once.
 */

const settingsForm = backend.form(client.SETTINGS_NAMESPACE)
const settingsDoc = () => settingsForm?.document() ?? {}
const sectionEntry = booted.ledger.get(`${client.SECTION_SLOT}:${client.SETTINGS_NAMESPACE}`)
check(
  '注册的 id 就是设置命名空间的字符串，槽位是设置里那一节',
  sectionEntry?.options.name === client.SECTION_SLOT && sectionEntry?.options.id === client.SETTINGS_NAMESPACE,
  `name=${String(sectionEntry?.options.name)} id=${String(sectionEntry?.options.id)}`,
)
check(
  '面板与设置页要的是同一份表单',
  backend.asked.includes(client.SETTINGS_NAMESPACE) && settingsForm !== undefined,
  `要过的命名空间=${backend.asked.join(',') || '（一个都没有）'}`,
)

const settingsHost = window.document.createElement('div')
window.document.body.appendChild(settingsHost)
const settingsRoot = createRoot(settingsHost)
await act(async () => {
  settingsRoot.render(React.createElement(sectionEntry.component, sectionEntry.options.inject()))
})
await settle()

const settingRows = () => [...settingsHost.querySelectorAll('.pfset-row')]
const rowNamed = (label) => settingRows().find((row) => row.querySelector('.pfset-label')?.textContent === label)
const rowNames = settingRows().map((row) => row.querySelector('.pfset-label')?.textContent ?? '')
check(
  '设置里那一页是四行，侧栏宽度不在其中',
  settingRows().length === 4 && rowNames.join('/') === '默认信息量/默认标签页/指令里显示已归档的/问题池里显示未解决之外的',
  `四行=${rowNames.join('/') || '（一行都没有）'}`,
)

const pressSeg = async (label) => {
  const button = [...(rowNamed('默认信息量')?.querySelectorAll('.pfset-segbtn') ?? [])]
    .find((one) => one.textContent === label)
  await act(async () => { button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
}
const flipSwitch = async (label) => {
  const button = rowNamed(label)?.querySelector('.pfset-switch')
  await act(async () => { button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
}

/* Default info level: flipping to "lean" of the three tiers caps each column at one card. Flipped
   back to "expanded" at the end, so later readings match this pass's starting point. */
await act(async () => { tabs[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await settle()
const cardCounts = () => [...container.querySelectorAll('#cols .pf-col')]
  .map((column) => column.querySelectorAll('.pf-card').length)
const cardsBefore = cardCounts()
await pressSeg('精简')
const cardsAfter = cardCounts()
check(
  '翻设置里「默认信息量」那一行：面板上每列的卡片当场跟着换档',
  JSON.stringify(cardsAfter) === JSON.stringify(cardsBefore.map((n) => Math.min(1, n)))
    && JSON.stringify(cardsAfter) !== JSON.stringify(cardsBefore)
    && settingsDoc().infoLevel === 'lean',
  `翻之前=${JSON.stringify(cardsBefore)} 翻之后=${JSON.stringify(cardsAfter)} ｜ 文档里 infoLevel=${String(settingsDoc().infoLevel)}`,
)
await pressSeg('展开')
check(
  '翻回「展开」：卡片数回到原来的档，文档里也回到那一档',
  JSON.stringify(cardCounts()) === JSON.stringify(cardsBefore) && settingsDoc().infoLevel === 'three',
  `卡片=${JSON.stringify(cardCounts())} ｜ 文档里 infoLevel=${String(settingsDoc().infoLevel)}`,
)

/* Default tab: picking "Instructions" in settings switches the panel to that pane at once. */
const pickOption = async (select, text) => {
  if (select === undefined || select === null) return
  const option = [...select.options].find((one) => one.textContent === text)
  await act(async () => {
    select.value = option.value
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await settle()
}
await pickOption(rowNamed('默认标签页')?.querySelector('.pfset-select'), '指令')
check(
  '翻设置里「默认标签页」那一行：面板当场停到那一格',
  container.querySelector('#tab-notes')?.getAttribute('aria-selected') === 'true' && settingsDoc().defaultTab === 'notes',
  `选中的标签=${String(container.querySelector('.pf-tab[aria-selected="true"]')?.id)} ｜ 文档里 defaultTab=${String(settingsDoc().defaultTab)}`,
)
await pickOption(rowNamed('默认标签页')?.querySelector('.pfset-select'), '当前')

await act(async () => { tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const detailA = detailReadings(container)
check(
  '明细的组头按记录长出来',
  detailA.length > 0,
  detailA.map((group) => `${group.label}(${String(group.rows.length)})`).join('/'),
)
/* The detail pane is exactly the rows a reader clicks in for: nodes with a title in the record print
 * that title on their row; and the pane opens with every group expanded — folding is the reader's move. */
const titledRows = detailA.flatMap((group) => group.rows).filter((row) => project.nodeById[row.id]?.title !== undefined)
check(
  '明细每一行印的是记录里那段标题',
  titledRows.length > 0 && titledRows.every((row) => row.name === project.nodeById[row.id]?.title),
  `带标题的行=${String(titledRows.length)} 头两行=${titledRows.slice(0, 2).map((row) => `${row.id.slice(0, 8)}=${row.name.slice(0, 20)}`).join(' ｜ ')}`,
)
check(
  '明细打开就是摊开的：在册的每一组都不折',
  detailA.length > 0
    && detailA.every((group) => group.folded === false)
    && [...container.querySelectorAll('#pane-detail .pf-rowhead')].every((head) => head.getAttribute('aria-expanded') === 'true'),
  `组=${detailA.map((group) => `${group.label}${group.folded ? '（折着）' : '（摊开）'}`).join('/')}`,
)
/* Folding stays in the reader's hands: one press on a group head folds it and reports its row count at the right; another press unfolds. */
const doneWord = t('state.done')
const completedRowsWant = detailA.find((group) => group.label === doneWord)?.rows.length ?? 0
const completedHead = [...container.querySelectorAll('#pane-detail .pf-rowhead')]
  .find((head) => head.querySelector('.pf-rowhead-key')?.textContent === doneWord)
await act(async () => { completedHead?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await settle()
const afterFold = detailReadings(container)
const foldedFigs = (completedHead?.querySelector('.pf-rowcount')?.textContent ?? '').replace(/\s+/gu, '')
await act(async () => { completedHead?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await settle()
const afterReopen = detailReadings(container)
const shapeOf = (groups) => groups.map((group) => `${group.label}${group.folded ? '（折着）' : '（摊开）'}`).join('/')
check(
  '按一下组头那一组收起来、组头右边报出它有几格；再按一下又摊开',
  completedHead !== undefined
    && afterFold.every((group) => (group.label === doneWord ? group.folded : group.folded === false))
    && foldedFigs === `${String(completedRowsWant)}格`
    && afterReopen.every((group) => group.folded === false),
  `折后=${shapeOf(afterFold)} 那个数=${foldedFigs.length > 0 ? foldedFigs : '（没有）'} 再按后=${shapeOf(afterReopen)}`,
)

await act(async () => { tabs[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const wantGroups = expectedNoteGroups(project, false)
const shownGroups = [...container.querySelectorAll('#pane-notes .pf-sec')].map((section) => ({
  label: section.querySelector('.pf-rowhead-key')?.textContent ?? '',
  rows: [...section.querySelectorAll('.pf-ins')].map((row) => row.querySelector('.pf-ins-text')?.textContent ?? ''),
}))
check(
  '指令那一格按范围分组：组头与组内那几条逐项等于记录现算的',
  JSON.stringify(shownGroups) === JSON.stringify(wantGroups),
  `记录现算=${JSON.stringify(wantGroups)} ｜ 面板上=${JSON.stringify(shownGroups)}`,
)
const before = JSON.parse(readFileSync(join(record, 'instructions.json'), 'utf8')).instructions
const live = before.find((entry) => entry.state === 'live')
check('记录里有一条生效中的指令可以动', live !== undefined, `id=${String(live?.id)}`)
if (live !== undefined) {
  const notes = () => container.querySelector('#pane-notes')
  const rowOf = () => [...container.querySelectorAll('#pane-notes .pf-ins')]
    .find((item) => (item.querySelector('.pf-ins-text')?.textContent ?? '') === live.text)
  const buttonOf = (scope, label) => scope === undefined
    ? undefined
    : [...scope.querySelectorAll('.pf-mini, .pf-btn')].find((button) => button.textContent === label)
  const click = async (element) => {
    await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await settle()
  }

  /* The archive action is pressed from the panel's own button: the write face runs from UI all the way to the tool, then reads back. */
  const archiveKey = buttonOf(rowOf(), '归档')
  check('指令那一行上有归档这一枚', archiveKey !== undefined, live.text.slice(0, 24))
  if (archiveKey !== undefined) await click(archiveKey)
  const archived = JSON.parse(readFileSync(join(record, 'instructions.json'), 'utf8')).instructions.find((entry) => entry.id === live.id)
  check('归档：记录里确实是 withdrawn', archived?.state === 'withdrawn', `state=${String(archived?.state)}`)
  check(
    '归档之后默认不在页面上：设置里那一行是关着的',
    (notes()?.textContent ?? '').includes(live.text) === false && settingsDoc().showArchived !== true,
    `notes 上找得到那一行=${String((notes()?.textContent ?? '').includes(live.text))} ｜ 文档里 showArchived=${String(settingsDoc().showArchived)}`,
  )

  /* Flip "show archived instructions" on: archived entries return to their groups, and the row's action becomes "Revive". */
  await flipSwitch('指令里显示已归档的')
  check(
    '翻设置里「指令里显示已归档的」：已归档的当场回到页面上，右边那枚是复原',
    (notes()?.textContent ?? '').includes(live.text) === true
      && (rowOf()?.textContent ?? '').includes('已归档')
      && buttonOf(rowOf(), '复原') !== undefined
      && settingsDoc().showArchived === true,
    `那一行=${(rowOf()?.textContent ?? '（没有这一行）').slice(0, 48)} ｜ 文档里 showArchived=${String(settingsDoc().showArchived)}`,
  )

  /* Revive is pressed from the UI too: the row now carries "Revive". */
  const reviveKey = buttonOf(rowOf(), '复原')
  check('归档之后那一行摆的是复原', reviveKey !== undefined, '复原')
  if (reviveKey !== undefined) await click(reviveKey)
  const revived = JSON.parse(readFileSync(join(record, 'instructions.json'), 'utf8')).instructions.find((entry) => entry.id === live.id)
  check('复原：它又回到 live', revived?.state === 'live', `state=${String(revived?.state)}`)
  check('复原之后面板上不再标已归档', (notes()?.textContent ?? '').includes('已归档') === false, '那一行回到了生效那一堆')
  /* Flip the row back off at the end: the later readings return to this pass's starting tier. */
  await flipSwitch('指令里显示已归档的')
  check(
    '翻回关上：归档的收起来，文档里那一格也回到关着',
    settingsDoc().showArchived === false && (notes()?.textContent ?? '').includes('已归档') === false,
    `文档里 showArchived=${String(settingsDoc().showArchived)}`,
  )

  /* Delete: the original text is shown first; the second press does the deed. */
  const deleteKey = buttonOf(rowOf(), '删除')
  check('指令那一行上有删除这一枚', deleteKey !== undefined, '删除')
  if (deleteKey !== undefined) {
    await act(async () => { deleteKey.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    const said = container.querySelector('.pf-del-said')?.textContent ?? ''
    check('删除前先把那条原话摆出来', said === live.text, `blockquote=${said.slice(0, 24)}`)
    const go = buttonOf(container.querySelector('.pf-modal-acts'), '删除')
    check('确认框里那一枚删除在', go !== undefined, '第二下')
    if (go !== undefined) await click(go)
  }
  const gone = JSON.parse(readFileSync(join(record, 'instructions.json'), 'utf8')).instructions.find((entry) => entry.id === live.id)
  check('删除：条目连着正文一起走了', gone === undefined, `gone=${String(gone === undefined)}`)
  check('删掉的那条不再出现在面板上', (notes()?.textContent ?? '').includes(live.text) === false, 'notes 上找不到了')
  const restore = await gateway.reviveInstruction(sessionId, '', live.id)
  check('删除之后复原拿不回来', restore.ok === false, `revive=${outcomeText(restore).split('\n')[0].slice(0, 60)}`)
}

/* Add a note: write one sentence through this row — panel → host → tool → record, read back onto
   the page. The global scope is picked: this check is about the path working; scope-to-cycle
   binding has its own check. */
const said = '先看一眼记录再动手 & 别猜'
const addRow = container.querySelector('#pane-notes .pf-add')
check(
  '指令那一格最上头摆着「记下一条」那一行：范围那一枚、原话那个框、添加那一枚',
  addRow !== null
    && addRow.querySelector('select')?.getAttribute('aria-label') === '这句话管到哪儿'
    && addRow.querySelector('input')?.getAttribute('placeholder') === '原话照抄'
    && [...addRow.querySelectorAll('.pf-btn')].some((button) => button.textContent === '添加'),
  addRow === null ? '没有这一行' : `范围=${String(addRow.querySelector('select')?.value)} 占位=${String(addRow.querySelector('input')?.getAttribute('placeholder'))}`,
)
if (addRow !== null) {
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  const field = addRow.querySelector('input')
  await act(async () => {
    setValue.call(field, said)
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  const go = [...addRow.querySelectorAll('.pf-btn')].find((button) => button.textContent === '添加')
  if (go !== undefined) {
    await act(async () => { go.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await settle()
  }
  const added = JSON.parse(readFileSync(join(record, 'instructions.json'), 'utf8')).instructions.find((entry) => entry.text === said)
  check(
    '添加：记录里多出这一句，说的是全局、当场生效',
    added !== undefined && added.scope === 'global' && added.state === 'live',
    `id=${String(added?.id)} scope=${String(added?.scope)} state=${String(added?.state)} ｜ 面板上那句话=${[...container.querySelectorAll('.pf-innone')].map((one) => one.textContent).join(' ｜ ')}`,
  )
  check(
    '添加：那一句回到页面上，框里的原话收走了',
    field.value === '' && (container.querySelector('#pane-notes')?.textContent ?? '').includes(said),
    `框里=${field.value} ｜ 页面上找得到=${String((container.querySelector('#pane-notes')?.textContent ?? '').includes(said))}`,
  )
}

/* Policy numbers: change one through the line-settings modal and the readings follow. */
const cycles = JSON.parse(readFileSync(join(record, 'state.json'), 'utf8')).cycles
const line = cycles[0]
check('记录里有一条线可以写策略', line !== undefined, `id=${String(line?.id)}`)
if (line !== undefined) {
  await act(async () => { tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  const settingsKey = [...container.querySelectorAll('#pane-detail .pf-lineitem')]
    .flatMap((item) => [...item.querySelectorAll('.pf-mini')])
    .find((button) => button.textContent === '设置')
  check('明细那一行上有设置这一枚', settingsKey !== undefined, '设置')
  if (settingsKey !== undefined) {
    await act(async () => { settingsKey.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    const fields = () => [...container.querySelectorAll('.pf-setrow .pf-numin')]
    check('模态里三个数摆出来了', container.querySelectorAll('.pf-setrow').length === 3 && fields().length === 3, `rows=${String(container.querySelectorAll('.pf-setrow').length)}`)
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    /* Each of the three policy numbers is written once: three rows in the same modal, same endpoint,
     * the cost being three Enters. The reading lands on the **record file** (the three keys in
     * `state.json`); what the panel reads back on its own does not count. */
    const targets = [['parallel', 5], ['test_seconds_limit', 900], ['issue_pool_weight_limit', 7]]
    const wrote = []
    for (const [index, [key, target]] of targets.entries()) {
      const field = fields()[index]
      await act(async () => {
        field.focus()
        setValue.call(field, String(target))
        field.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      /* Blur or Enter both commit the field; this goes the Enter route. */
      await act(async () => {
        field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      await settle()
      const stored = JSON.parse(readFileSync(join(record, 'state.json'), 'utf8')).cycles.find((entry) => entry.id === line.id)
      wrote.push(`${key} 要 ${String(target)} → 记录里 ${String(stored?.policies?.[key])}`)
      check(`策略「${key}」：记录里确实是写进去那个值`, stored?.policies?.[key] === target, `${key}=${String(stored?.policies?.[key])}`)
      check(`策略「${key}」：框里跟着读数换成新的那个`, fields()[index]?.value === String(target), `value=${String(fields()[index]?.value)}`)
    }
    lines.push(`      三个策略数各写一次：${wrote.join(' ｜ ')}`)
  }
}

/* ---- 4b. The wires pane: layer/node/edge counts come from the record; zoom and isolate really move ----
 * This record has only a dozen-odd nodes, so this section covers "readings correct, views respond";
 * the three-digit scale has its own probe pass (the node catalog's `temp/`). */

const click = async (element) => {
  await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
}
const clickTimes = async (element, times) => {
  for (let round = 0; round < times; round += 1) {
    await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: round + 1 })) })
  }
  await settle()
}
const zoomKey = (pane, label) => [...(pane?.querySelectorAll('.pf-zbtn') ?? [])]
  .find((button) => button.getAttribute('aria-label') === label)

/** Before this section starts: how often the write face was called, and what the record looked like. */
const writesBefore = writeCalls.length
const recordBefore = recordDigest()

await act(async () => { tabs[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await settle()
const wiresPane = container.querySelector('#pane-wires')
const markCount = wiresPane?.querySelectorAll('.pf-node').length ?? 0
const wireCount = wiresPane?.querySelectorAll('.pf-edge').length ?? 0
const figsNow = (wiresPane?.querySelector('.pf-figs')?.textContent ?? '').replace(/\s+/gu, ' ').trim()
const figsWant = `${String(project.graph.layers.length)} 列 · ${String(project.nodes.length)} 节点 · ${String(project.graph.edges.length)} 边`
check(
  '依赖那一格：记号、连线、顶栏那三个数与记录现算的逐项对上',
  markCount === project.nodes.length && wireCount === project.graph.edges.length && figsNow === figsWant,
  `记录现算 ${figsWant} ｜ 面板上 ${figsNow}，记号 ${String(markCount)}，连线 ${String(wireCount)}`,
)

const shortOf = (node) => (node.title ?? (node.id.length > 8 ? node.id.slice(0, 8) : node.id))
await click(zoomKey(wiresPane, '放大'))
await click(zoomKey(wiresPane, '放大'))
const cardsNow = [...(wiresPane?.querySelectorAll('.pf-zcard') ?? [])]
const cardNames = cardsNow.map((card) => card.querySelector('.pf-ztitle')?.textContent ?? '').sort()
const namesWant = project.nodes.map(shortOf).sort()
check(
  '依赖那一格：放大到有名字那一档，一格一张卡，卡上的名字就是记录里那个标题',
  JSON.stringify(cardNames) === JSON.stringify(namesWant) && cardsNow.length === project.nodes.length,
  `记录里 ${String(namesWant.length)} 个名字 ｜ 面板上 ${String(cardNames.length)} 张卡，头三个 ${cardNames.slice(0, 3).join(' / ')}`,
)

await click(zoomKey(wiresPane, '放大'))
const fullCards = [...(wiresPane?.querySelectorAll('.pf-zcard.is-full') ?? [])]

/* Isolate: double-click a card, leaving only itself, what it owes, and what owes it. */
const hub = project.graph.edges[0]?.from
const litWant = hub === undefined ? [] : [
  hub,
  ...(project.nodeById[hub]?.dependencies ?? []).filter((id) => project.nodeById[id] !== undefined),
  ...project.graph.edges.filter((edge) => edge.from === hub).map((edge) => edge.to),
].sort()
const cardAt = (id) => fullCards.find((card) => card.getAttribute('data-id') === id)
if (hub !== undefined) await clickTimes(cardAt(hub), 2)
const cutIds = [...(wiresPane?.querySelectorAll('.pf-zcard') ?? [])].map((card) => card.getAttribute('data-id')).sort()
const cutKey = zoomKey(wiresPane, '回到全图')
check(
  '依赖那一格：双击把那一条圈出来，只留它自己、它欠的、欠它的',
  hub !== undefined && JSON.stringify(cutIds) === JSON.stringify(litWant),
  `这一圈 ${String(litWant.length)} 格（${litWant.map((id) => id.slice(0, 8)).join(',')}）｜ 面板上 ${String(cutIds.length)} 格`,
)
check('抠出来看时那枚叉露出来了', cutKey !== undefined && cutKey.hidden === false, `hidden=${String(cutKey?.hidden)}`)
if (cutKey !== undefined) await click(cutKey)
check(
  '回到全图，整张图回来',
  (wiresPane?.querySelectorAll('.pf-zcard').length ?? 0) === project.nodes.length,
  `卡片 ${String(wiresPane?.querySelectorAll('.pf-zcard').length ?? 0)} 张`,
)

/* ---- 4c. The issue pane: register rows, whether the weight bar draws, and the built-in master-detail ---- */

await act(async () => { tabs[4].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await settle()
const issuePane = container.querySelector('#pane-issue')
const openGroup = project.pool.groups.find((group) => group.key === 'open')
const openIds = (openGroup?.entries ?? []).map((entry) => entry.id)
const poolRows = [...(issuePane?.querySelectorAll('button.pf-row[data-issue]') ?? [])]
check(
  '问题那一格：开在未解决上，登记簿的行就是记录里未解决的那几条',
  JSON.stringify(poolRows.map((row) => row.getAttribute('data-issue'))) === JSON.stringify(openIds),
  `记录里未解决 ${String(openIds.length)} 条 ｜ 面板上 ${String(poolRows.length)} 行`,
)
check(
  '问题那一格：记录里没有重量表与策略线，重量条不画',
  project.pool.weights === null && project.pool.line === null && issuePane?.querySelector('.pf-gauge') === null,
  `weights=${JSON.stringify(project.pool.weights)} line=${String(project.pool.line)} ｜ 重量条=${issuePane?.querySelector('.pf-gauge') === null ? '没有' : '画出来了'}`,
)

const caseId = () => issuePane?.querySelector('#case .pf-case-id')?.textContent ?? ''
check(
  '问题那一格自带主从：一案那一栏先摆第一条',
  openIds.length === 0 || caseId() === openIds[0],
  `第一条=${String(openIds[0])} ｜ 一案上=${caseId()}`,
)
if (openIds.length > 1) {
  await click(poolRows[1])
  check(
    '问题那一格：换一条，一案跟着换',
    caseId() === openIds[1] && poolRows[1].getAttribute('aria-current') === 'true',
    `点到 ${String(openIds[1])} ｜ 一案上=${caseId()} aria-current=${String(poolRows[1].getAttribute('aria-current'))}`,
  )
}
const fullKey = [...(issuePane?.querySelectorAll('.pf-segbtn') ?? [])].find((button) => button.textContent === '完整')
if (fullKey !== undefined) await click(fullKey)
check(
  '问题那一格：「完整」那一档落在面板自己的偏好里，不碰记录',
  fullKey !== undefined && fullKey.getAttribute('aria-pressed') === 'true'
    && settingsDoc().showOtherStates === true,
  `aria-pressed=${String(fullKey?.getAttribute('aria-pressed'))} 设置文档里=${String(settingsDoc().showOtherStates)}`,
)
/* The reverse direction: the previous section measured "panel → document"; this one flips the
   settings row to measure "document → panel" — flipping off returns the row to "lean" at once and
   withdraws the non-open rows from the register. */
const issueRowIds = () => [...(issuePane?.querySelectorAll('button.pf-row[data-issue]') ?? [])]
  .map((row) => row.getAttribute('data-issue'))
const segPressed = (label) => [...(issuePane?.querySelectorAll('.pf-segbtn') ?? [])]
  .find((button) => button.textContent === label)?.getAttribute('aria-pressed')
await flipSwitch('问题池里显示未解决之外的')
check(
  '翻设置里「问题池里显示未解决之外的」到关：面板当场回到「精简」，未解决之外的行退出去',
  segPressed('精简') === 'true' && segPressed('完整') === 'false'
    && settingsDoc().showOtherStates === false
    && JSON.stringify(issueRowIds()) === JSON.stringify(openIds),
  `面板上那一档=精简(${String(segPressed('精简'))}) 完整(${String(segPressed('完整'))}) ｜ 文档里 showOtherStates=${String(settingsDoc().showOtherStates)} ｜ 行=${JSON.stringify(issueRowIds())}`,
)
/* Flip back on: the non-open groups fold into piles per the register's existing design (the design
   rule "folding never shifts layout"). Whether a pile is open follows pool.tsx's foldOf: first
   check for a manual click (the folds table, component state — tier flips do not reset it), then
   whether the selection fell in that pile, which auto-expands; the selection's source follows the
   fallback clause: the first open row, or when cleared, the first of the three laid-down piles in
   acknowledged → resolved → rejected order. This fixture is live data and the open set will
   eventually empty, so expectations must not assume "the full tier defaults to all folded" —
   open/closed, row sets and counts are all computed from project.pool. */
const stackedGroups = project.pool.groups.filter((group) => group.key !== 'open')
const foldButtons = () => [...(issuePane?.querySelectorAll('.pf-register .pf-fold') ?? [])]
const foldReadings = () => foldButtons().map((button) => [
  button.getAttribute('aria-expanded'),
  (button.textContent ?? '').replace(/\s+/gu, ' ').trim(),
])
const headLabels = () => [...(issuePane?.querySelectorAll('.pf-register .pf-head-label') ?? [])]
  .map((node) => node.textContent ?? '')
await flipSwitch('问题池里显示未解决之外的')
/* Which pile the selection falls in right now (pool.tsx's fallback: the first open row; only when cleared do the three laid-down piles get their turn). */
const pickedGroupKey = (openGroup?.entries.length ?? 0) > 0
  ? 'open'
  : settingsDoc().showOtherStates !== true
    ? null
    : ['acknowledged', 'resolved', 'rejected']
      .map((key) => stackedGroups.find((group) => group.key === key))
      .find((group) => (group?.entries.length ?? 0) > 0)?.key ?? null
/** Should a pile be open right now: folds is the fixture's record of manual clicks on the component's behalf (one click flips it; tier flips leave it alone). */
const foldIsOpen = (folds, group) => folds[group.key] ?? (pickedGroupKey !== null && pickedGroupKey === group.key)
const expectedFoldReadings = (folds) => stackedGroups.map((group) => (foldIsOpen(folds, group)
  ? ['true', '收起']
  : ['false', `展开其余 ${String(group.entries.length)} 条`]))
const expectedRowIds = (folds) => project.pool.groups.flatMap((group) => (
  group.key === 'open' || foldIsOpen(folds, group) ? group.entries.map((entry) => entry.id) : []
))
check(
  '翻回开：折堆头回到登记簿（组名在、每堆一枚展开钮标着条数），选中落入的那堆自动展开、其余折着',
  segPressed('完整') === 'true' && settingsDoc().showOtherStates === true
    && stackedGroups.length > 0
    && JSON.stringify(issueRowIds()) === JSON.stringify(expectedRowIds({}))
    && JSON.stringify(headLabels()) === JSON.stringify(project.pool.groups.map((group) => issueWord(t, group.key)))
    && JSON.stringify(foldReadings()) === JSON.stringify(expectedFoldReadings({})),
  `面板上那一档=完整(${String(segPressed('完整'))}) ｜ 文档里 showOtherStates=${String(settingsDoc().showOtherStates)} ｜ 选中落在=${String(pickedGroupKey ?? '（无处）')} ｜ 行数=${String(issueRowIds().length)}（契约现算 ${String(expectedRowIds({}).length)} 条） ｜ 展开钮=${JSON.stringify(foldReadings())}（记录里非 open 的堆：${stackedGroups.map((group) => `${issueWord(t, group.key)} ${String(group.entries.length)} 条`).join('、') || '（没有）'}）`,
)
/* Click one pile's fold button: that pile flips to the opposite of its previous state, with the row
   set and each pile's openness following the contract. When open rows exist that pile starts
   folded, so this click "opens" it; when the open set is clear and the selection fell into a
   laid-down pile, this click "closes" it — both shapes go through the same derivation, neither is
   skipped. Flipping off then withdraws the piles entirely — the expanded one included. */
if (foldButtons()[0] !== undefined) {
  const clickedGroup = stackedGroups[0]
  const foldsAfterClick = { [clickedGroup.key]: !foldIsOpen({}, clickedGroup) }
  await click(foldButtons()[0])
  check(
    '点其中一堆的折堆钮：这一堆翻到相反的一面（该组行集合跟着开合现出或收起，身份从记录那一堆来），别的堆不受牵连',
    JSON.stringify(issueRowIds()) === JSON.stringify(expectedRowIds(foldsAfterClick))
      && JSON.stringify(foldReadings()) === JSON.stringify(expectedFoldReadings(foldsAfterClick)),
    `行数=${String(issueRowIds().length)}（未解决 ${String(openIds.length)} ＋ ${issueWord(t, clickedGroup.key)} ${String(clickedGroup.entries.length)}${foldIsOpen(foldsAfterClick, clickedGroup) ? '，这一堆现出' : '，这一堆收起'}） ｜ 展开钮=${JSON.stringify(foldReadings())}`,
  )
  await flipSwitch('问题池里显示未解决之外的')
  check(
    '翻到关：堆整个退出去——展开钮一枚不剩（展开中的那堆也在内），那一档停在「精简」',
    segPressed('精简') === 'true' && segPressed('完整') === 'false'
      && settingsDoc().showOtherStates === false
      && foldButtons().length === 0
      && JSON.stringify(issueRowIds()) === JSON.stringify(openIds),
    `面板上那一档=精简(${String(segPressed('精简'))}) ｜ 展开钮剩 ${String(foldButtons().length)} 枚 ｜ 行数=${String(issueRowIds().length)}（未解决 ${String(openIds.length)} 条）`,
  )
  /* Restore at the end: flip back to "full" and flip the clicked pile back — the panel returns to
     how it looked entering this section. Fold state survives tier flips (folds is component state,
     tier flips do not reset it) and that is exactly what the restore depends on, so it is pinned
     here: openness and row sets after the restore are recomputed from the same folds table — in
     this fixture that means every pile at aria-expanded=false, all folded; in the emptied-open-set
     shape, the selected pile returns to open per the contract. */
  await flipSwitch('问题池里显示未解决之外的')
  if (foldButtons()[0] !== undefined) await click(foldButtons()[0])
  const foldsAfterRestore = { ...foldsAfterClick, [clickedGroup.key]: !foldIsOpen(foldsAfterClick, clickedGroup) }
  check(
    '收尾还原：翻回「完整」再把点过的那堆翻回去，面板回到进这一节时的样子（折叠跨翻档保留，开合与行集合照契约现算）',
    segPressed('完整') === 'true' && settingsDoc().showOtherStates === true
      && JSON.stringify(issueRowIds()) === JSON.stringify(expectedRowIds(foldsAfterRestore))
      && JSON.stringify(foldReadings()) === JSON.stringify(expectedFoldReadings(foldsAfterRestore)),
    `面板上那一档=完整(${String(segPressed('完整'))}) ｜ 行数=${String(issueRowIds().length)}（契约现算 ${String(expectedRowIds(foldsAfterRestore).length)} 条） ｜ 展开钮=${JSON.stringify(foldReadings())}（契约现算 ${JSON.stringify(expectedFoldReadings(foldsAfterRestore))}）`,
  )
}
check(
  '两个看法都不落笔：点过一遍，写面一次都没被叫过，记录一个字节没动',
  writeCalls.length === writesBefore && recordDigest() === recordBefore,
  `写面调用 ${String(writeCalls.length - writesBefore)} 次 ｜ 记录 ${recordDigest() === recordBefore ? '一个字节没动' : '变了'}`,
)

/* ---- 4d. The settings pane: this workspace's own project settings, read here and edited here ----
 * Four rows, three control kinds, a layer tag at each row's end, per the blueprint. Readings on both
 * sides: what the panel shows, and the four lines the real tool prints against the same workspace.
 * Each edit writes back to this project's layer and is read again — the reading lands on the record
 * file (`workspace/.pf/config.json`); what the panel reads back on its own does not count.
 *
 * Two invalid-value cases: an out-of-range number (typed into the number box for real) and a tier
 * not in the option list (a forged option injected into the dropdown, then picked). Both must land
 * on "record keeps its original value, UI returns to it".
 */

const { parseConfigList } = await import(pathToFileURL(join(root, 'src', 'host', 'project-config.ts')).href)
const listed = await runPf(hostCtx, workspace, ['config', 'list'], new AbortController().signal)
/* A run's outcome carries the tool's output on success and a code-plus-detail refusal otherwise: only
 * the success branch has a text stream to parse. */
const truth = parseConfigList(listed.ok ? listed.text : '')
/** The record's three layer names as the panel's three words (the blueprint's wording). */
const LAYER_WORD = { default: '默认', project: '本项目', global: '全局' }
check(
  '设置那一格：真工具对着这份工作区印得出四行设置',
  listed.ok && Object.keys(truth).length === 4,
  listed.ok
    ? listed.text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join(' ｜ ')
    : outcomeText(listed),
)

const storedConfig = () => JSON.parse(readFileSync(join(record, 'config.json'), 'utf8'))
const configReadings = (scope) => [...(scope?.querySelectorAll('#pane-config .pf-setrow') ?? [])].map((row) => {
  const pick = row.querySelector('select')
  const box = row.querySelector('input')
  const pressed = [...row.querySelectorAll('.pf-segbtn')].find((button) => button.getAttribute('aria-pressed') === 'true')
  return {
    key: row.getAttribute('data-key'),
    name: row.querySelector('.pf-setlabel')?.textContent ?? '',
    value: pick !== null ? pick.value : box !== null ? box.value : pressed?.textContent === '开' ? 'on' : pressed === undefined ? '（未设置）' : 'off',
    layer: row.querySelector('.pf-vlayer')?.textContent ?? '（没有层签）',
  }
})

await act(async () => { tabs[5].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await settle()
const configPane = container.querySelector('#pane-config')
const shownFirst = configReadings(container)
const wantedFirst = ['worktree_mode', 'test_tier', 'max_agents', 'issue_repair'].map((key) => ({
  key,
  value: truth[key]?.value ?? '（工具没印这一行）',
  layer: truth[key] === undefined || truth[key].layer === null ? '（没有层签）' : LAYER_WORD[truth[key].layer],
}))
check(
  '设置那一格：四行的值与层签逐行与真工具印的那份对上',
  JSON.stringify(shownFirst.map((row) => [row.key, row.value, row.layer]))
    === JSON.stringify(wantedFirst.map((row) => [row.key, row.value, row.layer])),
  `工具那边：${wantedFirst.map((row) => `${row.key}=${row.value}(${row.layer})`).join(' ')} ｜ 面板这边：${shownFirst.map((row) => `${row.key}=${row.value}(${row.layer})`).join(' ')}`,
)
check(
  '设置那一格：四行、三种控件、四枚层签都在',
  shownFirst.length === 4
    && configPane?.querySelectorAll('select').length === 2
    && configPane?.querySelectorAll('input.pf-numin').length === 1
    && configPane?.querySelectorAll('.pf-seg').length === 1
    && configPane?.querySelectorAll('.pf-vlayer').length === 4,
  `行=${String(shownFirst.length)} 下拉=${String(configPane?.querySelectorAll('select').length)} 数字框=${String(configPane?.querySelectorAll('input.pf-numin').length)} 开-关=${String(configPane?.querySelectorAll('.pf-seg').length)} 层签=${String(configPane?.querySelectorAll('.pf-vlayer').length)} ｜ 名字=${shownFirst.map((row) => row.name).join('/')}`,
)

/* Each row's control gets its own driver: dropdown and number box go through the **prototype
 * setter** (React remembers the last value on the node itself; assigning `element.value` directly
 * would read as unchanged), and the on-off toggle just needs a click. */
const rowIn = (scope, key) => [...(scope?.querySelectorAll('#pane-config .pf-setrow') ?? [])]
  .find((row) => row.getAttribute('data-key') === key)
const setSelect = async (row, value) => {
  const select = row.querySelector('select')
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  await act(async () => {
    setValue.call(select, value)
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await settle()
}
const typeNumber = async (row, value) => {
  const field = row.querySelector('input')
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    field.focus()
    setValue.call(field, String(value))
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => { field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await settle()
}
const pressToggle = async (row, word) => {
  const button = [...row.querySelectorAll('.pf-segbtn')].find((one) => one.textContent === word)
  await act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
}
const noteLine = () => [...container.querySelectorAll('.pf-innone')].map((node) => node.textContent ?? '').join(' | ')
const other = (list, current) => list.find((one) => one !== current) ?? current

const wrote = []
const worktreeRow = rowIn(container, 'worktree_mode')
const worktreeNext = other([...worktreeRow.querySelectorAll('option')].map((option) => option.value), worktreeRow.querySelector('select').value)
await setSelect(worktreeRow, worktreeNext)
wrote.push(`worktree_mode → ${worktreeNext}`)
check(
  'worktree 档改一次：记录里真的是那个值，面板上跟着换成它',
  storedConfig().worktree_mode === worktreeNext && rowIn(container, 'worktree_mode').querySelector('select').value === worktreeNext,
  `记录里=${String(storedConfig().worktree_mode)} 面板上=${rowIn(container, 'worktree_mode').querySelector('select').value}`,
)

const tierRow = rowIn(container, 'test_tier')
const tierNext = other([...tierRow.querySelectorAll('option')].map((option) => option.value), tierRow.querySelector('select').value)
await setSelect(tierRow, tierNext)
wrote.push(`test_tier → ${tierNext}`)
check(
  '测试档改一次：记录里真的是那个值，面板上跟着换成它',
  storedConfig().test_tier === tierNext && rowIn(container, 'test_tier').querySelector('select').value === tierNext,
  `记录里=${String(storedConfig().test_tier)} 面板上=${rowIn(container, 'test_tier').querySelector('select').value}`,
)

const agentRow = rowIn(container, 'max_agents')
const agentNext = String(Number(agentRow.querySelector('input').value) + 1)
await typeNumber(agentRow, agentNext)
wrote.push(`max_agents → ${agentNext}`)
check(
  '并行上限改一次：记录里真的是那个数，框里跟着换成它',
  storedConfig().max_agents === Number(agentNext) && rowIn(container, 'max_agents').querySelector('input').value === agentNext,
  `记录里=${String(storedConfig().max_agents)} 框里=${rowIn(container, 'max_agents').querySelector('input').value}`,
)

const issueRow = rowIn(container, 'issue_repair')
await pressToggle(issueRow, '关')
wrote.push('issue_repair → off')
check(
  'issue 开关改一次：记录里真的是那个值，面板上跟着换成它',
  storedConfig().issue_repair === 'off' && rowIn(container, 'issue_repair').querySelector('.pf-segbtn[aria-pressed="true"]')?.textContent === '关',
  `记录里=${String(storedConfig().issue_repair)} 面板上按下的是=${String(rowIn(container, 'issue_repair').querySelector('.pf-segbtn[aria-pressed="true"]')?.textContent)}`,
)
lines.push(`      设置那一格四行各改一次：${wrote.join(' ｜ ')}`)

/* After writing all four rows: all four values live in this project's layer, and the layer tags flip with their real home. */
const shownAfter = configReadings(container)
const configNow = storedConfig()
check(
  '写完这四行：层签四枚全读作「本项目」（写的永远是这一层），值与记录里那四个值一致',
  shownAfter.length === 4 && shownAfter.every((row) => row.layer === '本项目')
    && shownAfter.every((row) => row.value === String(configNow[row.key])),
  `层签=${shownAfter.map((row) => `${row.key}=${row.layer}`).join(' ')} ｜ 面板上=${JSON.stringify(shownAfter.map((row) => row.value))} ｜ 记录里=${JSON.stringify(configNow)}`,
)

/* Invalid value 1: out-of-range number. The record keeps its value, the box returns to it, and the tool's message lands on the panel's note line. */
/* The words on that line are the TOOL's own, not the panel's: the expectation is read out of the tool
 * itself (the same command, run for real) rather than pinned to one language's wording. */
const refusalWords = async (key, value) => {
  const outcome = await runPf(hostCtx, workspace, ['config', 'set', key, value], new AbortController().signal)
  return (outcome.ok ? outcome.text : (outcome.detail ?? '')).trim()
}
const numberRefusal = await refusalWords('max_agents', '0')
const beforeIllegal = storedConfig()
await typeNumber(rowIn(container, 'max_agents'), '0')
check(
  '越界数字不落记录：记录保持原值，框里回到原值，提示行摆的是工具那句话',
  numberRefusal.length > 0
    && storedConfig().max_agents === beforeIllegal.max_agents
    && rowIn(container, 'max_agents').querySelector('input').value === String(beforeIllegal.max_agents)
    && noteLine().includes(numberRefusal),
  `记的是 0 ｜ 记录里=${String(storedConfig().max_agents)} 框里=${rowIn(container, 'max_agents').querySelector('input').value} 提示行=${noteLine() === '' ? '（空）' : noteLine()} ｜ 工具那句=${numberRefusal}`,
)

/* Invalid value 2: a tier not in the option list. A forged option is injected into the dropdown and picked — impossible to do on the real panel. */
const tierRefusal = await refusalWords('test_tier', 'partial')
const forgedRow = rowIn(container, 'test_tier')
const forgedSelect = forgedRow.querySelector('select')
const forged = window.document.createElement('option')
forged.value = 'partial'
forged.textContent = 'partial'
forgedSelect.appendChild(forged)
await setSelect(forgedRow, 'partial')
forged.remove()
check(
  '非法档位不落记录：记录保持原值，下拉回到原值，提示行摆的是工具那句话',
  tierRefusal.length > 0
    && storedConfig().test_tier === beforeIllegal.test_tier
    && rowIn(container, 'test_tier').querySelector('select').value === beforeIllegal.test_tier
    && noteLine().includes(tierRefusal),
  `记的是 partial ｜ 记录里=${String(storedConfig().test_tier)} 下拉里=${rowIn(container, 'test_tier').querySelector('select').value} 提示行=${noteLine() === '' ? '（空）' : noteLine()} ｜ 工具那句=${tierRefusal}`,
)

/* The column's two grips: one per edge, dragging changes the column width, double-click restores the default. */
const wrap = configPane?.querySelector('.pf-configwrap')
const configWidth = () => wrap?.style.getPropertyValue('--pf-config-w') ?? ''
const grips = () => [...(configPane?.querySelectorAll('.pf-grip') ?? [])]
check(
  '那一列：默认 720，左右各一枚把手，标签与上下限都在',
  configWidth() === '720px' && grips().length === 2
    && grips()[0].getAttribute('data-side') === 'left' && grips()[1].getAttribute('data-side') === 'right'
    && grips()[0].getAttribute('aria-valuemin') === '480' && grips()[0].getAttribute('aria-valuemax') === '960',
  `宽度=${configWidth()} 把手=${grips().map((grip) => `${String(grip.getAttribute('data-side'))}/min=${String(grip.getAttribute('aria-valuemin'))}/max=${String(grip.getAttribute('aria-valuemax'))}`).join(' ')}`,
)
const arrow = async (grip, key, shift = false) => {
  await act(async () => {
    grip.dispatchEvent(new window.KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true }))
  })
}
await arrow(grips()[1], 'ArrowRight')
const afterStep = configWidth()
await arrow(grips()[1], 'ArrowRight', true)
const afterBig = configWidth()
await arrow(grips()[0], 'ArrowLeft')
const afterLeft = configWidth()
for (let round = 0; round < 20; round += 1) await arrow(grips()[1], 'ArrowRight')
const afterClamp = configWidth()
await act(async () => { grips()[1].dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })) })
check(
  '那一列的把手：一步 24、按住 shift 一步 48、左边那一枚往左推是放宽、拖到 960 就停、双击回 720',
  afterStep === '744px' && afterBig === '792px' && afterLeft === '816px'
    && afterClamp === '960px' && configWidth() === '720px',
  `默认 720px → 右一步 ${afterStep} → shift 一步 ${afterBig} → 左扳手往左 ${afterLeft} → 顶到头 ${afterClamp} → 双击 ${configWidth()}`,
)
/* A real drag: jsdom lacks the three pointer-capture methods, so stubs are patched in first (same measurement as the detail split). */
const dragged = grips()[1]
const configCaptured = new Set()
dragged.setPointerCapture = (id) => { configCaptured.add(id) }
dragged.hasPointerCapture = (id) => configCaptured.has(id)
dragged.releasePointerCapture = (id) => { configCaptured.delete(id) }
const configPointerAt = (type, clientX) => {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 0, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  return event
}
await act(async () => {
  dragged.dispatchEvent(configPointerAt('pointerdown', 100))
  dragged.dispatchEvent(configPointerAt('pointermove', 140))
})
const afterDrag = configWidth()
await act(async () => { dragged.dispatchEvent(configPointerAt('pointerup', 140)) })
check(
  '那一列真拖得动：右侧缘往右挪 40px，列宽 +80（两侧对称、中心不动）',
  afterDrag === '800px',
  `拖前 720px ｜ 指针挪 +40px 后列宽=${afterDrag}`,
)
await act(async () => { grips()[1].dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })) })

/* Reopen a panel (same record, same session): the four rows' readings still match the four values just written. */
const reopenHost = window.document.createElement('div')
window.document.body.appendChild(reopenHost)
const reopenRoot = createRoot(reopenHost)
await act(async () => {
  reopenRoot.render(React.createElement(panel.Panel, { port: trackedPort, sessionId, prefs: panel.prefs }))
})
await settle()
await act(async () => { reopenHost.querySelector('#tab-config')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await settle()
const reopened = configReadings(reopenHost)
const storedAfter = storedConfig()
check(
  '重开一份面板：设置那一格的四行与记录里那四个值还对得上',
  reopened.length === 4
    && reopened.every((row) => row.value === String(storedAfter[row.key]))
    && reopened.every((row) => row.layer === '本项目'),
  `重开后面板上=${JSON.stringify(reopened.map((row) => `${row.key}=${row.value}`))} ｜ 记录里=${JSON.stringify(storedAfter)}`,
)
await act(async () => { reopenRoot.unmount() })
lines.push(`      设置那一格收尾时记录里那四个值：${JSON.stringify(storedAfter)}`)

/* ---- 5. The detail split: really present, really draggable, still there after reopening ---- */

await act(async () => { tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const grip = container.querySelector('#detail-split')
check('明细有那道可拖的缝', grip !== null, `aria-valuenow=${String(grip?.getAttribute('aria-valuenow'))}`)

/* Criterion 3's first clause is "draggable", so first ask whether the split is on screen at all:
 * the detail pane carries a min-height, and the moment it shows, `#frame` gains `is-fill`; if the
 * shipped rule still scoped to bare `.pf-grip`, filling would put the split itself under
 * `display: none` too — the split is only useful while detail is showing, so it would never show.
 * The computed value is read here. */
const splitShown = grip === null ? '（没有这道缝）' : window.getComputedStyle(grip).display
const splitWon = grip === null ? {} : winningDeclarations(grip, ['display'])
check(
  '明细那道缝真的显形：计算出来的 display 没被哪条规则收掉',
  grip !== null && splitShown !== 'none',
  `display="${splitShown}" ｜ 最后落在它身上的规则=${splitWon.display === undefined ? '（没有规则设 display）' : `display: ${splitWon.display}`}`,
)

/* Then a real drag: jsdom lacks the three pointer-capture methods, so the split gets stubs first,
 * then pointerdown → pointermove → pointerup. Readings land in two places — the split's
 * aria-valuenow and the settings document; a hand-written document does not count. */
const captured = new Set()
const widthBefore = Number.parseInt(grip?.getAttribute('aria-valuenow') ?? '', 10)
let widthDragged = widthBefore
if (grip !== null) {
  grip.setPointerCapture = (id) => { captured.add(id) }
  grip.hasPointerCapture = (id) => captured.has(id)
  grip.releasePointerCapture = (id) => { captured.delete(id) }
  const pointerAt = (type, clientX) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 0, button: 0 })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    return event
  }
  await act(async () => { grip.dispatchEvent(pointerAt('pointerdown', 200)) })
  await act(async () => { grip.dispatchEvent(pointerAt('pointermove', 240)) })
  widthDragged = Number.parseInt(grip.getAttribute('aria-valuenow') ?? '', 10)
  await act(async () => { grip.dispatchEvent(pointerAt('pointerup', 240)) })
  await settle()
}
const widthStored = settingsDoc().sideWidth
check(
  '真的拖一下：读数跟着指针走，松手之后宽度落进设置文档（本地存储一个键都不留）',
  widthDragged === widthBefore + 40 && widthStored === widthDragged
    && window.localStorage.getItem('dsh-pathfinder.sideWidth') === null,
  `拖前 ${String(widthBefore)} → 拖到 ${String(widthDragged)} ｜ 设置文档=${String(widthStored)} ｜ 本地存储=${String(window.localStorage.getItem('dsh-pathfinder.sideWidth'))}`,
)
await act(async () => { reactRoot.unmount() })
const again = createRoot(container)
await act(async () => { again.render(React.createElement(panel.Panel, { port: trackedPort, sessionId, prefs: panel.prefs })) })
await settle()
const gripAgain = container.querySelector('#detail-split')
check(
  '重开之后宽度还是拖出来那个',
  gripAgain?.getAttribute('aria-valuenow') === String(widthDragged),
  `aria-valuenow=${String(gripAgain?.getAttribute('aria-valuenow'))}（拖出来的是 ${String(widthDragged)}）`,
)
await act(async () => { again.unmount() })

/* ---- 6a-2. Rejected writes: controls must not silently bounce back; the section's existing note line must speak ----
 * The caller's revision is stale, the host refuses the write and returns a bare `false` (swallowing
 * the reason on its side), and the panel's several `void …write(…)` calls drop it. This check makes
 * the document refuse everything, then flips the switch once more: with both writes voided, the
 * note line (`.pfset-msg`) must carry a sentence.
 */

const failureLine = () => [...settingsHost.querySelectorAll('.pfset-msg')]
  .map((node) => node.textContent ?? '').join(' | ')
const switchState = () => rowNamed('指令里显示已归档的')?.querySelector('.pfset-switch')?.getAttribute('aria-checked')
const failureBefore = failureLine()
settingsForm.refuse(true)
await flipSwitch('指令里显示已归档的')
const failureAfter = failureLine()
check(
  '两笔都被拒时不静默：设置那一节现有的提示行上摆出一句话',
  failureAfter.includes('保存失败') && failureAfter !== failureBefore
    && settingsDoc().showArchived !== true && switchState() === 'false',
  `拒收前提示行=${failureBefore === '' ? '（空）' : failureBefore} ｜ 拒收后=${failureAfter === '' ? '（空）' : failureAfter} ｜ 文档里 showArchived=${String(settingsDoc().showArchived)}`,
)

/* The panel's own controls share the same write-back (`panel.tsx`'s `keep`): on refusal its
 * existing note line must speak too, and controls must not silently bounce back. The copy mounted
 * on `container` was unmounted earlier, so a fresh one is mounted here, still reading the same
 * settings form; the press lands on the genuinely visible switch (the labeled row), not the
 * off-stage control. */
const refuseHost = window.document.createElement('div')
window.document.body.appendChild(refuseHost)
const refuseRoot = createRoot(refuseHost)
await act(async () => {
  refuseRoot.render(React.createElement(panel.Panel, { port: trackedPort, sessionId, prefs: panel.prefs }))
})
await settle()
const tabBefore = settingsDoc().defaultTab
await act(async () => { refuseHost.querySelector('#tab-notes')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await settle()
/* The `.pf-innone` class also serves other empty-state captions, so the sentence is searched for rather than taken by index. */
const panelSaid = [...refuseHost.querySelectorAll('.pf-innone')]
  .map((node) => node.textContent ?? '')
  .find((text) => text.includes('保存失败')) ?? ''
check(
  '面板上那一枚开关被拒时，面板现有的提示行一样说得出来',
  panelSaid.includes('保存失败') && settingsDoc().defaultTab === tabBefore,
  `面板提示行=${panelSaid === '' ? '（空）' : panelSaid} ｜ 文档里 defaultTab 翻之前=${String(tabBefore)} 翻之后=${String(settingsDoc().defaultTab)}`,
)
await act(async () => { refuseRoot.unmount() })

settingsForm.refuse(false)
await flipSwitch('指令里显示已归档的')
const landed = settingsDoc().showArchived
await flipSwitch('指令里显示已归档的')
check(
  '下一笔写成：值落定、那句话跟着收回，收尾翻回关上',
  landed === true && settingsDoc().showArchived === false && failureLine().includes('保存失败') === false,
  `落定那一笔之后 showArchived=${String(landed)} ｜ 收尾=${String(settingsDoc().showArchived)} ｜ 提示行=${failureLine() === '' ? '（空）' : failureLine()}`,
)

/* ---- 6b. The same settings document mounted again: values survive, readings match ----
 * In real deployment "restarting a second instance" means another process re-reading the same
 * `$DSH_HOME` config. The farthest this fixture can go: take the previous document verbatim as the
 * next one's starting point and run `apply` again (new context, new roster, new settings gate),
 * then check the freshly mounted panel and settings page read those same values.
 */

const keptPrefs = { ...settingsDoc() }
check(
  '设置文档里那几个值都落着',
  typeof keptPrefs.sideWidth === 'number'
    && typeof keptPrefs.infoLevel === 'string'
    && typeof keptPrefs.defaultTab === 'string'
    && typeof keptPrefs.showOtherStates === 'boolean',
  JSON.stringify(keptPrefs),
)

const restarted = makeConfigForms({ [client.SETTINGS_NAMESPACE]: keptPrefs })
const second = bootClient(restarted, {})
const secondSection = second.ledger.get(`${client.SECTION_SLOT}:${client.SETTINGS_NAMESPACE}`)
check(
  '第二个实例里设置那一节照样注册上',
  secondSection !== undefined && second.ledger.size === SEAT_ENTRIES.length,
  `注册=${[...second.ledger.keys()].join(', ') || '（一个都没有）'}`,
)

const restartRoot = createRoot(container)
await act(async () => {
  restartRoot.render(React.createElement(second.panel.Panel, {
    port: trackedPort, sessionId, prefs: second.panel.prefs,
  }))
})
await settle()

const restartedTab = container.querySelector('.pf-tab[aria-selected="true"]')?.id
const restartedSeg = [...container.querySelectorAll('#pane-now .pf-modes .pf-segbtn')]
  .find((button) => button.getAttribute('aria-pressed') === 'true')?.textContent
const restartedWidth = container.querySelector('#detail-split')?.getAttribute('aria-valuenow')
const restartedFull = [...container.querySelectorAll('#pane-issue .pf-segbtn')]
  .find((button) => button.getAttribute('aria-pressed') === 'true')?.textContent
const infoWord = { lean: '精简', three: '展开', full: '铺满' }[keptPrefs.infoLevel]
check(
  '第二个实例照同一份文档开：标签页、信息量、侧栏宽度、问题池那一档都对上',
  restartedTab === `tab-${String(keptPrefs.defaultTab)}`
    && restartedSeg === infoWord
    && restartedWidth === String(keptPrefs.sideWidth)
    && restartedFull === (keptPrefs.showOtherStates === true ? '完整' : '精简'),
  `文档=${JSON.stringify(keptPrefs)} ｜ 面板上 标签=${String(restartedTab)} 信息量=${String(restartedSeg)} 宽度=${String(restartedWidth)} 问题池=${String(restartedFull)}`,
)

const secondHost = window.document.createElement('div')
window.document.body.appendChild(secondHost)
const secondSettingsRoot = createRoot(secondHost)
await act(async () => {
  secondSettingsRoot.render(React.createElement(secondSection.component, secondSection.options.inject()))
})
await settle()
const secondRow = (label) => [...secondHost.querySelectorAll('.pfset-row')]
  .find((row) => row.querySelector('.pfset-label')?.textContent === label)
const secondSwitch = (label) => secondRow(label)?.querySelector('.pfset-switch')?.getAttribute('aria-checked')
check(
  '第二个实例的设置页摆的还是文档里那几个值',
  secondRow('默认标签页')?.querySelector('.pfset-select')?.value === keptPrefs.defaultTab
    && secondSwitch('指令里显示已归档的') === String(keptPrefs.showArchived === true)
    && secondSwitch('问题池里显示未解决之外的') === String(keptPrefs.showOtherStates),
  `下拉=${String(secondRow('默认标签页')?.querySelector('.pfset-select')?.value)} 已归档=${String(secondSwitch('指令里显示已归档的'))} 未解决之外=${String(secondSwitch('问题池里显示未解决之外的'))}`,
)

/* ---- 6c. Browser localStorage: not one panel-owned key ------------------- */

const localKeys = []
try {
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index)
    if (key !== null) localKeys.push(key)
  }
} catch (error) {
  /* Unreadable means empty: this check asks "any panel-owned keys?", and unreadable has none either way. */
}
const mine = localKeys.filter((key) => key.startsWith('dsh-pathfinder.'))
const seededLeft = localKeys.filter((key) => LEGACY_SEEDED.includes(key)).length
check(
  '浏览器本地存储里面板自己的键一个都没有',
  mine.length === 0,
  `本地存储 ${String(localKeys.length)} 个键${localKeys.length === 0 ? '' : `：${localKeys.join(', ')}`} ｜ 面板自己的 ${String(mine.length)} 个 ｜ 夹具先塞的 ${String(LEGACY_SEEDED.length)} 个旧键剩 ${String(seededLeft)} 个`,
)

/* ---- 6d. The unload pass: after stopping the plugin, nothing left in either place ----
 * Boot the plugin again (new roster, new target, its own effects), render both seats through the
 * real code — the two stylesheets attach via the render path — then dispose all of its effects:
 * the roster empties and both style tags come off the document cleanly.
 *
 * The cleanup order (deregister first, then strip styles) lives in `mount.ts`'s cleanup section;
 * this and the unit tests measure only the end state — judgment 2 asks "nothing left", nothing
 * requires an order. */

const unload = { ledger: new Map(), calls: [], effects: [] }
const unloaded = bootClient(backend, {}, unload)
check(
  '卸载那一趟：三条都登记上了',
  unload.ledger.size === SEAT_ENTRIES.length,
  `名册=${[...unload.ledger.keys()].join(', ') || '（空）'}`,
)

const unloadHost = window.document.createElement('div')
window.document.body.appendChild(unloadHost)
const unloadRoot = createRoot(unloadHost)
await act(async () => {
  unloadRoot.render(React.createElement(unloaded.panel.Panel, {
    port: trackedPort, sessionId, prefs: unloaded.panel.prefs,
  }))
})
await settle()

const unloadSection = unload.ledger.get(`${client.SECTION_SLOT}:${client.SETTINGS_NAMESPACE}`)
const unloadSettingsHost = window.document.createElement('div')
window.document.body.appendChild(unloadSettingsHost)
const unloadSettingsRoot = createRoot(unloadSettingsHost)
await act(async () => {
  unloadSettingsRoot.render(React.createElement(unloadSection.component, unloadSection.options.inject()))
})
await settle()

const tagOf = (id) => window.document.getElementById(id)?.id ?? null
check(
  '卸载之前：两张注入的样式标签都在文档里',
  tagOf(client.PANEL_STYLE_ID) !== null && tagOf(client.SETTINGS_STYLE_ID) !== null,
  `面板那一张=${String(tagOf(client.PANEL_STYLE_ID))} 设置那一张=${String(tagOf(client.SETTINGS_STYLE_ID))}`,
)

await act(async () => {
  unloadRoot.unmount()
  unloadSettingsRoot.unmount()
})
for (const one of unload.effects) one.off()

check(
  '卸载之后：名册清空，两处都没有残留',
  unload.ledger.size === 0,
  `名册=${[...unload.ledger.keys()].join(', ') || '（空）'}`,
)
check(
  '卸载之后：两张注入的样式标签都摘干净了',
  tagOf(client.PANEL_STYLE_ID) === null && tagOf(client.SETTINGS_STYLE_ID) === null,
  `面板那一张=${String(tagOf(client.PANEL_STYLE_ID))} 设置那一张=${String(tagOf(client.SETTINGS_STYLE_ID))}`,
)

/* ---- 6e. The hot-reload pass: mount → unmount → mount again, positive readings at all three clear points ----
 * 6d measured the end state; this section puts a positive reading on each of the three clear points
 * ("sidebar item / central slot / the two injected style tags") and adds a hot-reload pass: after a
 * clean unmount, mount again and all three return to their original shape with no duplicate registration.
 *
 * The seats do not go through the real slots renderer (it lives inside the DSH shell); a minimal
 * renderer stands in, doing the one thing the real one does — draw whatever the roster holds now.
 * That gives "registration gone, nothing on screen" a reading. Both seats point at the empty
 * workspace's session: in that case the panel body carries that one sentence, so a successful draw
 * is one `.pf-page`. */

const CLEAR_POINTS = [
  { word: '侧栏项', key: `sidebar.panellist:${client.PANEL_ID}`, probe: (host) => host.querySelector('svg') },
  { word: '中央栏那一格', key: `main:${client.PANEL_ID}`, probe: (host) => host.querySelector('.pf-page') },
]

const hot = { ledger: new Map(), calls: [], effects: [] }
const hotBoot = bootClient(backend, {}, hot)
const hotBoardHost = window.document.createElement('div')
window.document.body.appendChild(hotBoardHost)
const hotBoardRoot = createRoot(hotBoardHost)
/** Draw whatever the roster holds now: a minimal stand-in for the real renderer's reading. */
const paintSeats = async () => {
  const seats = []
  for (const { key } of CLEAR_POINTS) {
    const entry = hot.ledger.get(key)
    if (entry === undefined) continue
    const given = typeof entry.options.inject === 'function' ? entry.options.inject() : {}
    /* The central slot's read gate is swapped for the fixture-tracked one: `settle()` can wait on it. */
    const port = given.port === undefined ? {} : { port: trackedPort }
    seats.push(React.createElement(entry.component, {
      ...given, ...port, size: 16, wide: true, useSessions: sessionsAt(emptySessionId),
    }))
  }
  await act(async () => { hotBoardRoot.render(React.createElement(React.Fragment, null, ...seats)) })
  await settle()
}
/** Both seats' current state: on the roster or not + drawn on screen or not, recorded per seat. */
const seatState = () => CLEAR_POINTS
  .map(({ word, key, probe }) => ({ word, registered: hot.ledger.has(key), drawn: probe(hotBoardHost) !== null }))
const seatReport = (state) => state.map(({ word, registered, drawn }) => `${word}=${registered ? '在册' : '不在册'}·${drawn ? '屏上有' : '屏上无'}`).join(' ')
const allSeats = (state, want) => state.every(({ registered, drawn }) => registered === want && drawn === want)
const styleReport = () => `面板那一张=${String(tagOf(client.PANEL_STYLE_ID))} 设置那一张=${String(tagOf(client.SETTINGS_STYLE_ID))}`
const stylesGone = () => tagOf(client.PANEL_STYLE_ID) === null && tagOf(client.SETTINGS_STYLE_ID) === null

let hotPanelHost = window.document.createElement('div')
window.document.body.appendChild(hotPanelHost)
let hotPanelRoot = createRoot(hotPanelHost)
let hotSectionHost = window.document.createElement('div')
window.document.body.appendChild(hotSectionHost)
let hotSectionRoot = createRoot(hotSectionHost)
/** Show once: the panel body (`Entry`, which attaches the two stylesheets on its path) and the settings page. */
const showPanel = async () => {
  const section = hot.ledger.get(`${client.SECTION_SLOT}:${client.SETTINGS_NAMESPACE}`)
  await act(async () => {
    hotPanelRoot.render(React.createElement(hotBoot.panel.Panel, { port: trackedPort, sessionId, prefs: hotBoot.panel.prefs }))
    hotSectionRoot.render(React.createElement(section.component, section.options.inject()))
  })
  await settle()
}

/* Mount: three entries on the roster, all three clear points in place. */
await showPanel()
await paintSeats()
const hotLoaded = seatState()
check(
  '热更新·装：三处清场点各就各位（两处座席在册且画得出来 ＋ 两张注入的标签在文档里）',
  hot.ledger.size === 3 && allSeats(hotLoaded, true)
    && tagOf(client.PANEL_STYLE_ID) !== null && tagOf(client.SETTINGS_STYLE_ID) !== null,
  `名册 ${String(hot.ledger.size)} 条 ｜ ${seatReport(hotLoaded)} ｜ ${styleReport()}`,
)

/* Unmount: the two seats come off the roster so the renderer draws nothing; both tags come off the document. */
await act(async () => { hotPanelRoot.unmount(); hotSectionRoot.unmount() })
for (const one of hot.effects) one.off()
await paintSeats()
const hotUnloaded = seatState()
check(
  '热更新·卸：三处清场点各自清干净（两处座席不在册且屏上没了 ＋ 两张注入的标签都摘掉）',
  hot.ledger.size === 0 && allSeats(hotUnloaded, false) && stylesGone(),
  `名册 ${String(hot.ledger.size)} 条 ｜ ${seatReport(hotUnloaded)} ｜ ${styleReport()}`,
)

/* Mount again (hot reload): the same plugin runs once more onto the **same roster** — the three
 * entries return with no duplicates, and the three clear points return to their original shape. */
hotPanelHost = window.document.createElement('div')
window.document.body.appendChild(hotPanelHost)
hotPanelRoot = createRoot(hotPanelHost)
hotSectionHost = window.document.createElement('div')
window.document.body.appendChild(hotSectionHost)
hotSectionRoot = createRoot(hotSectionHost)
for (const one of hot.effects) one.run()
await showPanel()
await paintSeats()
const hotReloaded = seatState()
check(
  '热更新·再装：同一本名册上三处清场点各回到原样，仍是三条、没有重复',
  hot.ledger.size === 3 && allSeats(hotReloaded, true)
    && tagOf(client.PANEL_STYLE_ID) !== null && tagOf(client.SETTINGS_STYLE_ID) !== null,
  `名册 ${String(hot.ledger.size)} 条 ｜ ${seatReport(hotReloaded)} ｜ ${styleReport()}`,
)

/* ---- 6f. The language switch: every word on both surfaces follows the port ----
 *
 * The point of moving words out of the model and host layers: the same panel, handed another
 * table, says another language — nothing re-registered, no word carried in a reading. DSH's
 * locale service is stood in for in the shape `locale.ts` binds to (register / bind / subscribe /
 * getSnapshot), the port attaches to it, and a switch is one call. `act` flushes the redraw; the
 * panel's own fetch pass never runs for these mounts, so no reading is spent on the language.
 */
function fakeLocaleService(initial) {
  const dicts = new Map()
  const listeners = new Set()
  let active = initial
  let revision = 0
  const nsOf = (ns) => { if (!dicts.has(ns)) dicts.set(ns, new Map()); return dicts.get(ns) }
  return {
    register(ns, locale, dict) {
      const held = nsOf(ns)
      if (held.has(locale)) throw new Error(`namespace ${ns} already has ${locale}`)
      held.set(locale, dict)
    },
    bind(ns) {
      return (key, params) => {
        const raw = nsOf(ns).get(active)?.[key] ?? key
        return params === undefined ? raw
          : raw.replace(/\{([A-Za-z0-9_]+)\}/gu, (whole, name) => (params[name] === undefined ? whole : String(params[name])))
      }
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot() { return { active, revision } },
    getLocale() { return { active, revision } },
    switchTo(next) { active = next; revision += 1; for (const listener of [...listeners]) listener() },
  }
}

/** A fresh host div for one language mount, and its root rendered inside an `act` flush. */
const languageHost = () => {
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  return host
}
const languageRoot = async (host, element) => {
  const root = createRoot(host)
  await act(async () => { root.render(element) })
  return root
}

/* 1. The settings page follows the language: its rows are keys in `prefs.ts`, spelled by the port. */
const settingsLanguagePort = client.createLocalePort()
const settingsLanguageService = fakeLocaleService('zh')
settingsLanguagePort.attach(settingsLanguageService)
const languageSettingsHost = languageHost()
const languageSettingsRoot = await languageRoot(
  languageSettingsHost,
  React.createElement(client.SettingsSection, { locale: settingsLanguagePort }),
)
const settingsSaidZh = languageSettingsHost.textContent ?? ''
await act(async () => { settingsLanguageService.switchTo('en') })
const settingsSaidEn = languageSettingsHost.textContent ?? ''
check(
  '语言一换，设置那一页当场换一套字：中文那一行换成英文那一行，中文不再留在页上',
  settingsSaidZh.includes('默认信息量')
    && settingsSaidEn.includes('Default information level')
    && settingsSaidEn.includes('默认信息量') === false,
  `中文时=${JSON.stringify(settingsSaidZh.slice(0, 48))} ｜ 英文时=${JSON.stringify(settingsSaidEn.slice(0, 48))}`,
)
await act(async () => { languageSettingsRoot.unmount() })

/* 2. The bundled fallback: a deployment with no locale service keeps every word — Chinese, as before. */
const fallbackLanguageHost = languageHost()
const fallbackLanguageRoot = await languageRoot(
  fallbackLanguageHost,
  React.createElement(client.SettingsSection, { locale: client.createLocalePort() }),
)
const fallbackSaid = fallbackLanguageHost.textContent ?? ''
check(
  '没接上语言服务：随包那份词典照样说话，这一页仍是中文（缺服务只降级功能，不丢字）',
  fallbackSaid.includes('默认信息量'),
  `页上=${JSON.stringify(fallbackSaid.slice(0, 48))}`,
)
await act(async () => { fallbackLanguageRoot.unmount() })

/* 3. The main panel body follows the language. The panel component is taken the way the shell takes
 * it: boot a stand-in context, then read the registered service's `Panel`. */
const languageApi = {}
const languageCtx = {
  provide: (key, value) => { languageApi[key] = value },
  inject: (names, callback) => callback(languageCtx),
  get: () => undefined,
  effect: (run) => run(),
}
client.apply(languageCtx)
const LanguagePanel = languageApi[client.SERVICE_KEY]?.Panel
const bodyLanguagePort = client.createLocalePort()
const bodyLanguageService = fakeLocaleService('zh')
bodyLanguagePort.attach(bodyLanguageService)
const languageBodyHost = languageHost()
const languageBodyRoot = await languageRoot(
  languageBodyHost,
  React.createElement(LanguagePanel, { locale: bodyLanguagePort }),
)
const bodySaidZh = languageBodyHost.querySelector('.pf-none p')?.textContent ?? ''
await act(async () => { bodyLanguageService.switchTo('en') })
const bodySaidEn = languageBodyHost.querySelector('.pf-none p')?.textContent ?? ''
check(
  '主面板正文也跟着换：没选中会话那句话换成英文，中文那句不再出现',
  bodySaidZh === client.WORD_TABLES.zh['panel.no-session']
    && bodySaidEn === client.WORD_TABLES.en['panel.no-session']
    && bodySaidZh !== bodySaidEn,
  `中文时=${JSON.stringify(bodySaidZh)} ｜ 英文时=${JSON.stringify(bodySaidEn)}`,
)
await act(async () => { languageBodyRoot.unmount() })

/* 4. The chrome follows too: a port whose reads never answer leaves the panel on its loading pass,
 * which still draws the tab row — six words, swapped by the switch. */
const neverAnswers = new Promise(() => undefined)
const pendingPort = {
  source: 'none',
  read: () => neverAnswers,
  readSessions: () => neverAnswers,
  say: async () => ({ ok: false, code: 'no-write-channel' }),
  write: async () => ({ ok: false, code: 'no-write-channel' }),
  setPolicy: async () => ({ ok: false, code: 'no-write-channel' }),
  readConfig: () => neverAnswers,
  setConfig: async () => ({ ok: false, code: 'no-write-channel' }),
}
const chromeLanguagePort = client.createLocalePort()
const chromeLanguageService = fakeLocaleService('zh')
chromeLanguagePort.attach(chromeLanguageService)
const languageChromeHost = languageHost()
const languageChromeRoot = await languageRoot(
  languageChromeHost,
  React.createElement(LanguagePanel, { locale: chromeLanguagePort, sessionId: 's1', port: pendingPort }),
)
const chromeSaidZh = languageChromeHost.textContent ?? ''
await act(async () => { chromeLanguageService.switchTo('en') })
const chromeSaidEn = languageChromeHost.textContent ?? ''
const CHROME_ZH = ['当前', '明细', '指令', '依赖', '问题', '设置']
const CHROME_EN = ['Now', 'Detail', 'Instructions', 'Dependencies', 'Issues', 'Settings']
check(
  '面板骨架也跟着换：六个标签一套字换成另一套，英文那一边一个中文字都不留',
  CHROME_ZH.every((word) => chromeSaidZh.includes(word))
    && CHROME_EN.every((word) => chromeSaidEn.includes(word))
    && ['当前', '依赖', '指令'].every((word) => chromeSaidEn.includes(word) === false),
  `中文时=${JSON.stringify(chromeSaidZh.slice(0, 56))} ｜ 英文时=${JSON.stringify(chromeSaidEn.slice(0, 56))}`,
)
await act(async () => { languageChromeRoot.unmount() })

/* 5. The two lookup tables are parallel: same keys, every one carrying a word — except the "head" that
 * a language leading with the number deliberately leaves empty. */
const zhKeys = Object.keys(client.WORD_TABLES.zh).sort()
const enKeys = Object.keys(client.WORD_TABLES.en).sort()
const emptyWords = (dict) => Object.keys(dict).filter((key) => dict[key].length === 0 && key.endsWith('.head') === false)
check(
  '两本词典键是同一套、每枚键都有字（只有语言把数字放在前面时那枚 head 可以空着）',
  zhKeys.length > 0
    && JSON.stringify(zhKeys) === JSON.stringify(enKeys)
    && emptyWords(client.WORD_TABLES.zh).length === 0
    && emptyWords(client.WORD_TABLES.en).length === 0,
  `键 ${String(zhKeys.length)} 枚 ｜ 只在一本里的=${JSON.stringify(zhKeys.filter((key) => enKeys.includes(key) === false).concat(enKeys.filter((key) => zhKeys.includes(key) === false)))} ｜ 空着的=${JSON.stringify([...emptyWords(client.WORD_TABLES.zh), ...emptyWords(client.WORD_TABLES.en)])}`,
)

/* 6. Detaching the service falls back to the bundled table on the spot. */
const detachLanguagePort = client.createLocalePort()
const detachLanguageService = fakeLocaleService('zh')
detachLanguagePort.attach(detachLanguageService)
await act(async () => { detachLanguageService.switchTo('en') })
const attachedSeat = detachLanguagePort.getSnapshot().t('seat.label')
detachLanguagePort.attach(null)
const detachedSeat = detachLanguagePort.getSnapshot().t('seat.label')
check(
  '把语言服务摘掉：当场回到随包那份中文，不留上一个语言的尾巴',
  attachedSeat === client.WORD_TABLES.en['seat.label']
    && detachedSeat === '调度中心'
    && detachLanguagePort.getSnapshot().active === client.FALLBACK_LOCALE,
  `接上英文时=${JSON.stringify(attachedSeat)} ｜ 摘掉后=${JSON.stringify(detachedSeat)} ｜ 在册语言=${detachLanguagePort.getSnapshot().active}`,
)

/* ---- 7. Console ---------------------------------------------------------- */

check('控制台没有 error', consoleErrors.length === 0, consoleErrors.length === 0 ? '0 条' : consoleErrors.join(' | '))

/* ---- Readings to file ---------------------------------------------------- */

const report = lines.join('\n')
writeFileSync(join(work, 'panel-check.txt'), `${report}\n`)
console.log(report)
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${String(lines.filter((line) => line.startsWith('ok  ')).length)} passed, ${String(failures.length)} failed`)
process.exit(failures.length === 0 ? 0 : 1)