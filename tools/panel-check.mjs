// 面板的自证夹具：真记录 → 真宿主半身 → 真面板，三样都在这一趟里跑。
// 每一项都印读数；控制台里出现 error 就是失败。
//
//   node tools/panel-check.mjs
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'

// React 在装载那一刻摸一次 window/document，摸不到就走它那条给 IE8/9 的老路（去叫
// `attachEvent`，在这个环境里必炸），所以它要等 jsdom 立好才进来。

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const work = join(root, '.tmp', 'panel-check')
const workspace = join(work, 'workspace')
const record = join(workspace, '.pf')
const sessionId = 'panel-check-session'
/** 第二份工作区：空的，`.pf` 都不建——「当前工作区没有 pathfinder 的记录」那一档的实景。 */
const emptyWorkspace = join(work, 'empty')
const emptySessionId = 'panel-check-empty'
/** 第三份工作区：`.pf` 与四份文件都在，但没有一份是可读的 JSON——「记录读不动」那一档的实景。 */
const brokenWorkspace = join(work, 'broken')
const brokenSessionId = 'panel-check-broken'
/** 第四份工作区：管线三份都在、问题池那一份不在——问题那一格收成一句话那一档的实景。 */
const bareWorkspace = join(work, 'bare')
const bareSessionId = 'panel-check-bare'
/** 第五份工作区：只有问题池（`pf issue scan` 在一个自己还没有管线的仓里写下的就是这份），
 * 管线三份都不在——看板收成一句话那一档的实景。 */
const poorWorkspace = join(work, 'poor')
const poorSessionId = 'panel-check-poor'

const failures = []
const lines = []
function check(what, ok, reading) {
  lines.push(`${ok ? 'ok  ' : 'FAIL'}  ${what}  ${reading}`)
  if (!ok) failures.push(what)
}

/* 取数那一趟的完成通知：每一次读都把那个 promise 交到这里，夹具等的是那些 promise 本身，
 * 不猜它多久回来。面板那一格也走这条口子。 */
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
 * 指令那一格该长哪几组：拿那一刻的记录现算一遍，次序照蓝本那一格的读者次序——全局在前，
 * 然后记录里那几条线，再是没认出范围的，最后一格；空组不画。
 */
function expectedNoteGroups(project, showArchived) {
  const groups = new Map()
  const hold = (key, label) => {
    if (!groups.has(key)) groups.set(key, { label, entries: [] })
    return groups.get(key)
  }
  hold('global', '全局')
  for (const cycle of project.cycles) hold(`cycle:${cycle.id}`, cycle.id)
  hold('cycle:', '未分组')
  hold('node', '这一格')
  for (const entry of project.instructions) {
    /* 已归档的条目默认收起来：设置里那一行打开之后才回到各自的段里。 */
    if (showArchived !== true && entry.standing !== true) continue
    const key = entry.scope === 'global'
      ? 'global'
      : entry.scope === 'cycle'
        ? (entry.cycleId === null ? 'cycle:' : `cycle:${entry.cycleId}`)
        : 'node'
    hold(key, key).entries.push(entry)
  }
  const order = ['global', ...[...groups.keys()].filter((key) => key.startsWith('cycle:') && key !== 'cycle:'), 'cycle:', 'node']
  return order
    .filter((key) => groups.get(key).entries.length > 0)
    .map((key) => ({
      label: groups.get(key).label,
      rows: groups.get(key).entries
        .slice()
        .sort((left, right) => ((left.inForce ? 0 : 1) - (right.inForce ? 0 : 1))
          || ((right.saidAt?.getTime() ?? 0) - (left.saidAt?.getTime() ?? 0)))
        .map((entry) => entry.text ?? ''),
    }))
}

/**
 * 产物那张表里最后落在某个元素上的声明，同一条属性按后到的胜：jsdom 不做级联，这里按 DOM
 * 逐个匹配再走一遍；带壳的规则（@media）往里走一层。
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

/* ---- 1. 一份可写的记录拷贝 ---------------------------------------------- */

/** 本仓那一份 `.pf` 的复制口。`.git` 一起搬：工具要认这个目录是它自己那一层记录库
 * （`pf` 会去核它）；`worktrees` 与各节点的 `temp` 是过程物，搬过来白费时间。 */
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
/* 读不动那一档：四份来源的文件都在（`.pf` 与 `.pf/issues` 都列得到），内容一份都不是可读
 * 的 JSON——真宿主半身读下来四份全报 `unusable`。 */
mkdirSync(join(brokenWorkspace, '.pf', 'issues'), { recursive: true })
for (const path of ['ideas.json', 'state.json', 'instructions.json', join('issues', 'issues.json')]) {
  writeFileSync(join(brokenWorkspace, '.pf', path), '这不是可读的 JSON 文本\n')
}
copyRecord(record)
check('记录拷贝就位', existsSync(join(record, 'instructions.json')), record.replace(root, '.'))

/* 这两档为「记录在，只是某一份来源里一条都没有」造底：一处拿走问题池那一份，一处只留它。
 * 两档都不是「没有记录」——`.pf` 都列得到，所以面板照旧画六格。 */
copyRecord(join(bareWorkspace, '.pf'))
rmSync(join(bareWorkspace, '.pf', 'issues', 'issues.json'), { force: true })
copyRecord(join(poorWorkspace, '.pf'))
for (const path of ['ideas.json', 'state.json', 'instructions.json']) {
  rmSync(join(poorWorkspace, '.pf', path), { force: true })
}

/** 一份记录当下的样子：两个新看法不落笔，靠它比一遍。 */
function recordDigest() {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory()
      ? walk(join(dir, entry.name))
      : [`${join(dir, entry.name).replace(record, '')}:${String(readFileSync(join(dir, entry.name)).length)}`]))
    .sort()
  return walk(record).join('\n')
}

/* ---- 2. 真宿主半身，写面经 pf 那条 CLI --------------------------------- */

const { PathfinderRecordsGateway } = await import(pathToFileURL(join(root, 'src', 'host', 'index.ts')).href)
const { runPf } = await import(pathToFileURL(join(root, 'src', 'host', 'write.ts')).href)
const { readProject, readSessions } = await import(pathToFileURL(join(root, 'src', 'model', 'index.ts')).href)

/** 起进程那一侧的最小替身：与宿主那份一样走 execFile，一样隐藏窗口。 */
function spawner() {
  /* 真部署里这条口子按名字解一次就记着；夹具这一趟要叫十几条命令，每条都去 `where`
   * 一遍是白花的。名字各记各的：`pf` 之外还有带原话那一次要用的解释器。 */
  const found = new Map()
  const whereIs = (command) => new Promise((resolve, reject) => {
    execFile('where', [command], { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error !== null) {
        reject(error)
        return
      }
      const hits = String(stdout).split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0)
      /* PATH 上那个同名的 sh 垫片排在 `.cmd` 前面，起得来的只有带可执行扩展名的那个。 */
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

/** 工作区文件口子的最小替身：按行分页，读的就是那趟记录所在的那个根。
 * 真口子是按会话身份解析路径的，所以这里也认 `scope.workspaceRoot`——两份记录各指各的根。 */
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

/* 会话身份与工作区的对应：真宿主由会话头里的 `cwd` 解析。 */
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
  /* 真宿主上这就是一条服务：同一个口子，每次问到的是同一份。 */
  get: (name) => (name === 'sessionPersistence' ? undefined : name === 'subprocess' ? hostProcesses : undefined),
  provide: () => undefined,
}

const gateway = new PathfinderRecordsGateway(hostCtx)

/* 装好的远程命名空间长什么样：每一次调用回的都是 `{ ok, value }` 那一副脸——生成的
 * 远程客户端就是这么折的，面板那一侧读的也是这一副。 */
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

/* ---- 3. 浏览器半身挂进 jsdom ------------------------------------------- */

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
  url: 'http://127.0.0.1/',
  pretendToBeVisual: true,
})
const { window } = dom
for (const name of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage', 'SVGElement', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true })
}
/* `navigator` 在 Node 上是个只有取值的属性，单独拿描述符盖一次。 */
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

