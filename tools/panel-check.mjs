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
 * none of the three pipeline files — the "map collapses to one line" case. */
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
check('五个标签都在', tabs.length === 5, tabs.map((tab) => tab.textContent).join('/'))

const views = ['地图', '明细', '指令', '问题', '设置']
for (const [index, label] of views.entries()) {
  await act(async () => { tabs[index].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  const pane = container.querySelector(`#pane-${['map', 'detail', 'notes', 'issue', 'config'][index]}`)
  check(`看法「${label}」渲染出内容`, pane !== null && pane.hidden === false, pane === null ? '没有这一格' : `pane-${pane.id}`)
}

/* Fill follows the view: the map and the detail pane both take the whole footprint. */
await act(async () => { tabs[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const frameMap = container.querySelector('#frame')
check('地图那一格撑满', frameMap.classList.contains('is-fill') === true, `class=${frameMap.className}`)
await act(async () => { tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('明细那一格撑满', container.querySelector('#frame').classList.contains('is-fill') === true, 'is-fill')

/* The map's readings must match the record: one card per node, one wire per edge, and one rail row
 * per line plus the whole workspace. "The pane has text"-style asserts would not do — the rail alone
 * would satisfy them, regardless of the record. The header used to total the four node states up
 * here; that row of counts is gone, and this reads it gone as well. */
await act(async () => { tabs[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const reading = await gateway.read(sessionId, '', {})
const project = readProject({ nodes: reading.nodes, cycles: reading.cycles, instructions: reading.instructions, issues: reading.issues, at: new Date() })
lines.push(`      记录里的读数：${JSON.stringify(reading.sources)}`)
const headCounts = container.querySelectorAll('.pf-head .pf-count, .pf-head #census').length
/* The page draws at most MAP_CAP cards; this record is far below it, so the drawn set is the record. */
const MAP_CAP = 1000
const mapPane = () => container.querySelector('#pane-map')
const cardIds = [...(mapPane()?.querySelectorAll('.pf-mnode') ?? [])].map((card) => card.getAttribute('data-id'))
const wireCount = mapPane()?.querySelectorAll('.pf-mwire').length ?? 0
const railRows = [...(mapPane()?.querySelectorAll('.pf-rail-item') ?? [])]
const expectedRail = [t('common.global'), ...project.cycles.map((cycle) => cycle.id)]
check(
  '地图上的数从记录里来：每格一张卡、每条边一根线、左栏一行一拍，逐项对上；页头不再报那排计数',
  headCounts === 0
    && JSON.stringify([...cardIds].sort()) === JSON.stringify(project.nodes.slice(0, MAP_CAP).map((node) => node.id).sort())
    && wireCount === project.graph.edges.length
    && JSON.stringify(railRows.map((row) => row.textContent)) === JSON.stringify(expectedRail)
    && railRows[0]?.getAttribute('aria-pressed') === 'true',
  `记录现算 卡=${String(Math.min(MAP_CAP, project.nodes.length))} 线=${String(project.graph.edges.length)} 栏=${JSON.stringify(expectedRail)} ｜ 面板上 卡=${String(cardIds.length)} 线=${String(wireCount)} 栏=${JSON.stringify(railRows.map((row) => row.textContent))} 页头计数=${String(headCounts)}`,
)

/* A card's two lines, read off the drawn ones: the title leads, and the foot row is the line's id
 * then the moment — the state square that used to lead that row on every card is gone. The one card
 * in hand wears the running ring at the head of the row instead, so the ring stands exactly on the
 * cards whose reading says `running`, and no card carries a cell any more. */
const cardShapes = [...(mapPane()?.querySelectorAll('.pf-mnode') ?? [])].map((card) => {
  const id = card.getAttribute('data-id') ?? ''
  const reading = project.nodeById[id]
  const meta = card.querySelector('.pf-mmeta')
  const first = meta?.firstElementChild ?? null
  return {
    title: card.firstElementChild?.classList.contains('pf-mtitle') === true,
    cells: meta?.querySelectorAll('.pf-cell').length ?? 0,
    ring: reading?.running === true,
    ringFirst: first !== null && first.classList.contains('pf-state') && first.classList.contains('is-run'),
    tag: card.querySelector('.pf-mtag') === null ? '' : (card.querySelector('.pf-mtag')?.textContent ?? ''),
    line: reading?.cycleIds[0] ?? '',
  }
})
check(
  '地图上每张卡：标题起头，底栏不再画方块，正在执行的那一张由旋转环领着头一格，拍名与记录一致',
  cardShapes.length > 0
    && cardShapes.every((shape) => shape.title && shape.cells === 0 && shape.tag === shape.line)
    && cardShapes.every((shape) => shape.ring === shape.ringFirst),
  `卡=${String(cardShapes.length)} 标题不在首位=${String(cardShapes.filter((shape) => !shape.title).length)} 还带方块=${String(cardShapes.filter((shape) => shape.cells > 0).length)} 旋转环=${String(cardShapes.filter((shape) => shape.ringFirst).length)}/${String(cardShapes.filter((shape) => shape.ring).length)} 拍名不齐=${String(cardShapes.filter((shape) => shape.tag !== shape.line).length)}`,
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
 * `missing`. The panel body collapses to one line, and the tabs, the panes and the header's counts
 * (which the header no longer carries) are withdrawn with it (the testbed's synthetic workspace is
 * exactly this case). */
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
  '空记录的工作区：面板正文只留「当前工作区没有 pathfinder 的记录」，标签与五格一起收走，页头不留计数',
  emptyHost.querySelector('.pf-none') !== null
    && emptySaid === '当前工作区没有 pathfinder 的记录。'
    && emptyHost.querySelector('.pf-tabs') === null
    && emptyHost.querySelector('.pf-head .pf-count') === null
    && emptyHost.querySelectorAll('.pf-pane').length === 0,
  `工作区=${emptyWorkspace.replace(root, '.')}（没有 .pf） ｜ .pf-none p=${JSON.stringify(emptySaid)} ｜ 标签 ${String(emptyHost.querySelectorAll('.pf-tabs').length)} 处、页头计数 ${String(emptyHost.querySelectorAll('.pf-head .pf-count').length)} 处、五格 ${String(emptyHost.querySelectorAll('.pf-pane').length)} 处`,
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
    && brokenHost.querySelector('.pf-head .pf-count') === null
    && brokenHost.querySelectorAll('.pf-pane').length === 0,
  `工作区=${brokenWorkspace.replace(root, '.')}（.pf 在、四份读不动） ｜ .pf-none p=${JSON.stringify(brokenSaid)} ｜ 标签 ${String(brokenHost.querySelectorAll('.pf-tabs').length)} 处、页头计数 ${String(brokenHost.querySelectorAll('.pf-head .pf-count').length)} 处、五格 ${String(brokenHost.querySelectorAll('.pf-pane').length)} 处`,
)

/* Pipeline present, issue pool absent: the four node-following panes stay as usual (the map has
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
  '有节点、问题池空的工作区：四个跟节点走的格子照旧，问题那一格收成「当前工作区尚未启用 Pathfinder」',
  bareHost.querySelector('.pf-none') === null
    && bareHost.querySelector('#pane-map .pf-rail') !== null
    && bareHost.querySelectorAll('#pane-map .pf-mnode').length > 0
    && bareHost.querySelectorAll('.pf-head .pf-tab').length === 5
    && bareHost.querySelector('#pane-config') !== null
    && bareHost.querySelector('#pane-config .pf-innone') === null
    && bareSaid === '当前工作区尚未启用 Pathfinder。'
    && bareHost.querySelector('#pane-issue .pf-split') === null,
  `工作区=${bareWorkspace.replace(root, '.')}（管线在、问题池那一份不在） ｜ 地图 ${String(bareHost.querySelectorAll('#pane-map .pf-mnode').length)} 格 ｜ 问题那一格说=${JSON.stringify(bareSaid)}`,
)

/* The issue-pool-only case (what `pf issue scan` writes in a repo with no pipeline yet): each of
 * the four node-following panes collapses to the same sentence, and the header keeps its tabs but
 * reports no counts at all — it has none of its own to report; the issue pane is the exception — it
 * still draws the pool, every entry of it. */
const poorHost = window.document.createElement('div')
window.document.body.appendChild(poorHost)
const poorRoot = createRoot(poorHost)
await act(async () => {
  poorRoot.render(React.createElement(panel.Panel, { port: trackedPort, sessionId: poorSessionId, prefs: panel.prefs }))
})
await settle()
const poorSaid = ['map', 'detail', 'notes', 'config']
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
  '只有问题池的工作区：四个跟节点走的格子各自收成同一句话，问题那一格照池子读数走——有行画登记簿（精简档=未解决那几条），一条不剩收成同一句话',
  poorHost.querySelector('.pf-none') === null
    && poorSaid.every((said) => said === '当前工作区尚未启用 Pathfinder。')
    && poorHost.querySelectorAll('.pf-tabs').length === 1
    && poorHost.querySelectorAll('.pf-pane').length === 5
    && poorHost.querySelector('#pane-map .pf-rail') === null
    && poorHost.querySelector('.pf-head .pf-count') === null
    && (project.pool.rows.length === 0
      ? poorIssueSaid === '当前工作区尚未启用 Pathfinder。'
      : poorIssueSaid === ''
        && poorHost.querySelector('#pane-issue .pf-split') !== null
        && JSON.stringify(poorRows.map((row) => row.getAttribute('data-issue'))) === JSON.stringify(poorOpenIds)),
  `工作区=${poorWorkspace.replace(root, '.')}（只有问题池） ｜ 四格=${JSON.stringify(poorSaid)} ｜ 页头计数 ${String(poorHost.querySelectorAll('.pf-head .pf-count').length)} 处、五格 ${String(poorHost.querySelectorAll('.pf-pane').length)} 格 ｜ 池子读数 共 ${String(project.pool.rows.length)} 条、未解决 ${String(poorOpenIds.length)} 条 ｜ 问题那一格 ${String(poorRows.length)} 行`,
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

/* The readable record stays as usual: the five tabs and the five panes all present, no such sentence
 * in the body, and the header reports no count of its own — the issue band's pills are that pane's
 * reading, so the header is asked by its own scope. */
check(
  '这一份记录读得回来：五格标签与五格正文照旧画着，页头自己不再报计数，正文里没有那句话',
  tabs.length === 5 && container.querySelector('.pf-head .pf-count') === null
    && container.querySelectorAll('.pf-pane').length === 5
    && container.querySelector('.pf-none') === null,
  `标签 ${String(tabs.length)} 枚 ｜ 页头计数 ${String(container.querySelectorAll('.pf-head .pf-count').length)} 处 ｜ 五格 ${String(container.querySelectorAll('.pf-pane').length)} 格 ｜ .pf-none ${container.querySelector('.pf-none') === null ? '（没有）' : '画了出来'}`,
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
  `问过的根=${JSON.stringify([...new Set(askedRoots)])} ｜ .pf-none p=${JSON.stringify(spaceUngrouped)} ｜ 选择器=${ungroupedSelect === null ? '（没了）' : `选中=${JSON.stringify(ungroupedSelect.value)}`} ｜ 五格 ${String(spaceHost.querySelectorAll('.pf-pane').length)} 格`,
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
  '谁的桶都不在的会话：默认就停在「未分组」，照旧递空字符串读它自己那个根，五格与页头标签都在',
  loneSelect() !== null && loneSelect().value === ''
    && askedRoots.length > 0 && askedRoots.every((one) => one === '')
    && loneHost.querySelector('.pf-none') === null
    && loneHost.querySelectorAll('.pf-pane').length === 5 && loneHost.querySelector('.pf-head .pf-tabs') !== null,
  `选中=${JSON.stringify(loneSelect()?.value)} ｜ 问过的根=${JSON.stringify([...new Set(askedRoots)].map((one) => (one === '' ? '（空：会话自己那个）' : one.replace(root, '.'))))} ｜ 五格 ${String(loneHost.querySelectorAll('.pf-pane').length)} 格 ｜ .pf-none ${loneHost.querySelector('.pf-none') === null ? '（没有）' : '画了出来'}`,
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
  '拨去别处再拨回「未分组」：没有归属的会话照旧读它自己那个根，五格与页头标签都在',
  askedRoots.length > 0 && askedRoots.every((one) => one === '')
    && loneHost.querySelector('.pf-none') === null
    && loneHost.querySelectorAll('.pf-pane').length === 5 && loneHost.querySelector('.pf-head .pf-tabs') !== null,
  `问过的根=${JSON.stringify([...new Set(askedRoots)].map((one) => (one === '' ? '（空：会话自己那个）' : one.replace(root, '.'))))} ｜ 五格 ${String(loneHost.querySelectorAll('.pf-pane').length)} 格 ｜ .pf-none ${loneHost.querySelector('.pf-none') === null ? '（没有）' : '画了出来'}`,
)

await act(async () => { loneRoot.unmount() })

/* The eleven `--pf-*` declaration points in the shipped css, measured by the values resolved on the
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
  '--pf-row': '34px',
  '--pf-mark': '14px',
  '--pf-detail-top': '12px',
  '--pf-detail-foot': '20px',
}
const panelRoot = container.querySelector('.pf-page')
const rootStyle = window.getComputedStyle(panelRoot)
const tokenReadings = Object.entries(TOKEN_VALUES).map(([token, want]) => {
  const got = rootStyle.getPropertyValue(token).replace(/\s+/gu, ' ').trim()
  return `${token}=${got === want ? 'ok' : `"${got}"（要 "${want}"）`}`
})
const rootWon = winningDeclarations(panelRoot, ['box-sizing'])
check(
  '面板根吃到了蓝本固定在页面根 / 全局上的那一批（十一个 --pf-* 令牌 + reset 的 box-sizing）',
  panelRoot !== null
    && Object.entries(TOKEN_VALUES).every(([token, want]) => rootStyle.getPropertyValue(token).replace(/\s+/gu, ' ').trim() === want)
    && rootWon['box-sizing'] === 'border-box',
  `${tokenReadings.join(' ')} ｜ box-sizing=${rootWon['box-sizing'] === undefined ? '（没有规则落在它身上）' : `"${rootWon['box-sizing']}"`}`,
)

/* The settings pane's column belongs to the main panel's skeleton, which is where this reads the
 * stage and the frame it fills: the stage takes the pane at the middle of its top and scrolls when
 * the footprint is short, and the frame takes a width and centres itself. */
const stageWon = winningDeclarations(container.querySelector('.pf-stage'), ['padding', 'overflow-y', 'justify-content'])
const frameWon = winningDeclarations(container.querySelector('.pf-frame'), ['width', 'margin', 'display'])
/* Every view fills the footprint now, so the frame in play takes the filled width; the base width —
 * `--pf-frame-w` with its fallback — still has to be in the bundle, and it is read on a bare frame
 * placed inside the panel's own layer, where that rule actually matches. */
const bareFrame = window.document.createElement('div')
bareFrame.className = 'pf-frame'
container.querySelector('.pf-page')?.appendChild(bareFrame)
const bareWon = winningDeclarations(bareFrame, ['width'])
bareFrame.remove()
check(
  '舞台与框在蓝本里的有效值进了包',
  stageWon.padding === '8px 0' && stageWon['overflow-y'] === 'auto' && stageWon['justify-content'] === 'center'
    && frameWon.width === '100%' && frameWon.margin === 'auto' && frameWon.display === 'flex'
    && bareWon.width === 'var(--pf-frame-w, 1280px)',
  `stage padding=${JSON.stringify(stageWon.padding)} overflow-y=${JSON.stringify(stageWon['overflow-y'])} justify-content=${JSON.stringify(stageWon['justify-content'])} ｜ frame width=${JSON.stringify(frameWon.width)}（不撑满时=${JSON.stringify(bareWon.width)}） margin=${JSON.stringify(frameWon.margin)} display=${JSON.stringify(frameWon.display)}`,
)

/* The equivalence ruler lived here: it compared the shipped css against the blueprint's sheets rule by
 * rule, sheet by sheet, and the embedded pane's landing against a copy of those sheets. It
 * existed to prove the build's scoping pass faithful, and that pass is gone — `src/client/styles/`
 * is read in order as the shipped bytes, so there is nothing left to compare them to. The notches
 * it guarded (`.is-embed.pf-issue X`, `.pf-issue .pf-register .pf-row`) are written out plainly in
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
  '设置里那一页是三行，侧栏宽度不在其中',
  settingRows().length === 3 && rowNames.join('/') === '默认标签页/指令里显示已归档的/问题池里显示未解决之外的',
  `三行=${rowNames.join('/') || '（一行都没有）'}`,
)

const flipSwitch = async (label) => {
  const button = rowNamed(label)?.querySelector('.pfset-switch')
  await act(async () => { button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
}

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
await pickOption(rowNamed('默认标签页')?.querySelector('.pfset-select'), '地图')

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

/* ---- 4b. The map pane: one card per node, one wire per edge, a rail that changes the emphasis, and
 * a camera that really moves ----
 * The drawing is read here the way a reader reads it: which cards are in ink, which rail row is
 * pressed, and where the camera stands afterwards. The expected placement and camera come from the
 * same engine the panel calls, so this section measures the panel against the record rather than
 * against a copy of the arithmetic. */

const click = async (element) => {
  await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
}
const { emphasisOf, fitView, focusView, place, rankedOf } = await import(pathToFileURL(join(root, 'src', 'client', 'map-layout.ts')).href)

/** Before this section starts: how often the write face was called, and what the record looked like. */
const writesBefore = writeCalls.length
const recordBefore = recordDigest()

await act(async () => { tabs[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await settle()

const drawnCards = () => [...(mapPane()?.querySelectorAll('.pf-mnode') ?? [])]
const litIds = () => drawnCards().filter((card) => card.classList.contains('is-lit')).map((card) => card.getAttribute('data-id'))
const aheadIds = () => drawnCards().filter((card) => card.classList.contains('is-ahead')).map((card) => card.getAttribute('data-id'))
const cardOf = (id) => drawnCards().find((card) => card.getAttribute('data-id') === id)
const canvasOf = () => mapPane()?.querySelector('.pf-canvas')
const scaleOf = () => Number(/scale\(([\d.]+)\)/u.exec(canvasOf()?.style.transform ?? '')?.[1] ?? Number.NaN)
const transformOf = () => {
  const held = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/u.exec(canvasOf()?.style.transform ?? '')
  return held === null ? null : { tx: Number(held[1]), ty: Number(held[2]), s: Number(held[3]) }
}
const placement = place({ nodes: project.nodes, edges: project.graph.edges })
const nameOf = (node) => (node.title ?? (node.id.length > 8 ? node.id.slice(0, 8) : node.id))

check(
  '地图那一格：一格一张卡、一条边一根线，卡上的名字就是记录里那个标题',
  drawnCards().length === project.nodes.length
    && (mapPane()?.querySelectorAll('.pf-mwire').length ?? 0) === project.graph.edges.length
    && drawnCards().every((card) => {
      const node = project.nodeById[card.getAttribute('data-id') ?? '']
      return node !== undefined && card.querySelector('.pf-mtitle')?.textContent === nameOf(node)
    }),
  `记录里 ${String(project.nodes.length)} 格 / ${String(project.graph.edges.length)} 条边 ｜ 面板上 ${String(drawnCards().length)} 张卡 / ${String(mapPane()?.querySelectorAll('.pf-mwire').length ?? 0)} 根线，头三个 ${drawnCards().slice(0, 3).map((card) => card.querySelector('.pf-mtitle')?.textContent ?? '').join(' / ')}`,
)

/* Press one card: the emphasis follows the press — that card, what it owes, what owes it, plus the
 * whole workspace's gates while the rail stands on the whole workspace. */
const hub = project.graph.edges[0]?.from
const hubCard = hub === undefined ? undefined : cardOf(hub)
if (hubCard !== undefined) await click(hubCard)
const wantLit = hub === undefined ? [] : [...emphasisOf(placement, hub, null).lit].sort()
check(
  '地图那一格：点一格，点亮它自己、它欠的、欠它的，加上全工作区的人闸',
  hubCard !== undefined && JSON.stringify(litIds().sort()) === JSON.stringify(wantLit),
  `记录现算 ${String(wantLit.length)} 格（${wantLit.map((id) => id.slice(0, 8)).join(',')}）｜ 面板上 ${String(litIds().length)} 格（${litIds().map((id) => (id ?? '').slice(0, 8)).join(',')}）`,
)

/* A rail row is a hit scope, not a filter: the whole drawing stays, and the row's own line gets the
 * ink. Every other line's cards and the cycle-less cards fall back to structure. */
const scopeLine = project.cycles.find((cycle) => project.nodes.some((node) => node.cycleIds.includes(cycle.id)))
const lineRow = [...(mapPane()?.querySelectorAll('.pf-rail-item') ?? [])].find((row) => row.textContent === scopeLine?.id)
const lineNodes = scopeLine === undefined ? [] : project.nodes.filter((node) => node.cycleIds.includes(scopeLine.id)).map((node) => node.id)
if (lineRow !== undefined) await click(lineRow)
check(
  '地图那一格：左栏选一条线，那条线碰过的格子全点亮，整张图仍在一格不少',
  scopeLine !== undefined && lineRow?.getAttribute('aria-pressed') === 'true'
    && lineNodes.every((id) => litIds().includes(id))
    && (lineNodes.length === project.nodes.length || litIds().length < project.nodes.length)
    && drawnCards().length === project.nodes.length,
  `这条线碰过 ${String(lineNodes.length)} 格 ｜ 点亮的 ${String(litIds().length)} 格 ｜ 图上 ${String(drawnCards().length)} 格（记录里 ${String(project.nodes.length)} 格）`,
)

/* The tiers below the picked line: a card no line has touched yet is "ahead", a card on another
 * line is neither of the two — it keeps its state in its mark and its words, not in its frame. */
const noLine = project.nodes.filter((node) => node.cycleIds.length === 0).map((node) => node.id)
const otherLine = project.nodes.filter((node) => node.cycleIds.length > 0 && !node.cycleIds.includes(scopeLine?.id)).map((node) => node.id)
check(
  '地图那一格：选一条线，没有线的格子低一档，别的线的格子两档都不占',
  lineNodes.every((id) => litIds().includes(id))
    && noLine.every((id) => aheadIds().includes(id))
    && otherLine.every((id) => !litIds().includes(id) && !aheadIds().includes(id)),
  `选中的线碰过 ${String(lineNodes.length)} 格 ｜ 没有线的 ${String(noLine.length)} 格 ｜ 别的线的 ${String(otherLine.length)} 格 ｜ 面板上：墨 ${String(litIds().length)} / 未来 ${String(aheadIds().length)}`,
)

/* The overview: one press on the top-right magnifier, and the camera takes the engine's own fit. */
const fit = fitView({ w: 1280, h: 720 }, placement)
const fitKey = mapPane()?.querySelector('#map-fit')
if (fitKey !== undefined) await click(fitKey)
check(
  '地图那一格：全览那一枚按下去，整张图按全览那个倍率摆进视口',
  fitKey?.getAttribute('aria-pressed') === 'true' && Math.abs(scaleOf() - fit.s) < 1e-6,
  `引擎算的全览倍率=${String(fit.s.toFixed(4))} ｜ 面板上的=${String(scaleOf())} aria-pressed=${String(fitKey?.getAttribute('aria-pressed'))}`,
)

/* The wheel is the zoom: a turn really changes the scale, and the pane leaves the overview tier. */
const beforeWheel = scaleOf()
await act(async () => {
  mapPane()?.querySelector('.pf-field')?.dispatchEvent(new window.WheelEvent('wheel', {
    bubbles: true, cancelable: true, deltaY: -240, clientX: 400, clientY: 300,
  }))
})
check(
  '地图那一格：滚轮真的在缩放，不是只换一个数',
  Number.isFinite(scaleOf()) && Math.abs(scaleOf() - beforeWheel) > 1e-6,
  `滚之前=${String(beforeWheel)} 滚之后=${String(scaleOf())}`,
)

/* The drag pans the drawing: at the focus the reader walks the map rather than looking at a still
 * picture, and the scale the wheel set is kept through the move. */
const beforeDrag = transformOf()
await act(async () => {
  const field = mapPane()?.querySelector('.pf-field')
  if (field === null || field === undefined) return
  const at = (type, clientX, clientY) => field.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }))
  at('pointerdown', 400, 300)
  at('pointermove', 470, 300)
  at('pointerup', 470, 300)
})
await settle()
const afterDrag = transformOf()
check(
  '地图那一格：按住横着拖七十像素，整张图就跟着走七十像素，倍率不变',
  beforeDrag !== null && afterDrag !== null
    && Math.abs(afterDrag.tx - beforeDrag.tx - 70) < 0.5
    && afterDrag.s === beforeDrag.s
    /* The drag is level: nothing asked the page to move vertically, so it must not. */
    && afterDrag.ty === beforeDrag.ty,
  `拖之前=${JSON.stringify(beforeDrag)} 拖之后=${JSON.stringify(afterDrag)}`,
)

/* The rail row is also the way back: the camera stands where the drag and the wheel left it, and one
 * press on a row returns it to that row's first card — so the page needs no reset button of its own. */
const scopeDefault = scopeLine === undefined
  ? rankedOf(project.nodes)[0]?.id ?? null
  : rankedOf(project.nodes.filter((node) => node.cycleIds.includes(scopeLine.id)))[0]?.id ?? null
const railRow = [...(mapPane()?.querySelectorAll('.pf-rail-item') ?? [])].find((row) => row.textContent === scopeLine?.id)
if (railRow !== undefined) await click(railRow)
const wantBack = railRow === undefined ? null : focusView({ w: 1280, h: 720 }, placement, scopeDefault)
const back = transformOf()
check(
  '地图那一格：拖远缩远之后点一下左栏，镜头回到那一栏的第一格',
  railRow !== undefined && wantBack !== null && back !== null
    && Math.abs(back.s - wantBack.s) < 1e-6 && Math.abs(back.tx - wantBack.tx) < 1e-6 && Math.abs(back.ty - wantBack.ty) < 1e-6,
  `那一栏的第一格=${String(scopeDefault)} ｜ 引擎=${JSON.stringify(wantBack)} ｜ 面板上=${JSON.stringify(back)}`,
)

/* And the refresh: the panel hands the read out again, so what is on screen is this record now. */
askedRoots.length = 0
await click(mapPane()?.querySelector('#map-refresh'))
check(
  '地图那一格：右上那枚刷新让面板照着这份记录再读一遍',
  askedRoots.length > 0,
  `问过的根=${JSON.stringify([...new Set(askedRoots)])}`,
)

/* ---- 4c. The issue pane: register rows, whether the weight bar draws, and the built-in master-detail ---- */

await act(async () => { tabs[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
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
 * One row per key the tool prints, grouped under a category index down the left edge: a row is the
 * key's name over its one sentence, its control, and a layer tag at the end. Readings on both sides:
 * what the panel shows, and the lines the real tool prints against the same workspace; the expected
 * rows, their categories, and their order are derived from that reading and the shipped table, never
 * written out by hand here. Each edit writes back to this project's layer and is read again — the
 * reading lands on the record file (`workspace/.pf/config.json`); what the panel reads back on its
 * own does not count.
 *
 * Two invalid-value cases: an out-of-range number (typed into the number box for real) and a tier
 * not in the option list (a forged option injected into the dropdown, then picked). Both must land
 * on "record keeps its original value, UI returns to it".
 */

const { parseConfigList } = await import(pathToFileURL(join(root, 'src', 'host', 'project-config.ts')).href)
const { configSectionsOf } = await import(pathToFileURL(join(root, 'src', 'client', 'config-rows.ts')).href)
const listed = await runPf(hostCtx, workspace, ['config', 'list'], new AbortController().signal)
/* A run's outcome carries the tool's output on success and a code-plus-detail refusal otherwise: only
 * the success branch has a text stream to parse. */
const truth = parseConfigList(listed.ok ? listed.text : '')
/** The record's three layer names as the panel's three words (the blueprint's wording). */
const LAYER_WORD = { default: '默认', project: '本项目', global: '全局' }
check(
  '设置那一格：真工具对着这份工作区印得出设置行',
  listed.ok && Object.keys(truth).length > 0,
  listed.ok
    ? listed.text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join(' ｜ ')
    : outcomeText(listed),
)

const storedConfig = () => JSON.parse(readFileSync(join(record, 'config.json'), 'utf8'))

/* What the page should hold, derived from the tool's own reading and the shipped layout table: the
 * fixture never states "these seven keys" by hand — the tool says which keys exist, and the table
 * says which category each one stands in and in what order. */
const expectedSections = configSectionsOf(truth)
const expectedRows = expectedSections.flatMap((section) => section.rows)
const expectedKeys = expectedRows.map((row) => row.key)
const GROUP_WORD = { general: '常规', issue: '问题', test: '测试' }
const LAYER_OF = (key) => (truth[key] === undefined || truth[key].layer === null ? '（没有层签）' : LAYER_WORD[truth[key].layer])
/* What a row should show for a value the record holds: the tool marks a limit nobody filled in with a
 * dash, and a number box shows nothing there — the box says "unset" instead of carrying the mark. */
const shownValueOf = (row, config) => {
  const value = String(config[row.key] ?? '（记录里没有这个键）')
  return row.kind === 'num' && value === '-' ? '' : value
}

const configReadings = (scope) => [...(scope?.querySelectorAll('#pane-config .pf-cfgrow') ?? [])].map((row) => {
  const pick = row.querySelector('select')
  const box = row.querySelector('input')
  const pressed = [...row.querySelectorAll('.pf-segbtn')].find((button) => button.getAttribute('aria-pressed') === 'true')
  return {
    key: row.getAttribute('data-key'),
    name: row.querySelector('.pf-setlabel')?.textContent ?? '',
    value: pick !== null ? pick.value : box !== null ? box.value : pressed?.textContent === '开' ? 'on' : pressed === undefined ? '（未设置）' : 'off',
    layer: row.querySelector('.pf-vlayer')?.textContent ?? '（没有层签）',
    section: row.closest('.pf-cfgsec')?.getAttribute('data-cat') ?? '（没有段）',
  }
})
const configNav = (scope) => [...(scope?.querySelectorAll('#pane-config .pf-cfgitem') ?? [])].map((item) => ({
  group: item.getAttribute('data-cat'),
  name: item.querySelector('.pf-cfgitem-name')?.textContent ?? '',
  count: item.querySelector('.pf-cfgitem-count')?.textContent ?? '',
  current: item.getAttribute('aria-current'),
}))

await act(async () => { tabs[4].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await settle()
const configPane = container.querySelector('#pane-config')
const shownFirst = configReadings(container)
const truthValues = Object.fromEntries(Object.entries(truth).map(([key, entry]) => [key, entry.value]))
const wantedFirst = expectedRows.map((row) => ({
  key: row.key,
  value: shownValueOf(row, truthValues),
  layer: LAYER_OF(row.key),
  section: expectedSections.find((section) => section.rows.some((one) => one.key === row.key))?.group ?? '（没有段）',
}))
check(
  '设置那一格：每个键一行，值与层签逐行与真工具印的那份对上，行落在它的分组里',
  JSON.stringify(shownFirst.map((row) => [row.key, row.value, row.layer, row.section]))
    === JSON.stringify(wantedFirst.map((row) => [row.key, row.value, row.layer, row.section])),
  `工具那边：${wantedFirst.map((row) => `${row.key}=${row.value}(${row.layer}/${row.section})`).join(' ')} ｜ 面板这边：${shownFirst.map((row) => `${row.key}=${row.value}(${row.layer}/${row.section})`).join(' ')}`,
)
check(
  '设置那一格：一行一个控件（下拉、数字框、开-关各照表），层签一枚不少',
  shownFirst.length === expectedKeys.length
    && configPane?.querySelectorAll('select').length === expectedRows.filter((row) => row.kind === 'pick').length
    && configPane?.querySelectorAll('input.pf-numin').length === expectedRows.filter((row) => row.kind === 'num' || row.kind === 'text').length
    && configPane?.querySelectorAll('.pf-seg').length === expectedRows.filter((row) => row.kind === 'toggle').length
    && configPane?.querySelectorAll('.pf-vlayer').length === expectedKeys.filter((key) => LAYER_OF(key) !== '（没有层签）').length,
  `行=${String(shownFirst.length)} 下拉=${String(configPane?.querySelectorAll('select').length)} 数字框=${String(configPane?.querySelectorAll('input.pf-numin').length)} 开-关=${String(configPane?.querySelectorAll('.pf-seg').length)} 层签=${String(configPane?.querySelectorAll('.pf-vlayer').length)} ｜ 名字=${shownFirst.map((row) => row.name).join('/')}`,
)
check(
  '设置那一格：每一行的名字都是自己的说法，键名只在悬停时给出',
  shownFirst.every((row) => row.name.length > 0 && row.name !== row.key),
  `名字=${shownFirst.map((row) => row.name).join(' / ')}`,
)
check(
  '设置那一格：左边的索引一栏一个分组，数目就是那一栏的行数，落笔那一栏点着',
  JSON.stringify(configNav(container))
    === JSON.stringify(expectedSections.map((section, index) => ({
      group: section.group,
      name: GROUP_WORD[section.group],
      count: String(section.rows.length),
      current: index === 0 ? 'true' : 'false',
    }))),
  `索引=${configNav(container).map((item) => `${item.group}:${item.name}(${item.count})${item.current === 'true' ? '·点着' : ''}`).join(' ')}`,
)
check(
  '设置那一格：索引脚下写着这些值住的那个文件',
  configPane?.querySelector('.pf-cfgnavfoot-path')?.textContent === '.pf/config.json'
    && (configPane?.querySelector('.pf-cfgnavfoot-term')?.textContent ?? '').length > 0,
  `脚下=${String(configPane?.querySelector('.pf-cfgnavfoot-term')?.textContent)} / ${String(configPane?.querySelector('.pf-cfgnavfoot-path')?.textContent)}`,
)
check(
  '设置那一格：那一列顶满格子，宽度跟着格子走（把手和外框都退场了）',
  configPane?.querySelectorAll('.pf-grip').length === 0
    && configPane?.querySelector('.pf-configwrap') === null
    && configPane?.style.getPropertyValue('--pf-config-w') === '',
  `把手=${String(configPane?.querySelectorAll('.pf-grip').length)} 外框=${configPane?.querySelector('.pf-configwrap') === null ? '没有' : '还在'}`,
)

/* Each row's control gets its own driver: dropdown and number box go through the **prototype
 * setter** (React remembers the last value on the node itself; assigning `element.value` directly
 * would read as unchanged), and the on-off toggle just needs a click. */
const rowIn = (scope, key) => [...(scope?.querySelectorAll('#pane-config .pf-cfgrow') ?? [])]
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
/* The tool's own mark for a limit nobody filled in is a dash; the box states "unset" instead of
 * standing empty, which could be read as a zero. */
const unsetRows = expectedRows.filter((row) => row.kind === 'num' && truthValues[row.key] === '-')
check(
  '设置那一格：工具印「-」的那个上限，框里挂「未设置」的灰字',
  unsetRows.length > 0 && unsetRows.every((row) => {
    const box = rowIn(container, row.key)?.querySelector('input.pf-numin')
    return box !== null && box !== undefined && box.classList.contains('is-unset') && box.getAttribute('placeholder') === '未设置'
  }),
  `- 的上限=${unsetRows.map((row) => `${row.key}:${String(rowIn(container, row.key)?.querySelector('input.pf-numin')?.getAttribute('placeholder'))}`).join(' ')}`,
)
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

const switchedRow = expectedRows.find((row) => row.group === 'issue' && row.kind === 'toggle')
const issueRow = rowIn(container, switchedRow?.key ?? 'issue_pool')
await pressToggle(issueRow, '关')
wrote.push(`${switchedRow?.key ?? 'issue_pool'} → off`)
check(
  '问题池那个开关改一次：记录里真的是那个值，面板上跟着换成它',
  storedConfig()[switchedRow?.key ?? 'issue_pool'] === 'off'
    && rowIn(container, switchedRow?.key ?? 'issue_pool').querySelector('.pf-segbtn[aria-pressed="true"]')?.textContent === '关',
  `记录里=${String(storedConfig()[switchedRow?.key ?? 'issue_pool'])} 面板上按下的是=${String(rowIn(container, switchedRow?.key ?? 'issue_pool').querySelector('.pf-segbtn[aria-pressed="true"]')?.textContent)}`,
)
lines.push(`      设置那一格改了 ${String(wrote.length)} 行：${wrote.join(' ｜ ')}`)

/* After writing those rows: their values live in this project's layer and their tags say so; the
 * keys nothing was written to still read the layer the tool printed for them. */
const written = new Set(['worktree_mode', 'test_tier', 'max_agents', switchedRow?.key ?? 'issue_pool'])
const shownAfter = configReadings(container)
const configNow = storedConfig()
/* What a row should show once the writes landed: the written keys read the record's own file; every
 * other key keeps the value the tool printed before, the writes never touched it. */
const expectedAfterWrite = (row) => (written.has(row.key)
  ? shownValueOf(row, configNow)
  : shownValueOf(row, truthValues))
check(
  '写完这几行：动过的那几枚层签读作「本项目」（写的永远是这一层），其余照工具印的层，值与记录里一致',
  shownAfter.length === expectedKeys.length
    && shownAfter.every((row) => row.layer === (written.has(row.key) ? '本项目' : LAYER_OF(row.key)))
    && shownAfter.every((row) => row.value === expectedAfterWrite(expectedRows.find((one) => one.key === row.key))),
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

/* Reopen a panel (same record, same session): every row still matches the value the record holds. */
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
  '重开一份面板：设置那一格的每一行与记录里的值还对得上',
  reopened.length === expectedKeys.length
    && reopened.every((row) => row.value === expectedAfterWrite(expectedRows.find((one) => one.key === row.key)))
    && reopened.every((row) => row.layer === (written.has(row.key) ? '本项目' : LAYER_OF(row.key))),
  `重开后面板上=${JSON.stringify(reopened.map((row) => `${row.key}=${row.value}`))} ｜ 记录里=${JSON.stringify(storedAfter)}`,
)
await act(async () => { reopenRoot.unmount() })
lines.push(`      设置那一格收尾时记录里那几个键：${JSON.stringify(storedAfter)}`)

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
const restartedWidth = container.querySelector('#detail-split')?.getAttribute('aria-valuenow')
const restartedFull = [...container.querySelectorAll('#pane-issue .pf-segbtn')]
  .find((button) => button.getAttribute('aria-pressed') === 'true')?.textContent
check(
  '第二个实例照同一份文档开：标签页、侧栏宽度、问题池那一档都对上',
  restartedTab === `tab-${String(keptPrefs.defaultTab)}`
    && restartedWidth === String(keptPrefs.sideWidth)
    && restartedFull === (keptPrefs.showOtherStates === true ? '完整' : '精简'),
  `文档=${JSON.stringify(keptPrefs)} ｜ 面板上 标签=${String(restartedTab)} 宽度=${String(restartedWidth)} 问题池=${String(restartedFull)}`,
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
const hotSeatHost = window.document.createElement('div')
window.document.body.appendChild(hotSeatHost)
const hotSeatRoot = createRoot(hotSeatHost)
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
  await act(async () => { hotSeatRoot.render(React.createElement(React.Fragment, null, ...seats)) })
  await settle()
}
/** Both seats' current state: on the roster or not + drawn on screen or not, recorded per seat. */
const seatState = () => CLEAR_POINTS
  .map(({ word, key, probe }) => ({ word, registered: hot.ledger.has(key), drawn: probe(hotSeatHost) !== null }))
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
  settingsSaidZh.includes('默认标签页')
    && settingsSaidEn.includes('Default tab')
    && settingsSaidEn.includes('默认标签页') === false,
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
  fallbackSaid.includes('默认标签页'),
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
const CHROME_ZH = ['地图', '明细', '指令', '问题', '设置']
const CHROME_EN = ['Map', 'Detail', 'Instructions', 'Issues', 'Settings']
check(
  '面板骨架也跟着换：五个标签一套字换成另一套，英文那一边一个中文字都不留',
  CHROME_ZH.every((word) => chromeSaidZh.includes(word))
    && CHROME_EN.every((word) => chromeSaidEn.includes(word))
    && ['地图', '明细', '指令'].every((word) => chromeSaidEn.includes(word) === false),
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