/* 面板那一份样式表平时由 `Entry` 在露面那一趟挂进文档（`ensureStyle`）；夹具不走 Entry，
 * 所以照同一条路把**产物里那一份**挂上——下面量令牌落点，读的就是这份产物自己的表。 */
check('产物带着面板那一份样式表', typeof client.PANEL_CSS === 'string' && client.PANEL_CSS.length > 0, `css=${String(client.PANEL_CSS?.length ?? 0)} chars`)
const styleNode = window.document.createElement('style')
styleNode.textContent = client.PANEL_CSS
window.document.head.appendChild(styleNode)

const provided = {}

/* ---- 设置那一份文档：夹具自己造，形状与 `configForms` 交出来的那一份一致 ------------
 * 真部署里这一份由设置服务给；这里造一个同形状的替身，面板与设置页读的就是它，于是
 * 「翻一行、两边当场跟着变」这件事能在夹具里真的走一趟。 */

function fakeSettingsForm(initial) {
  let value = { ...initial }
  let revision = 1
  let refuse = false
  const listeners = new Set()
  return {
    document: () => value,
    getSnapshot: () => ({ status: 'ready', value, base: undefined, user: undefined, revision, writable: true }),
    /* 接在这份表单上的订阅者有几个：摘除器有没有被还回来，只看这个数。 */
    watching: () => listeners.size,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    mutate(ops, expected) {
      /* 修订号对不上就是拒绝：与真控制器同一口径，写回去的那一条路径也照真那份拼。 */
      if (refuse || (expected !== undefined && expected !== revision)) return Promise.resolve(false)
      for (const op of ops) if (op.op === 'set') value = { ...value, [op.path[0]]: op.value }
      revision += 1
      for (const listener of [...listeners]) listener()
      return Promise.resolve(true)
    },
    /* 这份文档一律不收改动：「两笔都不作数时不许静默」那一条靠它。 */
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

/* ---- 那条导航口子的替身 ------------------------------------------------------ */

/** 真部署里面板点卡走的是 `ctx.uiWorkspace.openSession`：口子在册，卡片才有去处。 */
const navigationFace = {
  openSession: () => undefined,
}

/**
 * 起一条浏览器半身：一个最小的插件上下文（`get` / `inject` / `effect` / `provide`）。
 *
 * `slots` 是按真协议写的替身：同一个 id 重复注册会抛，那正是要躲开的那一下。`reuse` 给的是
 * 同一份名册上再起一次——幂等那一条要两次注册落在同一本名册上才量得出来。
 * @param backend - 设置服务那一侧的替身。
 * @param into - `provide` 往哪个对象上落。
 * @param reuse - 可选的同一份名册与落点记录。
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
      /* 单座与列表认 `id`，按 key 分派的那一格认 `key`——真协议就是这么认人的。 */
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

/* 先按旧版那四个键把本地存储塞满，再看接上设置表单那一刻有没有把它们扫掉——先塞这一步让
 * 「扫整个 `dsh-pathfinder.` 前缀」那条判据对存量 origin 也真的成立。 */
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

/* 这一层登记三条：设置里那一节，加上调度中心那两处。中央栏那一格是 keyed：那本名册认
 * `key`，另外两条认 `id`。 */
const SEAT_ENTRIES = [
  { key: `${client.SECTION_SLOT}:${client.SETTINGS_NAMESPACE}`, order: client.SECTION_ORDER, word: '设置里那一节' },
  { key: `sidebar.panellist:${client.PANEL_ID}`, order: client.PANEL_ORDER, word: '侧栏那一项' },
  { key: `main:${client.PANEL_ID}`, order: undefined, word: '中央栏那一格' },
]
const rosterOf = (ledger) => [...ledger.entries()].map(([key, entry]) => ({ key, order: entry.options.order }))
/** 按钥匙排好：这三条各落在**不同**的槽位，谁先登记在 DSH 里没有语义（`order` 只在同一个
 * list 槽内部才有意义），所以下面两份名册只比「哪几条在册、各自什么 order」，不锁先后。 */
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
  booted.ledger.get(`sidebar.panellist:${client.PANEL_ID}`)?.options.label() === client.SEAT_LABEL
    && client.SEAT_LABEL === '调度中心'
    && booted.ledger.get(`main:${client.PANEL_ID}`)?.options.key === client.PANEL_ID,
  `label()=${String(booted.ledger.get(`sidebar.panellist:${client.PANEL_ID}`)?.options.label())} ｜ main key=${String(booted.ledger.get(`main:${client.PANEL_ID}`)?.options.key)}`,
)

/* 注册纪律那一节：同一本名册上再起一条插件（profile 重载、HMR 都会走到这里），注册必须是
 * 幂等的。`slots.register` 碰到同一个 id 已经在册会抛，而那个抛落在槽位登记处的通知里，
 * React 自己的订阅也在那条通知上——页面上看不出事，鼠标键盘却全死了。 */
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

/* 同一条 effect 收掉再跑一遍（fiber 重入那一趟）：先撤上一次，再登记回来。收掉座席那一条，
 * 它自己那两条要跟着走、设置那一节要留着；收掉接设置表单那一条，接在上面的订阅者要还回去。 */
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

/* ---- 4. 画出来，逐个看法点开 ------------------------------------------- */

const container = window.document.getElementById('app')
const reactRoot = createRoot(container)

/* 写面被叫过几次：几个新看法一遍点下来，这一次数必须停在原地。 */
const writeCalls = []
/** 面板向宿主问过哪些根：顶上那枚工作区选择器挑中的那一个就从这儿看得见。 */
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
/** 等这一趟的面板动作走完：写完了它还会再读一次，所以一直等到没有在飞的东西。 */
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

/* 撑满跟着记号走：当前不撑满，明细那一格撑满。 */
await act(async () => { tabs[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const frameNow = container.querySelector('#frame')
check('当前那一格不撑满', frameNow.classList.contains('is-fill') === false, `class=${frameNow.className}`)
await act(async () => { tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('明细那一格撑满', container.querySelector('#frame').classList.contains('is-fill') === true, 'is-fill')

/* 当前那一格的读数与记录对得上：四枚胶囊的数与三列卡片的张数，逐项跟那份记录现算出来的读数比。
 * 这里不能用「格子里有字」那类断言——#pane-now 里那三个静态列头就够让它成立，跟记录里的数无关。 */
await act(async () => { tabs[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const reading = await gateway.read(sessionId, '', {})
const project = readProject({ nodes: reading.nodes, cycles: reading.cycles, instructions: reading.instructions, issues: reading.issues, at: new Date() })
lines.push(`      记录里的读数：${JSON.stringify(reading.sources)}`)
/* 这一趟没动过「每列几张卡」那一档：默认停在「展开」，每列最多三张。 */
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

/* 会话笔记：宿主半身把那一层目录原样搬回来，「每一格该去哪条会话」由模型层对着它读。夹具对着
 * 拷来的那份记录自己现算一遍，跟「搬数 → 读数」这条链对账——键是文件名剥掉后缀，一格开过
 * 好几条时取时刻最新的那条，同时刻跑的那条压过讨论的那条。 */
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

/* ---- 3c. 调度中心那两处：真产物挂上去，各露一面 --------------------------
 *
 * 侧栏那一项与中央栏那一格，两处注册的组件各按真形状渲染一遍——前者画一枚图标，后者就是
 * 面板本体（它向宿主问哪条会话，就画哪个工作区的记录）。座席标准 props 里的 `useSessions`
 * 是一条带投影的 hook：`ids` 是宿主清单次序（第一行是另一条会话）、`byId` 里当前会话那条挂
 * 着 `retainedBy.mainView`。两处座席挑会话挑对没有，`seatReads` 那一笔看得见。
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
/** 两处座席交给宿主口子的会话身份，按次序记一笔。 */
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

/* 空记录的工作区那一档：`.pf` 都不建，取数成功、四份来源全 `missing`。面板正文收成一句
 * 话，标签、右上那排计数与那六格一起收走（测试床那份合成工作区就是这种情形）。 */
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

/* 记录读不动那一档：`.pf` 在、四份文件也在，但没有一份解得出内容（四份来源全 `unusable`）。
 * 面板正文摆的是**另一句**——与上面那一档的「没有记录」不是同一件事。 */
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

/* 管线在、问题池空那一档：五个跟节点走的格子照旧（看板有卡、设置那一格摆的是控件），问题那一格
 * 收成一句「当前工作区尚未启用 Pathfinder」——它只跟问题那一份走。 */
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

/* 只有问题池那一档（`pf issue scan` 在一个自己还没有管线的仓里写下的就是这份）：五个跟节点走的
 * 格子各自收成同一句话，页头那排计数也不再报三个 0；问题那一格特派——它照旧画那个池子，条目一
 * 条不少。 */
const poorHost = window.document.createElement('div')
window.document.body.appendChild(poorHost)
const poorRoot = createRoot(poorHost)
await act(async () => {
  poorRoot.render(React.createElement(panel.Panel, { port: trackedPort, sessionId: poorSessionId, prefs: panel.prefs }))
})
await settle()
const poorSaid = ['now', 'detail', 'wires', 'notes', 'config']
  .map((id) => flat(poorHost.querySelector(`#pane-${id} .pf-innone`)))
const poorIssues = poorHost.querySelectorAll('#pane-issue .pf-row[data-issue]').length
check(
  '只有问题池的工作区：五个跟节点走的格子各自收成同一句话，问题那一格照旧画池子',
  poorHost.querySelector('.pf-none') === null
    && poorSaid.every((said) => said === '当前工作区尚未启用 Pathfinder。')
    && poorHost.querySelectorAll('.pf-tabs').length === 1
    && poorHost.querySelectorAll('.pf-pane').length === 6
    && poorHost.querySelector('#pane-now .pf-boardbar') === null
    && poorHost.querySelector('#census') === null
    && poorHost.querySelector('#pane-issue .pf-innone') === null
    && poorIssues > 0,
  `工作区=${poorWorkspace.replace(root, '.')}（只有问题池） ｜ 五格=${JSON.stringify(poorSaid)} ｜ 页头计数 ${String(poorHost.querySelectorAll('#census').length)} 处、六格 ${String(poorHost.querySelectorAll('.pf-pane').length)} 格 ｜ 问题那一格 ${String(poorIssues)} 条`,
)

/* 只剩一句话的那几格：模块撑满地界。不撑满时舞台把模块上下居中，那句话就漂在当中、还比页头那
 * 条左缘右一步（1400 宽的窗口里量过：左缘右 300px、标签线下 317px）；撑满之后它落在这一格自己
 * 的左上角，与另外五格同一处。jsdom 不排版，这里量的是那枚记号。 */
const poorFrame = poorHost.querySelector('#frame')
check(
  '只剩一句话的那几格：模块撑满地界（那句话因此落在这一格自己的左上角）',
  poorFrame !== null && poorFrame.classList.contains('is-fill'),
  `模块 class=${JSON.stringify(poorFrame?.className ?? null)}`,
)

/* 读得回来的那一份照旧：标签、计数与六格都在，正文里没有那句话。 */
check(
  '这一份记录读得回来：六格标签、右上那排计数与六格正文照旧画着，正文里没有那句话',
  tabs.length === 6 && container.querySelector('.pf-count') !== null
    && container.querySelectorAll('.pf-pane').length === 6
    && container.querySelector('.pf-none') === null,
  `标签 ${String(tabs.length)} 枚 ｜ 计数 ${String(container.querySelectorAll('.pf-count').length)} 处 ｜ 六格 ${String(container.querySelectorAll('.pf-pane').length)} 格 ｜ .pf-none ${container.querySelector('.pf-none') === null ? '（没有）' : '画了出来'}`,
)

/* ---- 3d. 顶上那枚工作区选择器：挑哪一个就读哪一个 ------------------------
 *
 * 名单照 DSH 那份清单来（标题 + 末尾那一档「未分组」）、默认停在这条会话落在的那个桶、
 * 换一档就把那个根递给宿主，而那个根读出来的东西当场换到屏上。换的那几档递出去的是绝对
 * 路径（`askedRoots` 逐档比）；「未分组」不是哪个根，分两支（afb7ca0 定的契约）：会话
 * 落在某个桶里时一趟读数都不发，面板收成「未分组名下没有记录」那一句，选择器留着；
 * 会话谁的桶都不在时，它就归「未分组」那一堆，递空字符串照旧读它自己那个根。
 */
const spaceItems = [
  { workspaceId: 'w-main', path: workspace, title: '主工作区', sessionIds: [sessionId] },
  { workspaceId: 'w-empty', path: emptyWorkspace, title: '空工作区', sessionIds: [emptySessionId] },
  { workspaceId: 'w-broken', path: brokenWorkspace, title: '读不动的工作区', sessionIds: [brokenSessionId] },
]
/* 快照必须是同一个对象：`getSnapshot` 每次现拼一份新的，React 会当成一直在变。 */
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

/* 这两条收在页头那一枚上：`.pf-pick` 不止一处（指令那一格那枚范围字段与它是同一个对象），
   不收窄就会把那一枚的候选一起算进工作区名单里。 */
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

/* 真在所有工作区之外的会话那一支：同一份清单，只是哪个桶都不收这条会话——DSH 把它归到
 * 「未分组」，默认就停在那儿。afb7ca0 正文里「照旧读自己那个根」说的就是这一支。 */
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

/* 拨去别处再拨回「未分组」也是同一支：pickedSpace 摆到 null 而这条会话没有归属，读数照发——
 * 收成一句话的那一支只落在有归属的会话上（上一趟）。 */
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

/* 产物那份 css 里九个 `--pf-*` 的声明点，按面板 DOM 上解析出来的值量：声明落在
 * `.pf-page body` / `.pf-page :root` 这类匹配不到任何元素的选择器上时，这里读出来就是空串
 * ——`var(--pf-ink-2)` 那几处没有兜底的读法会跟着作废。
 *
 * 同一条尺子还管着 `mock/tokens.css` 那条 reset 的 `box-sizing`：它在蓝本里写在 `*` 上，
 * 收拢成 `.pf-page *` 时面板根自己就落空了，代价是底下多出 24px。 */
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

/* 蓝本那一页末位的 settings.css 不进包，但它里面与设置页版面无关的两条（舞台与框）在蓝本上
 * 是生效的：这里按 DOM 匹配走一遍，看落在 `.pf-stage` / `.pf-frame` 上的最后一条声明是哪一份。 */
const stageWon = winningDeclarations(container.querySelector('.pf-stage'), ['padding', 'align-items', 'height'])
const frameWon = winningDeclarations(container.querySelector('.pf-frame'), ['width', 'max-height', 'min-height'])
const carriedOk = stageWon.padding === '20px 0' && stageWon['align-items'] === 'center' && stageWon.height === '100%'
  && frameWon.width === 'var(--pf-frame-w, 800px)' && frameWon['max-height'] === '100%' && frameWon['min-height'] === '0'
check(
  '舞台与框在蓝本里的有效值进了包',
  carriedOk,
  `stage padding=${JSON.stringify(stageWon.padding)} align-items=${JSON.stringify(stageWon['align-items'])} height=${JSON.stringify(stageWon.height)} ｜ frame width=${JSON.stringify(frameWon.width)} max-height=${JSON.stringify(frameWon['max-height'])} min-height=${JSON.stringify(frameWon['min-height'])}`,
)

/* ---- 3b. 产物与 mock/ 的等价性：逐表逐条对一遍 ---------------------------
 * 上面两条读数是点状的，点不到「某一组规则整条不见了」。这里补一条整体尺子：进包的 css 是
 * `mock/` 那几张表的机械改写（只重写选择器，声明一个字节不动），所以逐表逐条比得出来——
 * 套着它的那几层 at-rule、选择器、声明正文三样都要对得上；差额只允许是明写取进来的
 * `CARRIED` 那几条。
 *
 * 尺子自己写一份表清单与一份收拢映射，不 import 构建口那一份：拿被测方自己的算法算期望值，
 * 尺子就等于没量。规范化：两边都摘掉注释、把连续空白折成一个空格、去掉首尾空白；声明次序
 * 照原样比，不排序——CSS 里次序有意义。
 */
const SHEETS = [
  { sheet: 'tokens.css', scope: pageLayer('.pf-page') },
  { sheet: 'styles/main.css', scope: pageLayer('.pf-page') },
  { sheet: 'styles/board.css', scope: pageLayer('.pf-page') },
  { sheet: 'styles/lines.css', scope: pageLayer('.pf-page') },
  { sheet: 'styles/detail.css', scope: pageLayer('.pf-page') },
  { sheet: 'styles/notes.css', scope: pageLayer('.pf-page') },
  /* 依赖与问题那两张表在蓝本里各自是一份独立文档，靠 `.is-embed` 把页头与页边距让给宿主；
     进面板之后各挂各的页记号（面板里那两格 `.pf-pane`）：前缀是这一格的页记号，表里那枚让位
     记号连页记号一起带上——两处高低差都得留住，一处管顶上那一段，一处管与面板同名的那些规矩。 */
  { sheet: 'styles/field.css', scope: embedLayer('.pf-wires') },
  { sheet: 'styles/register.css', scope: embedLayer('.pf-issue') },
]
const CARRIED = [{
  sheet: 'styles/settings.css',
  selectors: ['.pf-stage', '.pf-frame', '.pf-configwrap', '.pf-configwrap .pf-scroll', '.pf-config', '.pf-config .pf-setrow', '.pf-vlayer'],
}]
const SCOPE = pageLayer('.pf-page')
const PAGE_ROOTS = new Set([':root', 'html', 'body'])

function closingBrace(css, open) {
  let depth = 1
  let k = open + 1
  while (k < css.length && depth > 0) {
    if (css[k] === '{') depth += 1
    else if (css[k] === '}') depth -= 1
    if (depth === 0) break
    k += 1
  }
  return k
}

function normalize(text) {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\s+/gu, ' ').trim()
}

/** 把一份 css 拆成规则清单：每条记下套着它的那几层 at-rule、选择器、声明正文。
 * 带壳的（`@media` / `@supports` / `@layer`）往里走一层；`@keyframes` 这类整块算一条。 */
function ruleEntries(css, wrap = []) {
  const out = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) break
    const close = closingBrace(css, open)
    const prelude = normalize(css.slice(i, open))
    const body = css.slice(open + 1, close)
    if (prelude.startsWith('@media') || prelude.startsWith('@supports') || prelude.startsWith('@layer')) {
      out.push(...ruleEntries(body, [...wrap, prelude]))
    } else if (prelude.length > 0) {
      out.push({ wrap, prelude, body: normalize(body) })
    }
    i = close + 1
  }
  return out
}

/** 「这一段已经收进那一层了」——切段之后逐段比，不看子串（`.pf-pagewrap` 不算）。 */
function alreadyScoped(part, className) {
  return part
    .split(/[\s>+~]+/u)
    .flatMap((segment) => segment.split(/[.#:[\]]/u))
    .some((token) => token === className)
}

/** 这一段选择器进包之后该长成哪几段——这张表与构建口各写一份，不 import 它那一份。 */
function expectedPart(part, scope) {
  const low = part.toLowerCase()
  /* 表里自己写着「嵌入」那枚记号的：换成「这一枚 + 这一格的页记号」，把它比基础规则高的一档
     一起带上，同时只落在这一格上。 */
  if (scope.marker !== undefined && alreadyScoped(part, scope.marker)) {
    return [part.replace(new RegExp(`\\.${scope.marker}(?![\\w-])`, 'gu'), `.${scope.marker}${scope.root}`)]
  }
  if (alreadyScoped(part, scope.root.slice(1))) return [part]
  if (low === '*') return [scope.root, `${scope.root} *`]
  if (low.startsWith('*::')) return [`${scope.root}${part.slice(1)}`, `${scope.root} ${part}`]
  if (PAGE_ROOTS.has(low)) return [scope.root]
  return [`${scope.add} ${part}`]
}

/** 主面板那一层：只加前缀。 */
function pageLayer(root) { return { root, add: root } }

/** 嵌入那两格那一层：前缀是这一格的页记号，表里的嵌入记号连它一起带上（高一档）。 */
function embedLayer(root) { return { root, add: root, marker: 'is-embed' } }

function expectedPrelude(prelude, scope) {
  const parts = prelude
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .flatMap((part) => expectedPart(part, scope))
  return [...new Set(parts)].join(', ')
}

/** 蓝本那一侧算出来的期望样子：`@keyframes` 这类整块原样带走。 */
function expectedOf(entry, scope) {
  return {
    wrap: entry.wrap,
    prelude: entry.prelude.startsWith('@') ? entry.prelude : expectedPrelude(entry.prelude, scope),
    body: entry.body,
  }
}

function diffOf(want, got) {
  if (got === undefined) return `期望 ${JSON.stringify(want.prelude)}（${want.body.slice(0, 40)}）｜ 产物里没有这一条`
  const same = got.prelude === want.prelude
    && got.body === want.body
    && JSON.stringify(got.wrap) === JSON.stringify(want.wrap)
  if (same) return ''
  const at = JSON.stringify(got.wrap) === JSON.stringify(want.wrap) ? '' : `（套着的 at-rule 不同：期望 ${want.wrap.join(' ')}｜产物 ${got.wrap.join(' ')}）`
  return `期望 ${JSON.stringify(want.prelude)}{${want.body.slice(0, 56)}} ｜ 产物 ${JSON.stringify(got.prelude)}{${got.body.slice(0, 56)}}${at}`
}

function firstMismatch(expected, got) {
  for (const [index, want] of expected.entries()) {
    const reading = diffOf(want, got[index])
    if (reading !== '') return { index, reading }
  }
  return null
}

const productEntries = ruleEntries(client.PANEL_CSS)
let cursor = 0
for (const { sheet, scope } of SHEETS) {
  const expected = ruleEntries(readFileSync(join(root, 'mock', sheet), 'utf8')).map((entry) => expectedOf(entry, scope))
  const got = productEntries.slice(cursor, cursor + expected.length)
  cursor += expected.length
  const bad = firstMismatch(expected, got)
  check(
    `产物里 ${sheet} 那一份与 mock/ 逐条等价（选择器 + 声明正文）`,
    bad === null,
    bad === null
      ? `${String(expected.length)} 条对上`
      : `第 ${String(bad.index + 1)}/${String(expected.length)} 条起对不上：${bad.reading}`,
  )
}
const carriedWanted = CARRIED.flatMap(({ sheet, selectors }) => {
  const wanted = new Set(selectors)
  return ruleEntries(readFileSync(join(root, 'mock', sheet), 'utf8')).flatMap((entry) => {
    const kept = entry.prelude.split(',').map((part) => part.trim()).filter((part) => wanted.has(part))
    return kept.length > 0 ? [expectedOf({ ...entry, prelude: [...new Set(kept)].join(', ') }, SCOPE)] : []
  })
})
const carriedGot = productEntries.slice(cursor, cursor + carriedWanted.length)
cursor += carriedWanted.length
const carriedBad = firstMismatch(carriedWanted, carriedGot)
check(
  '整张 settings.css 不进包，只按明写取进来的那几条（舞台、框、设置那一列的版面）与 mock/ 逐条等价',
  carriedBad === null && carriedWanted.length === CARRIED[0].selectors.length,
  `${String(carriedWanted.length)} 条对上 ｜ ${carriedBad === null ? '逐条相等' : carriedBad.reading}`,
)
check(
  '产物里除了 mock/ 那几张表与明写的 CARRIED，没有别的规则',
  cursor === productEntries.length,
  `产物 ${String(productEntries.length)} 条 ｜ 八张表 + CARRIED 算出来 ${String(cursor)} 条`,
)
lines.push(`      等价性：mock/ 那 ${String(SHEETS.length)} 张表 + CARRIED ${String(carriedWanted.length)} 条 → 产物 ${String(productEntries.length)} 条规则，逐条比选择器与声明正文（上面每张表一条读数）`)

/* ---- 3c. 落点：同一批规矩在产物里谁赢，蓝本那一侧要一样 -------------------
 * 3b 比的是字面（选择器与声明一条不差），比不出「同一条属性的两条规矩谁赢」。蓝本那两张嵌入
 * 表里有两处高低差，收拢时动到哪一处，读出来的东西就换一个样子：
 *
 * - 表里自己写的让位规矩（`.is-embed X`）比基础规则高一档——这一档丢了，顶上那一段留白回来；
 * - 这一页那份表与**面板那几张表**同名的那些元素（明细那一行的 `.pf-row`、主面板那个
 *   `.pf-head`），蓝本里各在各的文档、没有对手，进了面板靠「同档但排在后面」取胜——这一档
 *   被收拢改掉，问题池那一排的列宽就归明细那一行管。
 *
 * 所以这里量落点：把面板里那两格的子树原样搬进蓝本各自那份文档（页面根挂 `is-embed`、只挂它
 * 自己那一张表），同一条属性两边各走一遍级联，比最后谁赢。jsdom 不做级联、也不拆简写，两样
 * 都自己来。
 */
const SHORTHAND = {
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
}

/** 一条选择器的特异性：`::` 不算；`:where()` 里那一档记 0（产物里现在没有它，尺子留着这一条）。 */
function specificityOf(selector) {
  const bare = selector.replace(/:where\((?:[^()]|\([^()]*\))*\)/gu, '').replace(/::[\w-]+/gu, '')
  const ids = (bare.match(/#[\w-]+/gu) ?? []).length
  const classes = (bare.match(/\.[\w-]+/gu) ?? []).length
  const attrs = (bare.match(/\[[^\]]*\]/gu) ?? []).length
  const pseudos = (bare.match(/:(?!:)[\w-]+/gu) ?? []).length
  const tags = (bare.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/gu) ?? []).length
  return ids * 1e6 + (classes + attrs + pseudos) * 1e3 + tags
}

/** 一条声明拆成长写：cssom 把 `padding: 14px 0 16px` 原样留着，不替我们拆。 */
function longhandsOf(name, value) {
  const list = SHORTHAND[name]
  if (list === undefined) return [[name, value]]
  const parts = value.split(/\s+/u).filter((one) => one.length > 0)
  const four = parts.length === 1 ? [parts[0], parts[0], parts[0], parts[0]]
    : parts.length === 2 ? [parts[0], parts[1], parts[0], parts[1]]
      : parts.length === 3 ? [parts[0], parts[1], parts[2], parts[1]]
        : parts
  return four.length === 4 ? list.map((one, at) => [one, four[at]]) : [[name, value]]
}

/** 一份文档里落在某个元素上的最终声明：同一条属性按 (特异性, 次序) 取胜。 */
function cascadeWinner(win, element, properties) {
  const won = {}
  if (element === null) return won
  let order = 0
  const rules = [...win.document.styleSheets].flatMap((sheet) => [...(sheet.cssRules ?? [])])
  for (const rule of rules.flatMap((one) => (one.cssRules === undefined ? [one] : [...one.cssRules]))) {
    const selector = rule.selectorText
    if (selector === undefined) continue
    order += 1
    let hit = false
    try { hit = element.matches(selector) } catch { hit = false }
    if (!hit) continue
    const score = specificityOf(selector)
    for (let at = 0; at < rule.style.length; at += 1) {
      const name = rule.style[at]
      const value = (rule.style.getPropertyValue(name) ?? '').replace(/\s+/gu, ' ').trim()
      for (const [property, settled] of longhandsOf(name, value)) {
        if (!properties.includes(property)) continue
        const held = won[property]
        if (held === undefined || score > held.score || (score === held.score && order > held.order)) {
          won[property] = { value: settled, score, order }
        }
      }
    }
  }
  return won
}

/** 蓝本那一侧：这一页的子树放进它自己那份文档——页面根挂 `is-embed`，只挂它那一张表。 */
function blueprintWindow(pageRoot, sheet) {
  const css = readFileSync(join(root, 'mock', sheet), 'utf8')
  return new JSDOM(`<!doctype html><html class="is-embed"><head><style>${css}</style></head><body>${pageRoot.outerHTML}</body></html>`).window
}

/* 两档读数：顶上那一段（让位那两条压着基础规则）与页根那两条内边距（含两张表各管各的页）。 */
const EMBED_PROBES = [
  { pane: '#pane-issue', sheet: 'styles/register.css', group: '顶上那一段', at: '.pf-band', properties: ['padding-top'] },
  { pane: '#pane-wires', sheet: 'styles/field.css', group: '顶上那一段', at: '.pf-bar', properties: ['margin-top'] },
  { pane: '#pane-issue', sheet: 'styles/register.css', group: '页根那两条内边距', at: '.pf-page', properties: SHORTHAND.padding },
  { pane: '#pane-wires', sheet: 'styles/field.css', group: '页根那两条内边距', at: '.pf-page', properties: SHORTHAND.padding },
  /* 与面板那几张表同名的元素：蓝本里它们在各自的文档里没有对手，进了面板却要和明细那一行
     （`detail.css` 的 `.pf-row`）、主面板那个组头（`main.css` 的 `.pf-head`）争——这一页那份表
     靠「同档但排在后面」赢，这一档被收拢改掉，列宽与那道线就跟着换主人。 */
  { pane: '#pane-issue', sheet: 'styles/register.css', group: '同名规矩那一处', at: '.pf-register .pf-row', properties: ['grid-template-columns', 'column-gap', 'height', ...SHORTHAND.padding] },
  { pane: '#pane-issue', sheet: 'styles/register.css', group: '同名规矩那一处', at: '.pf-register .pf-head', properties: ['grid-template-columns', 'column-gap', 'align-items', 'padding-top'] },
]

const embedReadings = []
for (const probe of EMBED_PROBES) {
  const pageRoot = container.querySelector(`${probe.pane} > .pf-page`)
  /* 页根那一条量的是它自己：`querySelector` 只看后代，从它身上找不到它。 */
  const target = pageRoot === null ? null : (pageRoot.matches(probe.at) ? pageRoot : pageRoot.querySelector(probe.at))
  const blueprint = blueprintWindow(pageRoot ?? window.document.createElement('div'), probe.sheet)
  const product = cascadeWinner(window, target, probe.properties)
  const want = cascadeWinner(blueprint, blueprint.document.querySelector(probe.at), probe.properties)
  const rows = probe.properties.map((property) => {
    const got = product[property]?.value ?? '（没有规矩落在它身上）'
    const expected = want[property]?.value ?? '（没有规矩落在它身上）'
    return { group: probe.group, same: got === expected, text: `${probe.at} ${property}=${got}${got === expected ? '' : `（蓝本 ${expected}）`}` }
  })
  embedReadings.push(...rows)
}

for (const [group, what] of [
  ['顶上那一段', '嵌入那两格顶上那一段'],
  ['页根那两条内边距', '嵌入那两格的页根内边距'],
  ['同名规矩那一处', '嵌入那两格里与面板同名的那些规矩'],
]) {
  const rows = embedReadings.filter((one) => one.group === group)
  check(
    `${what}与蓝本落在同一处`,
    rows.length > 0 && rows.every((one) => one.same),
    rows.map((one) => one.text).join(' ｜ '),
  )
}

/* ---- 4a. 设置那一节：导航行 + 它打开的那一页，与面板读同一份设置表单 -----------
 * 这一节住在 DSH 自己的设置面板里，跟主面板不在一棵树上，所以这里把产物注册的那个组件单独
 * 挂进一份 DOM。判据是「翻一行，面板上对应的读数当场跟着变」。
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

/* 默认信息量：三档里翻到「精简」，面板上每列最多一张卡。收尾翻回「展开」，后面的读数
   与这一趟之前一致。 */
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

/* 默认标签页：从设置里挑「指令」，面板当场换到那一格。 */
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
/* 明细就是读者点进来要看的那几行：记录里写着标题的格，行上印的是那段标题；而且这一格一露面
 * 每一组都摊开着——折起来那一手由读者按下去。 */
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
/* 折起来那一手还在读者手上：按一下组头，那一组收起来、右边报出它有几格；再按一下又摊开。 */
const completedRowsWant = detailA.find((group) => group.label === '已交付')?.rows.length ?? 0
const completedHead = [...container.querySelectorAll('#pane-detail .pf-rowhead')]
  .find((head) => head.querySelector('.pf-rowhead-key')?.textContent === '已交付')
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
    && afterFold.every((group) => (group.label === '已交付' ? group.folded : group.folded === false))
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

  /* 归档这一下从面板那一枚按钮按下去：写面从界面一路走到工具，再读回来。 */
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

  /* 翻设置里「指令里显示已归档的」：归档的条目回到各自的段里，右边那枚动作是「复原」。 */
  await flipSwitch('指令里显示已归档的')
  check(
    '翻设置里「指令里显示已归档的」：已归档的当场回到页面上，右边那枚是复原',
    (notes()?.textContent ?? '').includes(live.text) === true
      && (rowOf()?.textContent ?? '').includes('已归档')
      && buttonOf(rowOf(), '复原') !== undefined
      && settingsDoc().showArchived === true,
    `那一行=${(rowOf()?.textContent ?? '（没有这一行）').slice(0, 48)} ｜ 文档里 showArchived=${String(settingsDoc().showArchived)}`,
  )

  /* 复原也是从界面上按：那一行现在摆的是「复原」。 */
  const reviveKey = buttonOf(rowOf(), '复原')
  check('归档之后那一行摆的是复原', reviveKey !== undefined, '复原')
  if (reviveKey !== undefined) await click(reviveKey)
  const revived = JSON.parse(readFileSync(join(record, 'instructions.json'), 'utf8')).instructions.find((entry) => entry.id === live.id)
  check('复原：它又回到 live', revived?.state === 'live', `state=${String(revived?.state)}`)
  check('复原之后面板上不再标已归档', (notes()?.textContent ?? '').includes('已归档') === false, '那一行回到了生效那一堆')
  /* 收尾把这一行翻回关上：后面几条读数与这一趟开始时同一档。 */
  await flipSwitch('指令里显示已归档的')
  check(
    '翻回关上：归档的收起来，文档里那一格也回到关着',
    settingsDoc().showArchived === false && (notes()?.textContent ?? '').includes('已归档') === false,
    `文档里 showArchived=${String(settingsDoc().showArchived)}`,
  )

  /* 删除：先让人看清那条原话，点第二下才动手。 */
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
  check('删除之后复原拿不回来', restore.ok === false, `revive=${restore.ok ? 'ok' : restore.text.split('\n')[0].slice(0, 60)}`)
}

/* 记下一条：从这一行里写一句进去——面板 → 宿主 → 工具 → 记录，再读回页面。
   挑全局那一项：这一条量的是那条路通不通，绑哪条线的读数另有一条在管。 */
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

/* 策略数：从线路设置那枚模态里改一个，读数跟着变。 */
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
    /* 三个策略数各写一次：同一个模态里那三行、同一条端点，成本就是三次回车。读数落在
     * **记录文件**上（`state.json` 里那三个键），面板自己回读的那一份不作数。 */
    const targets = [['parallel', 5], ['test_seconds_limit', 900], ['issue_pool_weight_limit', 7]]
    const wrote = []
    for (const [index, [key, target]] of targets.entries()) {
      const field = fields()[index]
      await act(async () => {
        field.focus()
        setValue.call(field, String(target))
        field.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      /* 那个框失焦或回车都算改完了：这里走回车那一路。 */
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

/* ---- 4b. 依赖那一格：层数、节点数、边数从记录里来；放大、抠出来看都真在动 -----
 * 这一份记录只有十几个格，所以这里管的是「读数对不对、看法动不动」；三位数那一档另有一趟
 * 探针（节点目录的 `temp/`）。 */

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

/** 这一节开动之前，写面被叫过几次、记录长什么样。 */
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

/* 抠出来看：双击一格，只留它自己、它欠的、欠它的。 */
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

/* ---- 4c. 问题那一格：登记簿的行、重量条画不画、以及自带的主从 ---------------- */

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
/* 反方向：上一段量的是「面板→文档」这一趟，这一条从设置里那一行翻，量「文档→面板」——
   翻到关，那一排当场回到「精简」、未解决之外的行从登记簿里退出去。 */
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
/* 再翻回来：非 open 的组按登记簿的既有设计折成堆（设计法「折叠不动版面」）。一堆折不折的
   契约在 pool.tsx 的 foldOf：先看手点没点过（folds 表，组件 state——翻档不重置），没点过
   再看选中落没落在这一堆，落入哪堆哪堆自动展开；选中的来源照 fallback 那半句：未解决的
   首条，清空时放下的三堆按 已承认→已解决→已驳回 取首条。这份夹具是活数据，未解决迟早
   清零，期望不许假设「完整档默认全折」——开合、行集合、条数全部从 project.pool 现算。 */
const stackedGroups = project.pool.groups.filter((group) => group.key !== 'open')
const foldButtons = () => [...(issuePane?.querySelectorAll('.pf-register .pf-fold') ?? [])]
const foldReadings = () => foldButtons().map((button) => [
  button.getAttribute('aria-expanded'),
  (button.textContent ?? '').replace(/\s+/gu, ' ').trim(),
])
const headLabels = () => [...(issuePane?.querySelectorAll('.pf-register .pf-head-label') ?? [])]
  .map((node) => node.textContent ?? '')
await flipSwitch('问题池里显示未解决之外的')
/* 选中这一刻落在哪一堆（pool.tsx 的 fallback：open 首条，清空时才轮到放下的三堆）。 */
const pickedGroupKey = (openGroup?.entries.length ?? 0) > 0
  ? 'open'
  : settingsDoc().showOtherStates !== true
    ? null
    : ['acknowledged', 'resolved', 'rejected']
      .map((key) => stackedGroups.find((group) => group.key === key))
      .find((group) => (group?.entries.length ?? 0) > 0)?.key ?? null
/** 一堆此刻该开着吗：folds 是夹具替组件记的那张手点桌（点一下翻一面，翻档不动它）。 */
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
    && JSON.stringify(headLabels()) === JSON.stringify(project.pool.groups.map((group) => group.label))
    && JSON.stringify(foldReadings()) === JSON.stringify(expectedFoldReadings({})),
  `面板上那一档=完整(${String(segPressed('完整'))}) ｜ 文档里 showOtherStates=${String(settingsDoc().showOtherStates)} ｜ 选中落在=${String(pickedGroupKey ?? '（无处）')} ｜ 行数=${String(issueRowIds().length)}（契约现算 ${String(expectedRowIds({}).length)} 条） ｜ 展开钮=${JSON.stringify(foldReadings())}（记录里非 open 的堆：${stackedGroups.map((group) => `${group.label} ${String(group.entries.length)} 条`).join('、') || '（没有）'}）`,
)
/* 点其中一堆的折堆钮：这一堆翻到与先前相反的一面，行集合与各堆开合跟着契约走。未解决有
   条目时那堆是折着的，这一下就是「点开」；未解决清了、选中落进放下的堆时，这一下点的就
   是「收起」——两种形态走同一条派生，不跳过任何一种。再翻到关，堆整个退出去——展开中
   的那堆也在内。 */
if (foldButtons()[0] !== undefined) {
  const clickedGroup = stackedGroups[0]
  const foldsAfterClick = { [clickedGroup.key]: !foldIsOpen({}, clickedGroup) }
  await click(foldButtons()[0])
  check(
    '点其中一堆的折堆钮：这一堆翻到相反的一面（该组行集合跟着开合现出或收起，身份从记录那一堆来），别的堆不受牵连',
    JSON.stringify(issueRowIds()) === JSON.stringify(expectedRowIds(foldsAfterClick))
      && JSON.stringify(foldReadings()) === JSON.stringify(expectedFoldReadings(foldsAfterClick)),
    `行数=${String(issueRowIds().length)}（未解决 ${String(openIds.length)} ＋ ${clickedGroup.label} ${String(clickedGroup.entries.length)}${foldIsOpen(foldsAfterClick, clickedGroup) ? '，这一堆现出' : '，这一堆收起'}） ｜ 展开钮=${JSON.stringify(foldReadings())}`,
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
  /* 收尾还原：翻回「完整」，把点过的那一堆翻回去——面板回到进这一节时的样子。展开状态跨
     翻档保留（folds 是组件 state，翻档不重置），还原那一下能收对靠的就是这条，这里钉住：
     还原后的开合与行集合照同一张 folds 桌现算——当前夹具下就是每堆 aria-expanded=false
     的全折样子；未解决清空的形态下则是选中那一堆照契约回到展开。 */
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

/* ---- 4d. 设置那一格：这个工作区自己的项目设置，读出来、就在这里改 --------------
 * 四行、三种控件、行尾一枚层签，照蓝本。两侧读数：一边是面板上摆出来的，一边是真工具对着
 * 同一份工作区印的那四行。改一处写回这个项目那一层，改完重读一遍——读数落在那份记录文件
 * （`workspace/.pf/config.json`）上，面板自己回读的那一份不作数。
 *
 * 非法值那两档：一个越界数字（数字框里真敲进去），一个不在候选表里的档位（下拉里塞一枚假的
 * 候选值再选它）。两趟都要落在「记录保持原值、界面回到原值」上。
 */

const { parseConfigList } = await import(pathToFileURL(join(root, 'src', 'host', 'project-config.ts')).href)
const listed = await runPf(hostCtx, workspace, ['config', 'list'], new AbortController().signal)
const truth = parseConfigList(listed.text)
/** 记录里那三个层名读作面板上那三个词（蓝本给的那一份说法）。 */
const LAYER_WORD = { default: '默认', project: '本项目', global: '全局' }
check(
  '设置那一格：真工具对着这份工作区印得出四行设置',
  listed.ok && Object.keys(truth).length === 4,
  listed.text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join(' ｜ '),
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

/* 每一行的控件各递一手：下拉与数字框走**原型上的 setter**（React 在节点自己身上记着上一次
 * 的值，直接写 `element.value` 会被它当成没变过），开-关那一枚点一下就行。 */
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

/* 写完四行：四个值都住在这个项目那一层，层签跟着真住处一起翻。 */
const shownAfter = configReadings(container)
const configNow = storedConfig()
check(
  '写完这四行：层签四枚全读作「本项目」（写的永远是这一层），值与记录里那四个值一致',
  shownAfter.length === 4 && shownAfter.every((row) => row.layer === '本项目')
    && shownAfter.every((row) => row.value === String(configNow[row.key])),
  `层签=${shownAfter.map((row) => `${row.key}=${row.layer}`).join(' ')} ｜ 面板上=${JSON.stringify(shownAfter.map((row) => row.value))} ｜ 记录里=${JSON.stringify(configNow)}`,
)

/* 非法值 1：越界数字。记录保持原值，框里回到原值，工具那句话落在面板底下那条提示行上。 */
const beforeIllegal = storedConfig()
await typeNumber(rowIn(container, 'max_agents'), '0')
check(
  '越界数字不落记录：记录保持原值，框里回到原值，提示行摆的是工具那句话',
  storedConfig().max_agents === beforeIllegal.max_agents
    && rowIn(container, 'max_agents').querySelector('input').value === String(beforeIllegal.max_agents)
    && noteLine().includes('正整数'),
  `记的是 0 ｜ 记录里=${String(storedConfig().max_agents)} 框里=${rowIn(container, 'max_agents').querySelector('input').value} 提示行=${noteLine() === '' ? '（空）' : noteLine()}`,
)

/* 非法值 2：不在候选表里的档位。下拉里塞一枚假的候选值再选它——真面板上点不出这一手。 */
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
  storedConfig().test_tier === beforeIllegal.test_tier
    && rowIn(container, 'test_tier').querySelector('select').value === beforeIllegal.test_tier
    && noteLine().includes('minimal'),
  `记的是 partial ｜ 记录里=${String(storedConfig().test_tier)} 下拉里=${rowIn(container, 'test_tier').querySelector('select').value} 提示行=${noteLine() === '' ? '（空）' : noteLine()}`,
)

/* 那一列的两枚把手：左右各一枚贴着列缘，拖一下改列宽，双击回默认。 */
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
/* 真拖一下：jsdom 没有指针捕获那三个方法，先补上桩（与明细那道缝同一套量法）。 */
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

/* 重开一份面板（同一份记录、同一条会话）：四行的读数与刚才那四个值还对得上。 */
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

/* ---- 5. 明细那道缝：真有入口，真拖得动，重开之后还在 -------------------- */

await act(async () => { tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const grip = container.querySelector('#detail-split')
check('明细有那道可拖的缝', grip !== null, `aria-valuenow=${String(grip?.getAttribute('aria-valuenow'))}`)

/* 判据 3 头一句是「拖得动」，先问那道缝在不在屏上：明细自带高度下限，它一露面 `#frame`
 * 就挂上 `is-fill`；进包那条规则若还按 `.pf-grip` 收，撑满时它连这道缝一起 `display:
 * none` 掉——那道缝只在明细露面时有用，等于一次也露不了面。这里读计算值。 */
const splitShown = grip === null ? '（没有这道缝）' : window.getComputedStyle(grip).display
const splitWon = grip === null ? {} : winningDeclarations(grip, ['display'])
check(
  '明细那道缝真的显形：计算出来的 display 没被哪条规则收掉',
  grip !== null && splitShown !== 'none',
  `display="${splitShown}" ｜ 最后落在它身上的规则=${splitWon.display === undefined ? '（没有规则设 display）' : `display: ${splitWon.display}`}`,
)

/* 再真的拖一下：jsdom 没有指针捕获那三个方法，先给这道缝补上桩，再 pointerdown →
 * pointermove → pointerup。读数落两处——缝上的 aria-valuenow 与设置文档，手写文档不算数。 */
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

/* ---- 6a-2. 写回被拒：控件不许静默弹回，那一节现有的提示行要说得出来 --------------
 * 手里那个修订号已经过期，宿主把这一笔拒掉，交回来的只是一个 `false`（理由吞在它自己
 * 那里），面板那几处 `void …write(…)` 又把它丢掉。这一条让这份文档一律拒收，再翻一次开关：
 * 两笔都不作数时那条提示行（`.pfset-msg`）上要摆出一句话。
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

/* 面板上那几样走的是同一条写回（`panel.tsx` 的 `keep`）：拒收时它现有的那条提示行也要说
 * 得出来，控件不许静默弹回。这一趟 `container` 上那一份已经收掉了，另起一份，读的还是同一
 * 份设置表单；按的是面板上真看得见的那一枚（标签那一排），台下的控件不按。 */
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
/* `.pf-innone` 那一类还兼着几处空态字幕，所以按那句话找，不按下标取。 */
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

/* ---- 6b. 同一份设置文档再挂一次：值还在，读数与刚才一致 --------------------
 * 真部署里「重启第二个实例」是另一个进程照同一份 `$DSH_HOME` 配置重新读一遍。夹具这一趟能
 * 到的最远处是：把刚才那份文档原样当作下一份文档的起点，重新走一遍 `apply`（新的上下文、
 * 新的注册名册、新的设置口子），再看新挂上来的面板与设置页读出来的是不是那几个值。
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

/* ---- 6c. 浏览器本地存储：面板自己的键一个都没有 --------------------------- */

const localKeys = []
try {
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index)
    if (key !== null) localKeys.push(key)
  }
} catch (error) {
  /* 读不出来就是空的：这一条判的是「有没有面板自己的键」，读不出来也一样没有。 */
}
const mine = localKeys.filter((key) => key.startsWith('dsh-pathfinder.'))
const seededLeft = localKeys.filter((key) => LEGACY_SEEDED.includes(key)).length
check(
  '浏览器本地存储里面板自己的键一个都没有',
  mine.length === 0,
  `本地存储 ${String(localKeys.length)} 个键${localKeys.length === 0 ? '' : `：${localKeys.join(', ')}`} ｜ 面板自己的 ${String(mine.length)} 个 ｜ 夹具先塞的 ${String(LEGACY_SEEDED.length)} 个旧键剩 ${String(seededLeft)} 个`,
)

/* ---- 6d. 卸载那一趟：停插件之后，两处都不留东西 --------------------------
 * 另起一条插件（新名册、新落点、自己的 effect），把两处经真代码渲染一遍——两张样式表由
 * 渲染那条路挂上，再把它那几条 effect 全收掉：名册清空，两张标签从文档里摘干净。
 *
 * 清理那一趟的次序（先撤注册再摘样式）写在 `mount.ts` 的清理那一段里；这里与单测都只量
 * 终局——判定 2 要的是「都不留东西」，没有一条要求次序。 */

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

/* ---- 6e. 热更新那一趟：装 → 卸 → 再装，三处清场点逐处给正面读数 -----------
 * 6d 量的是终局；这一节把「侧栏项 / 中央栏那一格 / 两张注入的样式标签」这三处逐处摆出正面
 * 读数，并多走一趟热更新：卸干净之后再装回来，三处各回到原样、且没有重复登记。
 *
 * 座席那一面不走真 slots 渲染器（那个住在 DSH 外壳里）；这里用一个最小的渲染器代替，它只做
 * 真渲染器做的那一件事——照名册当下有什么就画什么。于是「注册撤了，屏上就没东西」这件事
 * 有读数。两处座席都指空工作区那条会话：那一档面板正文摆着那句话，画得出来就是一行
 * `.pf-page`。 */

const CLEAR_POINTS = [
  { word: '侧栏项', key: `sidebar.panellist:${client.PANEL_ID}`, probe: (host) => host.querySelector('svg') },
  { word: '中央栏那一格', key: `main:${client.PANEL_ID}`, probe: (host) => host.querySelector('.pf-page') },
]

const hot = { ledger: new Map(), calls: [], effects: [] }
const hotBoot = bootClient(backend, {}, hot)
const hotBoardHost = window.document.createElement('div')
window.document.body.appendChild(hotBoardHost)
const hotBoardRoot = createRoot(hotBoardHost)
/** 照名册当下有什么就画什么：真渲染器那一条读法的最小替身。 */
const paintSeats = async () => {
  const seats = []
  for (const { key } of CLEAR_POINTS) {
    const entry = hot.ledger.get(key)
    if (entry === undefined) continue
    const given = typeof entry.options.inject === 'function' ? entry.options.inject() : {}
    /* 中央栏那一格那条取数口子换成夹具追踪过的那一份：`settle()` 等得到它。 */
    const port = given.port === undefined ? {} : { port: trackedPort }
    seats.push(React.createElement(entry.component, {
      ...given, ...port, size: 16, wide: true, useSessions: sessionsAt(emptySessionId),
    }))
  }
  await act(async () => { hotBoardRoot.render(React.createElement(React.Fragment, null, ...seats)) })
  await settle()
}
/** 两处座席当下的样子：名册里在不在 + 屏上画没画出来，逐处一笔。 */
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
/** 露一次面：面板本体（`Entry`，两张样式表由它那一路挂上）与设置里那一页。 */
const showPanel = async () => {
  const section = hot.ledger.get(`${client.SECTION_SLOT}:${client.SETTINGS_NAMESPACE}`)
  await act(async () => {
    hotPanelRoot.render(React.createElement(hotBoot.panel.Panel, { port: trackedPort, sessionId, prefs: hotBoot.panel.prefs }))
    hotSectionRoot.render(React.createElement(section.component, section.options.inject()))
  })
  await settle()
}

/* 装：三条在册，三处清场点各就各位。 */
await showPanel()
await paintSeats()
const hotLoaded = seatState()
check(
  '热更新·装：三处清场点各就各位（两处座席在册且画得出来 ＋ 两张注入的标签在文档里）',
  hot.ledger.size === 3 && allSeats(hotLoaded, true)
    && tagOf(client.PANEL_STYLE_ID) !== null && tagOf(client.SETTINGS_STYLE_ID) !== null,
  `名册 ${String(hot.ledger.size)} 条 ｜ ${seatReport(hotLoaded)} ｜ ${styleReport()}`,
)

/* 卸：两处座席从名册上撤下来，渲染器那一头跟着画不出东西；两张标签从文档里摘掉。 */
await act(async () => { hotPanelRoot.unmount(); hotSectionRoot.unmount() })
for (const one of hot.effects) one.off()
await paintSeats()
const hotUnloaded = seatState()
check(
  '热更新·卸：三处清场点各自清干净（两处座席不在册且屏上没了 ＋ 两张注入的标签都摘掉）',
  hot.ledger.size === 0 && allSeats(hotUnloaded, false) && stylesGone(),
  `名册 ${String(hot.ledger.size)} 条 ｜ ${seatReport(hotUnloaded)} ｜ ${styleReport()}`,
)

/* 再装（热更新）：同一条插件再走一遍，落在**同一本名册**上——三条回来、没有重复，
 * 三处清场点各回到原样。 */
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

/* ---- 7. 控制台 ---------------------------------------------------------- */

check('控制台没有 error', consoleErrors.length === 0, consoleErrors.length === 0 ? '0 条' : consoleErrors.join(' | '))

/* ---- 读数落文件 --------------------------------------------------------- */

const report = lines.join('\n')
writeFileSync(join(work, 'panel-check.txt'), `${report}\n`)
console.log(report)
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${String(lines.filter((line) => line.startsWith('ok  ')).length)} passed, ${String(failures.length)} failed`)
process.exit(failures.length === 0 ? 0 : 1)