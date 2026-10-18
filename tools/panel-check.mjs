// 面板的自证夹具：真记录 → 真宿主半身 → 真面板，三样都在这一趟里跑。
//
// 一趟做的事：
//   1. 把本仓 `.pf` 复制成一份**可写的临时工作区**（`.tmp/panel-check/workspace`，
//      本仓的 `.pf` 一个字节都不动），合成一条会话指到它。
//   2. 用真宿主半身（`src/host/gateway.ts`）读那份记录——写面也走它，命令经
//      `pf` 那条 CLI 落笔（这一层自己起进程，隐藏窗口）。
//   3. 把 `lib/client.js`（构建出来的浏览器半身）挂进 jsdom，接上这一份读数，
//      逐个看法地点开、点一次写面、再重开一次读数。
//   4. 每一项都印读数；控制台里出现 error 就是失败。
//
// 另有一趟：把同一份记录再复制一份，经真工具造出「一个出局等人的格 + 第二条线路」
// ——「`等待处理`只在真有出局等人的时候出现」与「换一条线路时右侧清单跟着换」这两条
// 判据要两份记录对照，本仓这一份里没有那样的格、也只有一条线。
//
//   node tools/panel-check.mjs
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'

// React 在**装载那一刻**摸一次 window/document，摸不到就走它那条给 IE8/9 的老路
// （那条路会去叫 `attachEvent`，在这个环境里必炸）。所以它不能跟别的 import 一起
// 摆在文件头上：先把 jsdom 立起来，再把它请进来。

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const work = join(root, '.tmp', 'panel-check')
const workspace = join(work, 'workspace')
const record = join(workspace, '.pf')
const sessionId = 'panel-check-session'
/** 第二趟那份记录（多一条线、一个出局等人的格）落在哪儿、由哪条会话指着。 */
const parkedWorkspace = join(work, 'parked')
const parkedRecord = join(parkedWorkspace, '.pf')
const parkedSessionId = 'panel-check-parked'
/** 第三份工作区：空的，`.pf` 都不建——「这个工作区里没有记录」那一档的实景。 */
const emptyWorkspace = join(work, 'empty')
const emptySessionId = 'panel-check-empty'
/** 第四份工作区：`.pf` 与四份文件都在，但没有一份是可读的 JSON——「记录读不动」那一档的实景。 */
const brokenWorkspace = join(work, 'broken')
const brokenSessionId = 'panel-check-broken'

const failures = []
const lines = []
function check(what, ok, reading) {
  lines.push(`${ok ? 'ok  ' : 'FAIL'}  ${what}  ${reading}`)
  if (!ok) failures.push(what)
}

/* 取数那一趟的完成通知：每一次读都把那个 promise 交到这里，夹具等的是**那些** promise
 * 本身，不猜它多久回来。调度中心那两处座席也走这条口子，所以下面那份远程替身也交一份
 * ——面板读一趟、页脚徽标与浮层共用一趟，全都等得到。 */
const inFlight = []
const track = (promise) => {
  inFlight.push(promise.catch(() => undefined))
  return promise
}

/** 明细那一格的读数：每组的组头，以及它下面那些行的 id。 */
function detailReadings(scope) {
  return [...scope.querySelectorAll('#pane-detail .pf-sec')].map((section) => ({
    label: section.querySelector('.pf-rowhead-key')?.textContent ?? '',
    rows: [...section.querySelectorAll('.pf-row')].map((row) => row.querySelector('.pf-rowtitle')?.textContent ?? ''),
  }))
}

/**
 * 指令那一格该长哪几组：拿那一刻的记录现算一遍。次序照蓝本那一格的读者次序——全局在前，
 * 然后记录里那几条线，再是没认出范围的，最后一格；组内还算数的在前、新说的在前；空组不画。
 * 与面板印出来的组头、各组下面那几条正文逐项比。
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
 * 产物那张表里最后落在某个元素上的那几条声明：同一条属性按后到的胜。
 * jsdom 不做标准属性的级联，这里按 DOM 逐个匹配再走一遍；带壳的规则（@media）往里走一层。
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

/** 一份记录当下的样子：每份文件的路径与字节数。两个新看法不落笔，靠它比一遍。 */
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
const { readProject } = await import(pathToFileURL(join(root, 'src', 'model', 'index.ts')).href)

/** 起进程那一侧的最小替身：与宿主那份一样走 execFile，一样隐藏窗口。 */
function spawner() {
  let foundExecutable = null
  return {
    async resolveExecutable(command) {
      /* 真部署里这条口子按 PATH 解一次就记着；夹具这一趟要叫十几条命令，每条都去 `where`
       * 一遍是白花的。解出来的那个名字一次就够。 */
      if (foundExecutable === null) {
        foundExecutable = await new Promise((resolve, reject) => {
          execFile('where', [command], { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
            if (error !== null) {
              reject(error)
              return
            }
            const found = String(stdout).split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0)
            /* PATH 上那个同名的 sh 垫片排在 `.cmd` 前面，两者都不是这里要的那一个：
             * 起得来的只有带可执行扩展名的那个。 */
            const runnable = found.find((line) => /\.(cmd|exe|bat|com)$/iu.test(line))
            resolve(runnable ?? found[0] ?? command)
          })
        })
      }
      return foundExecutable
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

/* 会话身份与工作区的对应：真宿主由会话头里的 `cwd` 解析（`workspaceRootOf` 那条路）。
 * 前四条是这一趟合成的那四条会话；后面那一段（点卡切会话）会给记录里读出来的会话补上
 * 落点——补一条会话就是补一句「它开在这个工作区里」。 */
const sessionWorkspaces = new Map([
  [sessionId, workspace],
  [parkedSessionId, parkedWorkspace],
  [emptySessionId, emptyWorkspace],
  [brokenSessionId, brokenWorkspace],
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

/* 到这一步 jsdom 已经站好了，React 与 react-dom 才进来。 */
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
 *
 * 真部署里这一份由设置服务给：`configForms.get(ns)` 交出一个按修订号理赔的控制器，
 * 读得出、订得上、写得进。这里造一个同形状的替身，面板与设置页读的就是它——于是
 * 「翻一行、两边当场跟着变」这件事能在夹具里真的走一趟。 */

/** 一份设置文档的替身。 */
function fakeSettingsForm(initial) {
  let value = { ...initial }
  let revision = 1
  let refuse = false
  const listeners = new Set()
  return {
    document: () => value,
    getSnapshot: () => ({ status: 'ready', value, base: undefined, user: undefined, revision, writable: true }),
    /* m4 那一条要的：接在这份表单上的订阅者有几个——摘除器有没有被还回来，只看这个数。 */
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
    /* m1 那一条要的：这份文档一律不收改动，量「两笔都不作数时不许静默」。 */
    refuse: (on = true) => { refuse = on },
  }
}

/** 设置服务那一侧的替身：按命名空间给表单，并记下谁要过哪一份。 */
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

/* ---- 那条导航口子与「活动会话」 ---------------------------------------------
 *
 * 真部署里 `ctx.uiWorkspace.openSession(target)` 是同步的一手：它把活动会话换掉，会话
 * 清单那条 hook 跟着通知出去，面板与 DSH 的中央栏一起重画。夹具按同一个次序写一份替身：
 * `navigationFace` 就是面板拿到的那个口子（这一趟只走 `openSession`），`liveList` 是会话
 * 清单那一刻的快照（`ids` 是清单次序，当前那条挂 `retainedBy.mainView`）。
 *
 * 名册 `liveList.known` 是「这台机器上此刻有哪些会话」：面板拿它对记录里那条会话在不在
 * 本机上。点卡切会话那一节往里放什么，就是那一节要量的东西。
 */
const liveList = {
  current: sessionId,
  known: [sessionId],
  listeners: new Set(),
  snapshot: null,
  build() {
    const byId = {}
    for (const id of liveList.known) byId[id] = { id, retainedBy: id === liveList.current ? { mainView: 1 } : {} }
    liveList.snapshot = { ids: [...liveList.known], byId, phase: 'ready', projectionsBySession: {} }
    return liveList.snapshot
  },
  switchTo(target) {
    liveList.current = target
    liveList.build()
    for (const listener of [...liveList.listeners]) listener()
  },
}
liveList.build()

/** 这条导航口子：切过去，再让清单通知出去。 */
const navCalls = []
const navigationFace = {
  openSession(target) {
    navCalls.push(target)
    liveList.switchTo(target)
  },
}

/** 会话清单那条 hook：真形状是**带投影的**，整份快照靠恒等投影取回来。 */
function liveUseSessions(select) {
  return React.useSyncExternalStore(
    (listener) => { liveList.listeners.add(listener); return () => { liveList.listeners.delete(listener) } },
    () => select(liveList.snapshot),
    () => select(liveList.snapshot),
  )
}

/**
 * 起一条浏览器半身：服务从 `get` 来，注册经 `inject` 等，落点经 `effect` 挂。
 *
 * `slots` 这一份是按真协议写的替身：同一个 id 重复注册会抛（那正是要躲开的那一下），
 * 注册那一刻记下选项与组件，注册处返回的摘除器能把它收回去。
 *
 * `reuse` 那一路给的是「同一份 slots 名册上再起一次」：默认每次新开一份，给了一份就
 * 跟着用——幂等那一条要两次注册落在同一本名册上才量得出来。
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

/* m2 那一条要量的东西：先按旧版那四个键把本地存储塞满，再看「接上设置表单那一刻」有没有
 * 把它们扫掉。最后第 6c 节那条判据扫的是整个 `dsh-pathfinder.` 前缀——先塞这一步让它对存量
 * origin 也真的成立，而不只是证「面板从此不再往里写」。 */
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

/* 这一层登记五条：设置里那一节，加上调度中心那四处。夹具这里问的是「注册了哪些」，一份
 * 名册比一句「碰没碰 slots」经得起看——槽位、id / key、order 逐条摆出来。中央栏那一格是
 * keyed：那本名册认 `key`，其余四条认 `id`。 */
const SEAT_ENTRIES = [
  { key: `${client.SECTION_SLOT}:${client.SETTINGS_NAMESPACE}`, order: client.SECTION_ORDER, word: '设置里那一节' },
  { key: `sidebar.panellist:${client.PANEL_ID}`, order: client.PANEL_ORDER, word: '侧栏那一项' },
  { key: `main:${client.PANEL_ID}`, order: undefined, word: '中央栏那一格' },
  { key: `sidebar.footer.action:${client.READY_BADGE_ID}`, order: client.FOOTER_ORDER, word: '页脚徽标' },
  { key: `shell.overlay:${client.PENDING_NOTICE_ID}`, order: client.NOTICE_ORDER, word: '浮层提示' },
]
/** 一本名册当下的样子：每条记下钥匙与 order。 */
const rosterOf = (ledger) => [...ledger.entries()].map(([key, entry]) => ({ key, order: entry.options.order }))
/** 按钥匙排好：这五条各落在**不同**的槽位，谁先登记在 DSH 里没有语义（`order` 只在同一个
 * list 槽内部才有意义），所以下面两份名册只比「哪几条在册、各自什么 order」，不锁先后。 */
const byKey = (roster) => [...roster].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
const sameRoster = (left, right) => JSON.stringify(byKey(left)) === JSON.stringify(byKey(right))
const registeredIds = [...booted.ledger.keys()]
check(
  '这一层注册的是哪五条：槽位＋id/key 逐条摆出来',
  sameRoster(registeredIds.map((key) => ({ key })), SEAT_ENTRIES.map(({ key }) => ({ key }))),
  registeredIds.length === 0 ? 'slots 上一个注册都没有' : `注册=${registeredIds.join(', ')}`,
)
check(
  '五条各自的 order 对上，侧栏那一项落在「插件」0 与「排期」10 之间',
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
 * React 自己的订阅也在那条通知上——页面上看不出事，鼠标键盘却全死了。所以那一下必须停在
 * 这一层里面。 */
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

/* 同一条 effect 收掉再跑一遍（fiber 重入那一趟）：先撤上一次，再登记回来。
 * 接设置表单那一手与四处座席那一手各是另一条 effect：收掉座席那一条，它自己那四条要
 * 跟着走、设置那一节要留着；收掉接设置表单那一条，接在设置表单上的订阅者要还回去。 */
const sectionEffect = reuse.effects.find((one) => one.name === 'dsh-pathfinder: settings page')
const formEffect = reuse.effects.find((one) => one.name === 'dsh-pathfinder: settings form')
const seatsEffect = reuse.effects.find((one) => one.name === 'dsh-pathfinder: seats')
const sharedForm = backend.form(client.SETTINGS_NAMESPACE)
check(
  '接设置表单那一手、登记那一页那一手与四处座席那一手各是一条 effect',
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
  '收掉座席那一条 effect：那四条从名册上撤下来，设置那一节还站着',
  reuse.ledger.size === 1 && reuse.ledger.has(`${client.SECTION_SLOT}:${client.SETTINGS_NAMESPACE}`),
  `名册=${[...reuse.ledger.keys()].join(', ') || '（空）'}`,
)
seatsEffect.run()
check(
  '它再跑一遍：四条又登记回来，没有重复',
  reuse.ledger.size === SEAT_ENTRIES.length
    && sameRoster(rosterOf(reuse.ledger), SEAT_ENTRIES.map(({ key, order }) => ({ key, order }))),
  `名册=${[...reuse.ledger.keys()].join(', ') || '（空）'}`,
)
sectionEffect.off()
check(
  '收掉设置那一页那条 effect：设置那一节下来，四处座席还站着',
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

/* 取数那一趟的完成通知用的是文件头上那一份 `inFlight`：远程替身与本夹具自己叫的那几趟
 * 都往那儿落。写面被叫过几次：几个新看法一遍点下来，这一次数必须停在原地。 */
const writeCalls = []
const trackedPort = {
  ...panel.port,
  read(id, signal) {
    return track(panel.port.read(id, signal))
  },
  readSessions(id) {
    return track(panel.port.readSessions(id))
  },
  write(verb, id, target) {
    writeCalls.push(`write/${verb}`)
    return track(panel.port.write(verb, id, target))
  },
  setPolicy(id, cycle, key, value) {
    writeCalls.push(`setPolicy/${key}`)
    return track(panel.port.setPolicy(id, cycle, key, value))
  },
  readConfig(id) {
    return track(panel.port.readConfig(id))
  },
  setConfig(id, key, value) {
    writeCalls.push(`setConfig/${key}`)
    return track(panel.port.setConfig(id, key, value))
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
const reading = await gateway.read(sessionId, {})
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

/* ---- 3c. 调度中心那四处：真产物挂上去，各露一面 --------------------------
 *
 * 判定 1 的「在测试床上露面」那一趟归下游两格（发布 `6009423d` 的完成判定 3、证明面
 * `b0c5e0dd` 的清单第 4 条）：本格这一侧的证据落在这一趟夹具与单测上。同一批命题放在
 * 这一趟里取证：侧栏那一项、页脚徽标、浮层、中央栏那一格，四处注册的组件各按真形状
 * 渲染一遍。浮层那一条是「有事才说一句」，四档都在这一趟里露面：这一份记录有记录、也
 * 没有出局等人的格 → 不画（那一枚数归页脚徽标）；空记录的工作区（`.pf` 都不建）→ 印一句
 * 原因；记录读不动的工作区（`.pf` 在、四份读不动）→ 印**另一句**原因，徽标那一处不画数；
 * 真有出局等人的那份在第二份记录那一节（印「等待处理 N」）。
 *
 * 座席标准 props 里的 `useSessions` 由 ui-session 的 `provideRoot` 挂上，形状是一条
 * **带投影的** hook：夹具按真形状写一个——`ids` 是宿主清单次序（第一行是**另一条**会话）、
 * `byId` 里当前会话那条挂着 `retainedBy.mainView`，另带 `phase` 与 `projectionsBySession`。
 * 两处座席挑会话挑对没有：`seatReads` 那一笔（它们向宿主问过哪条会话）与徽标、浮层那几条
 * 读数一起看得见——挑成清单第一行时，这一笔与下面那几条读数都会露。
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
  badge: booted.ledger.get(`sidebar.footer.action:${client.READY_BADGE_ID}`),
  notice: booted.ledger.get(`shell.overlay:${client.PENDING_NOTICE_ID}`),
  main: booted.ledger.get(`main:${client.PANEL_ID}`),
}
check(
  '四处各有一条注册，页脚与浮层各只一条（整条 entry 只注册一次）',
  seatEntries.side !== undefined && seatEntries.badge !== undefined
    && seatEntries.notice !== undefined && seatEntries.main !== undefined
    && [...booted.ledger.keys()].filter((key) => key.startsWith('sidebar.footer.action:')).length === 1
    && [...booted.ledger.keys()].filter((key) => key.startsWith('shell.overlay:')).length === 1,
  `名册=${[...booted.ledger.keys()].join(', ')}`,
)

await act(async () => {
  seatRoot.render(React.createElement(React.Fragment, null,
    React.createElement(seatEntries.side.component, { size: 16 }),
    React.createElement(seatEntries.badge.component, {
      ...seatEntries.badge.options.inject(), wide: true, useSessions: sessionsAt(sessionId),
    }),
    React.createElement(seatEntries.notice.component, {
      ...seatEntries.notice.options.inject(), useSessions: sessionsAt(sessionId),
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

const badgeSeat = seatHost.querySelector(`[data-pathfinder="${client.READY_BADGE_ID}"]`)
check(
  '页脚徽标印的读数与记录一致：可开工 N 就是记录现算的那一栏',
  badgeSeat !== null
    && (badgeSeat.textContent ?? '').replace(/\s+/gu, ' ').trim() === `可开工 ${String(project.columns.ready.length)}`,
  `记录现算 可开工=${String(project.columns.ready.length)} ｜ 徽标上=${JSON.stringify((badgeSeat?.textContent ?? '（没有这枚徽标）').replace(/\s+/gu, ' ').trim())}`,
)

const noticeSeat = seatHost.querySelector(`[data-pathfinder="${client.PENDING_NOTICE_ID}"]`)
check(
  '这一份记录有记录、也没有出局等人的格：浮层不画，屏上只剩徽标那一枚数',
  project.columns.shelved.length === 0 && noticeSeat === null,
  `记录里的出局等人=${String(project.columns.shelved.length)} ｜ 徽标上=${JSON.stringify((badgeSeat?.textContent ?? '（没有这枚徽标）').replace(/\s+/gu, ' ').trim())} ｜ 浮层上=${noticeSeat === null ? '（不画）' : JSON.stringify(noticeSeat.textContent)}`,
)

/* 空记录的工作区那一档：判定 1 要「页脚徽标与浮层各出现一次」，而在这种工作区上浮层说的
 * 是一句只有它说得出的原因——这个工作区里压根没有记录（测试床那份合成工作区就是这种
 * 情形：没有 `.pf`，取数成功、四份来源全 `missing`）。另起一条插件（自己那份读数源），
 * 两处座席都指到空工作区那条会话上。 */
const emptyBoot = bootClient(backend, {})
const emptySeatHost = window.document.createElement('div')
window.document.body.appendChild(emptySeatHost)
const emptySeatRoot = createRoot(emptySeatHost)
const emptyBadgeEntry = emptyBoot.ledger.get(`sidebar.footer.action:${client.READY_BADGE_ID}`)
const emptyNoticeEntry = emptyBoot.ledger.get(`shell.overlay:${client.PENDING_NOTICE_ID}`)
await act(async () => {
  emptySeatRoot.render(React.createElement(React.Fragment, null,
    React.createElement(emptyBadgeEntry.component, {
      ...emptyBadgeEntry.options.inject(), wide: true, useSessions: sessionsAt(emptySessionId),
    }),
    React.createElement(emptyNoticeEntry.component, {
      ...emptyNoticeEntry.options.inject(), useSessions: sessionsAt(emptySessionId),
    }),
  ))
})
await settle()
const emptyBadge = emptySeatHost.querySelector(`[data-pathfinder="${client.READY_BADGE_ID}"]`)
const emptyNotice = emptySeatHost.querySelector(`[data-pathfinder="${client.PENDING_NOTICE_ID}"]`)
const flat = (node) => (node?.textContent ?? '').replace(/\s+/gu, ' ').trim()
check(
  '空记录的工作区：页脚徽标与浮层各出现一次——徽标印 可开工 0，浮层印「这个工作区里没有记录」',
  emptyBadge !== null && emptyNotice !== null
    && flat(emptyBadge) === '可开工 0'
    && flat(emptyNotice) === '这个工作区里没有记录。',
  `工作区=${emptyWorkspace.replace(root, '.')}（没有 .pf） ｜ 徽标上=${JSON.stringify(emptyBadge === null ? '（没有这枚徽标）' : flat(emptyBadge))} ｜ 浮层上=${JSON.stringify(emptyNotice === null ? '（空的）' : flat(emptyNotice))}`,
)

/* 记录读不动那一档：`.pf` 在、四份文件也在，但没有一份解得出内容（四份来源全 `unusable`）。
 * 这一档屏上不许出现一枚编出来的 `可开工 0`——徽标整个不画，浮层说「读不动」，与上面那一档
 * 的「没有记录」不是同一句。另起一条插件，两处座席指到这个坏工作区那条会话上。 */
const brokenBoot = bootClient(backend, {})
const brokenSeatHost = window.document.createElement('div')
window.document.body.appendChild(brokenSeatHost)
const brokenSeatRoot = createRoot(brokenSeatHost)
const brokenBadgeEntry = brokenBoot.ledger.get(`sidebar.footer.action:${client.READY_BADGE_ID}`)
const brokenNoticeEntry = brokenBoot.ledger.get(`shell.overlay:${client.PENDING_NOTICE_ID}`)
await act(async () => {
  brokenSeatRoot.render(React.createElement(React.Fragment, null,
    React.createElement(brokenBadgeEntry.component, {
      ...brokenBadgeEntry.options.inject(), wide: true, useSessions: sessionsAt(brokenSessionId),
    }),
    React.createElement(brokenNoticeEntry.component, {
      ...brokenNoticeEntry.options.inject(), useSessions: sessionsAt(brokenSessionId),
    }),
  ))
})
await settle()
const brokenBadge = brokenSeatHost.querySelector(`[data-pathfinder="${client.READY_BADGE_ID}"]`)
const brokenNotice = brokenSeatHost.querySelector(`[data-pathfinder="${client.PENDING_NOTICE_ID}"]`)
check(
  '记录读不动的工作区：徽标不画那枚数，浮层印「读不动」——不是上面那一档的「没有记录」',
  brokenBadge === null && brokenNotice !== null && flat(brokenNotice) === '这个工作区里的记录读不动。',
  `工作区=${brokenWorkspace.replace(root, '.')}（.pf 在、四份读不动） ｜ 徽标上=${brokenBadge === null ? '（不画）' : JSON.stringify(flat(brokenBadge))} ｜ 浮层上=${JSON.stringify(brokenNotice === null ? '（空的）' : flat(brokenNotice))}`,
)
check(
  '徽标是只读的：页脚那一处摆的不是按钮',
  badgeSeat !== null && badgeSeat.tagName.toLowerCase() === 'span' && badgeSeat.onclick === null,
  badgeSeat === null ? '（没有这枚徽标）' : `标签=${badgeSeat.tagName.toLowerCase()}`,
)

/* 产物那份 css 里九个 `--pf-*` 的声明点，按面板 DOM 上解析出来的值量：声明落在
 * `.pf-page body` / `.pf-page :root` 这类匹配不到任何元素的选择器上时，这里读出来就是空串
 * ——`var(--pf-ink-2)` 那几处没有兜底的读法会跟着作废。
 *
 * 同一条尺子还管着 `mock/tokens.css` 那条 reset 的 `box-sizing`：它在蓝本里写在 `*` 上，
 * 连页面根一起管，收拢成 `.pf-page *` 时面板根自己就落空了（`.pf-page` 是整块地界里唯一
 * 带内缩又拿 `height: 100%` 的盒，落空的代价是底下多出 24px）。读法按 DOM 逐个匹配，
 * 问的是「这条声明最后落在谁身上」——产物里写了什么不算数。 */
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
 * 上面两条读数是点状的（九个令牌、reset 的 `box-sizing`、舞台与框那几条），点不到
 * 「某一组规则整条不见了」——把页头那批 `.pf-count` 从进包的路上整批丢掉，上面照样全绿。
 * 这里补一条整体尺子：进包的 css 是 `mock/` 那几张表的机械改写（只重写选择器，声明一个
 * 字节不动），所以逐表逐条比得出来——套着它的那几层 at-rule、选择器、声明正文三样都要
 * 对得上；差额只允许是明写取进来的 `CARRIED` 那几条。
 *
 * 尺子**自己**写一份表清单与一份收拢映射，不 import 构建口那一份：拿被测方自己的算法算
 * 期望值，尺子就等于没量（把某一批规则丢掉的那次改动会在两边同时生效，照样全绿）。
 * 两边清单也因此互相钉住：构建口多收或少收一张表，这里都会红。
 *
 * 规范化：比之前两边都摘掉注释、把连续空白折成一个空格、去掉首尾空白。声明次序照原样比，
 * 不排序——CSS 里次序有意义。
 */
const SHEETS = [
  { sheet: 'tokens.css', scope: '.pf-page' },
  { sheet: 'styles/main.css', scope: '.pf-page' },
  { sheet: 'styles/board.css', scope: '.pf-page' },
  { sheet: 'styles/lines.css', scope: '.pf-page' },
  { sheet: 'styles/detail.css', scope: '.pf-page' },
  { sheet: 'styles/notes.css', scope: '.pf-page' },
  /* 依赖与问题那两张表收进面板里的 `.is-embed` 那一层：它们在蓝本里各自是一份独立
     文档，靠 `.is-embed` 把页头与页边距让给宿主。 */
  { sheet: 'styles/field.css', scope: '.is-embed' },
  { sheet: 'styles/register.css', scope: '.is-embed' },
]
const CARRIED = [{
  sheet: 'styles/settings.css',
  selectors: ['.pf-stage', '.pf-frame', '.pf-configwrap', '.pf-configwrap .pf-scroll', '.pf-config', '.pf-config .pf-setrow', '.pf-vlayer'],
}]
const SCOPE = '.pf-page'
/** 蓝本里写在页面根上的那几段：收拢后落到那一层自己身上。 */
const PAGE_ROOTS = new Set([':root', 'html', 'body'])

/** 与 `open` 那个 `{` 配对的那个 `}` 落在哪儿。 */
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

/** 比之前那一遍规范化：注释摘掉、连续空白折成一个空格、首尾去掉。 */
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
function alreadyScoped(part, scope) {
  return part
    .split(/[\s>+~]+/u)
    .flatMap((segment) => segment.split(/[.#:[\]]/u))
    .some((token) => token === scope.slice(1))
}

/** 这一段选择器进包之后该长成哪几段——这张表就是进包的约定，明写在这儿、与构建口各写一份。 */
function expectedPart(part, scope) {
  const low = part.toLowerCase()
  if (low === '*') return [scope, `${scope} *`]
  if (low.startsWith('*::')) return [`${scope}${part.slice(1)}`, `${scope} ${part}`]
  if (PAGE_ROOTS.has(low)) return [scope]
  return alreadyScoped(part, scope) ? [part] : [`${scope} ${part}`]
}

/** 一整串选择器（逗号列表）收拢后的样子：重复的只留一条。 */
function expectedPrelude(prelude, scope) {
  const parts = prelude
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .flatMap((part) => expectedPart(part, scope))
  return [...new Set(parts)].join(', ')
}

/** `mock/` 那一侧算出来的期望样子。`@keyframes` 这类整块原样带走，里面没有选择器可收拢。 */
function expectedOf(entry, scope) {
  return {
    wrap: entry.wrap,
    prelude: entry.prelude.startsWith('@') ? entry.prelude : expectedPrelude(entry.prelude, scope),
    body: entry.body,
  }
}

/** 两条规则对不对得上；对得上返回空串，否则返回一句读数。 */
function diffOf(want, got) {
  if (got === undefined) return `期望 ${JSON.stringify(want.prelude)}（${want.body.slice(0, 40)}）｜ 产物里没有这一条`
  const same = got.prelude === want.prelude
    && got.body === want.body
    && JSON.stringify(got.wrap) === JSON.stringify(want.wrap)
  if (same) return ''
  const at = JSON.stringify(got.wrap) === JSON.stringify(want.wrap) ? '' : `（套着的 at-rule 不同：期望 ${want.wrap.join(' ')}｜产物 ${got.wrap.join(' ')}）`
  return `期望 ${JSON.stringify(want.prelude)}{${want.body.slice(0, 56)}} ｜ 产物 ${JSON.stringify(got.prelude)}{${got.body.slice(0, 56)}}${at}`
}

/** 第一条对不上的规则；全对得上返回 `null`。 */
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

/* ---- 4a. 设置那一节：导航行 + 它打开的那一页，与面板读同一份设置表单 -----------
 *
 * 这一节住在 DSH 自己的设置面板里，跟主面板不在一棵树上，所以这里把产物注册的那个组件
 * 单独挂进一份 DOM，当它是一页。判据是「翻一行，面板上对应的读数当场跟着变」——两边读
 * 的是同一份表单（`configForms.get(ns)` 那一个控制器），这一条走得通才算接对了。 */

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

/* 明细：这一份记录里没有出局等人的格，「等待处理」那一组就不该出现。 */
await act(async () => { tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const detailA = detailReadings(container)
const labelsA = detailA.map((group) => group.label)
check(
  '不含出局等人的那份记录里不出现「等待处理」',
  project.columns.shelved.length === 0 && labelsA.includes('等待处理') === false,
  `记录里的出局等人=${String(project.columns.shelved.length)} 组头=${labelsA.join('/') || '（空）'} 行数=${String(detailA.reduce((sum, group) => sum + group.rows.length, 0))}`,
)
check(
  '明细的组头按记录长出来',
  detailA.length > 0,
  detailA.map((group) => `${group.label}(${String(group.rows.length)})`).join('/'),
)

/* 指令那一格：先验「按范围分组」这一层，再归档一条、复原它、把它删掉。 */
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
  const restore = await gateway.reviveInstruction(sessionId, live.id)
  check('删除之后复原拿不回来', restore.ok === false, `revive=${restore.ok ? 'ok' : restore.text.split('\n')[0].slice(0, 60)}`)
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

/* 最上面那一档：卡片上多一行「还等不等、等几件」。期望值从读数自己那几栏现算，不抄实现
   的判据：`ready` 就是「可开工」那一栏，进行中的格子（`running`）两样都不印。照
   `state === 'todo'` 数会把进行中的那一格一起算进来——那一份期望值与被测实现同源，跑多少
   遍都是绿的。 */
await click(zoomKey(wiresPane, '放大'))
const fullCards = [...(wiresPane?.querySelectorAll('.pf-zcard.is-full') ?? [])]
const metaCount = fullCards.filter((card) => card.querySelector('.pf-zmeta') !== null).length
const metaWant = project.nodes.filter((node) => node.ready || (node.state === 'todo' && !node.running && node.openDependencies.length > 0)).length
check(
  '依赖那一格：最上面那一档，可开工的与还欠着前置的那几格各多一行前置读数',
  fullCards.length === project.nodes.length && metaCount === metaWant && metaWant > 0,
  `卡片 ${String(fullCards.length)} 张（该带那一行 ${String(metaWant)} 格）｜ 带那一行 ${String(metaCount)} 张`,
)

/* 进行中的那一格不许印「可开工」：读数里 `ready` 与 `running` 互斥，卡片上那行与悬停说的是
   同一件事。本仓这份记录里就有一格——`5294d24a`（就是写这一格的那一格自己）进行中、欠前置 0。 */
const inHand = project.nodes.filter((node) => node.running)
const inHandCards = inHand.map((node) => fullCards.find((card) => card.getAttribute('data-id') === node.id))
check(
  '依赖那一格：进行中的格子不印「可开工」，悬停照旧说「进行中」',
  inHand.length > 0
    && inHandCards.every((card) => card !== undefined
      && card.querySelector('.pf-zmeta') === null
      && (card.getAttribute('title') ?? '').includes('进行中')
      && (card.getAttribute('title') ?? '').includes('可开工') === false),
  `记录里进行中 ${String(inHand.length)} 格（${inHand.map((node) => `${node.id.slice(0, 8)} 欠前置 ${String(node.openDependencies.length)}`).join('、')}）｜ 这几张卡带那一行的 ${String(inHandCards.filter((card) => card?.querySelector('.pf-zmeta') !== null).length)} 张 ｜ 悬停 ${inHandCards.map((card) => card?.getAttribute('title') ?? '（没有这张卡）').join(' / ')}`,
)

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
const cutKey = zoomKey(wiresPane, '退出这一块')
check(
  '依赖那一格：双击把那一条圈出来，只留它自己、它欠的、欠它的',
  hub !== undefined && JSON.stringify(cutIds) === JSON.stringify(litWant),
  `这一圈 ${String(litWant.length)} 格（${litWant.map((id) => id.slice(0, 8)).join(',')}）｜ 面板上 ${String(cutIds.length)} 格`,
)
check('抠出来看时那枚叉露出来了', cutKey !== undefined && cutKey.hidden === false, `hidden=${String(cutKey?.hidden)}`)
if (cutKey !== undefined) await click(cutKey)
check(
  '退出这一块，整张图回来',
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
   翻到关，那一排当场回到「精简」、未解决之外的行从登记簿里退出去；再翻回来还原。 */
const issueRowIds = () => [...(issuePane?.querySelectorAll('button.pf-row[data-issue]') ?? [])]
  .map((row) => row.getAttribute('data-issue'))
const poolAllIds = project.pool.groups.flatMap((group) => group.entries.map((entry) => entry.id))
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
await flipSwitch('问题池里显示未解决之外的')
check(
  '翻回开：那一排回到「完整」，未解决之外的行回到登记簿里（收尾还原）',
  segPressed('完整') === 'true'
    && settingsDoc().showOtherStates === true
    && JSON.stringify(issueRowIds()) === JSON.stringify(poolAllIds),
  `面板上那一档=完整(${String(segPressed('完整'))}) ｜ 文档里 showOtherStates=${String(settingsDoc().showOtherStates)} ｜ 行数=${String(issueRowIds().length)}（未解决 ${String(openIds.length)} 条，全部 ${String(poolAllIds.length)} 条）`,
)
check(
  '两个看法都不落笔：点过一遍，写面一次都没被叫过，记录一个字节没动',
  writeCalls.length === writesBefore && recordDigest() === recordBefore,
  `写面调用 ${String(writeCalls.length - writesBefore)} 次 ｜ 记录 ${recordDigest() === recordBefore ? '一个字节没动' : '变了'}`,
)

/* ---- 4d. 设置那一格：这个工作区自己的项目设置，读出来、就在这里改 --------------
 *
 * 四行、三种控件、行尾一枚层签，照蓝本。两侧读数：一边是面板上摆出来的，一边是**真工具**
 * 对着同一份工作区印的那四行。改一处写回**这个项目那一层**，改完重读一遍——读数落在那份
 * 记录文件上（`workspace/.pf/config.json`），面板自己回读的那一份不作数。这一节跑在临时拷贝
 * 上，本仓那份记录库一个字节不动。
 *
 * 非法值那两档：一个越界数字（数字框里真敲进去），一个不在候选表里的档位（下拉里塞一枚假的
 * 候选值再选它——真面板上点不出这一手，塞的这一枚就是为了把那句话逼出来）。两趟都要落在
 * 「记录保持原值、界面回到原值」上。
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
/** 一份面板里那一格的读数：四行的键、控件上摆的值、行尾那枚层签。 */
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
/** 工具那一侧的期望：每一行的值，加上它住的那一层读作哪个词。 */
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

/* 四行各改一次，都改成另一个合法值。 */
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

/* 那一列的两枚把手：默认 720，左右各一枚贴着列缘，拖一下改列宽，双击回默认。 */
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

/* ---- 6. 第二份记录：出局等人的格与换线路 ---------------------------------
 * 「`等待处理`只在真有出局等人的时候出现」与「换一条线路时右侧清单跟着换」这两条要两份
 * 记录对照：本仓这一份里没有出局等人的格，也只有一条线。第二份从同一份记录复制，再经真
 * 工具造出第二条线、把一个格搁出去；造出来的都是记录里的事实，面板读的就是它。 */

mkdirSync(parkedWorkspace, { recursive: true })
copyRecord(parkedRecord)

const parkedBefore = readProject({ ...(await gateway.read(parkedSessionId, {})), at: new Date() })
const parkedLine = 'lab-line'
/* 挑一个还没人走过的格：`blocked` 那一列就是「没在跑、也没人握着的」。 */
const parkedNode = parkedBefore.columns.blocked[0]?.id
check('第二份记录里挑得出一个能搁出去的格', parkedNode !== undefined, `blocked=${String(parkedBefore.columns.blocked.length)} 取=${String(parkedNode)}`)

if (parkedNode !== undefined) {
  /* 底下四步走真工具（`runPf` 就是面板写面那一条命令口子）；本仓那份记录库一个字节不动。 */
  const signal = new AbortController().signal
  const acts = [
    ['cycle', 'create', parkedLine, '--tags', 'coding', '--force'],
    ['cycle', 'hold', parkedLine, parkedNode],
    ['cycle', 'close', parkedLine, parkedNode, '--result', 'failed'],
    ['dag', 'status', parkedNode, 'shelved'],
  ]
  const echoes = []
  for (const args of acts) {
    const outcome = await runPf(hostCtx, parkedWorkspace, args, signal)
    echoes.push(`${args.slice(0, 2).join(' ')}：${outcome.ok ? 'ok' : 'FAIL'}`)
    check(`第二份记录：pf ${args.slice(0, 2).join(' ')} 落了笔`, outcome.ok, outcome.text.split('\n').slice(0, 2).join(' / ').slice(0, 140))
  }

  const parkedProject = readProject({ ...(await gateway.read(parkedSessionId, {})), at: new Date() })
  const parkedShelved = parkedProject.columns.shelved.find((node) => node.id === parkedNode)
  check(
    '第二份记录里那个格确实出局等人、且挂在这条线上',
    parkedShelved !== undefined && parkedShelved.cycleIds[0] === parkedLine,
    `出局等人=${parkedProject.columns.shelved.map((node) => `${node.id.slice(0, 8)}@${String(node.cycleIds[0])}`).join(',') || '（空）'} 线数=${String(parkedProject.cycles.length)}`,
  )

  const parkedRoot = createRoot(container)
  await act(async () => { parkedRoot.render(React.createElement(panel.Panel, { port: trackedPort, sessionId: parkedSessionId, prefs: panel.prefs })) })
  await settle()
  await act(async () => { [...container.querySelectorAll('.pf-tab')][1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()

  const lineButton = (id) => [...container.querySelectorAll('#pane-detail .pf-linepick')]
    .find((button) => button.querySelector('.pf-cycle')?.textContent === id)
  const lineNames = [...container.querySelectorAll('#pane-detail .pf-linepick .pf-cycle')].map((node) => node.textContent)
  const firstLine = parkedProject.cycles[0]?.id
  check(
    '第二份记录的两条线都摆出来了，默认停在第一条',
    lineNames.length === parkedProject.cycles.length && lineNames.includes(parkedLine) && lineNames[0] === firstLine,
    `侧栏=${lineNames.join('/')} 记录里的线=${parkedProject.cycles.map((cycle) => cycle.id).join('/')}`,
  )

  const onFirst = detailReadings(container)
  check(
    '另一条线那一侧没有「等待处理」',
    onFirst.map((group) => group.label).includes('等待处理') === false
      && onFirst.every((group) => group.rows.includes(parkedNode) === false),
    `组头=${onFirst.map((group) => `${group.label}(${String(group.rows.length)})`).join('/') || '（空）'}`,
  )

  await act(async () => { lineButton(parkedLine)?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
  const onParked = detailReadings(container)
  const parkedGroup = onParked.find((group) => group.label === '等待处理')
  check(
    '换到这条线上，「等待处理」露面、排最前、行就是那个格',
    onParked[0]?.label === '等待处理' && parkedGroup?.rows.length === 1 && parkedGroup?.rows[0] === parkedNode,
    `组头=${onParked.map((group) => `${group.label}(${String(group.rows.length)})`).join('/')} 行=${parkedGroup?.rows.join(',') ?? '（没有这一组）'}`,
  )
  check(
    '换一条线路时右侧清单确实跟着换了',
    JSON.stringify(onFirst) !== JSON.stringify(onParked),
    `前=${onFirst.map((group) => `${group.label}(${String(group.rows.length)})`).join('/')} 后=${onParked.map((group) => `${group.label}(${String(group.rows.length)})`).join('/')}`,
  )

  await act(async () => { lineButton(firstLine)?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
  const back = detailReadings(container)
  check(
    '换回原来那条线，「等待处理」跟着收回去',
    back.map((group) => group.label).includes('等待处理') === false && JSON.stringify(back) === JSON.stringify(onFirst),
    `组头=${back.map((group) => `${group.label}(${String(group.rows.length)})`).join('/') || '（空）'}`,
  )

  lines.push(`      造那份记录的四步：${echoes.join(' ｜ ')}`)
  await act(async () => { parkedRoot.unmount() })

  /* 浮层那一条：第二份记录里真有一个出局等人的格，读数换到这条会话上，那一句就露面。
   * 另外两半在 3c 那一节（同一份读数源、同一枚 entry）：有记录且没有出局等人的不画、
   * 空记录的工作区印那句原因。 */
  await act(async () => {
    seatRoot.render(React.createElement(seatEntries.notice.component, {
      ...seatEntries.notice.options.inject(), useSessions: sessionsAt(parkedSessionId),
    }))
  })
  await settle()
  const parkedNotice = seatHost.querySelector(`[data-pathfinder="${client.PENDING_NOTICE_ID}"]`)
  check(
    '浮层那一句：有出局等人的时候印「等待处理 N」，数就是记录里出局等人的格数',
    parkedNotice !== null
      && (parkedNotice.textContent ?? '').replace(/\s+/gu, ' ').trim() === `等待处理 ${String(parkedProject.columns.shelved.length)}`
      && parkedProject.columns.shelved.length > 0,
    `记录里的出局等人=${String(parkedProject.columns.shelved.length)} ｜ 浮层上=${JSON.stringify((parkedNotice?.textContent ?? '（空的）').replace(/\s+/gu, ' ').trim())}`,
  )
  check(
    '浮层是纯提示：它自己不接指针事件，底下那一层照旧点得着',
    parkedNotice !== null && (parkedNotice.getAttribute('style') ?? '').includes('pointer-events: none'),
    `style=${JSON.stringify(parkedNotice?.getAttribute('style'))}`,
  )
}

/* ---- 6a-1. 点一张卡切到那一格的会话 ----------------------------------------
 *
 * 这一格交出去的是「点一张卡，活动会话切到记录里指出的那一条」。链条上每一环都按真形状
 * 接着：**四份记录**与**会话笔记**都由真宿主半身那两条端点交回来（走的是这一份记录拷贝
 * 与它那一层按节点分的小份笔记）、**会话清单**是那条带投影的 hook（上面那份 `liveList`）、
 * **跳转**走 DSH 那条导航口子（`uiWorkspace.openSession`，面板只把身份递出去）。
 *
 * 三件事分别量：有去处的卡片点下去会话真的换了、那一屏换成那条会话自己的工作区（两条会话
 * 指着两份不同的记录，读数逐项对得上）；没有去处的卡片点不动；切走再切回来，面板自己那
 * 几个状态还在。
 */

/* 往这一份拷贝里加一格（真工具落的笔）：它还没人开过，笔记与记录本体两处都没有它的会话
 * ——「这一格还没有会话」那一档的实景。它没有前置，落在「即将进线」那一列，看板上因此多
 * 出第五张卡。 */
const ADDED_TITLE = 'panel-check-no-session'
const addedOutcome = await runPf(hostCtx, workspace, ['dag', 'add', ADDED_TITLE, '--tags', 'coding'], new AbortController().signal)
const beforeProject = readProject({ ...(await gateway.read(sessionId, {})), at: new Date() })
const added = beforeProject.nodes.find((node) => node.title === ADDED_TITLE)?.id
check(
  '往这份拷贝里加一格：还没开过，记录与笔记里都没有它的会话',
  addedOutcome.ok && added !== undefined,
  `新格=${String(added)} ｜ ${addedOutcome.text.split('\n').slice(0, 2).join(' / ').slice(0, 140)}`,
)

/* 哪一格最近开在哪条会话上：真宿主半身那条端点读回来的。 */
const notesReading = await gateway.readSessions(sessionId)
check(
  '会话笔记读得回来：每一格最近开过的那条会话都在清单上',
  notesReading.state === 'read' && Object.keys(notesReading.sessions).length > 0,
  `那一层=${notesReading.state} 有笔记的格=${String(Object.keys(notesReading.sessions).length)}`,
)

/* 看板上会摆哪几张卡：与面板同一份读数先算一遍（每列三张），再从里面挑这一节要的五档。
 * 照记录先算好，是因为有两档要先在这份拷贝上造出来才看得见。 */
const visible = (list) => list.slice(0, 3).map((node) => node.id)
const boardNodes = [
  ...visible([...beforeProject.columns.shelved, ...beforeProject.columns.running]),
  ...visible(beforeProject.columns.completed),
  ...visible(beforeProject.columns.ready),
]
const sessionOfNode = (nodeId) => notesReading.sessions[nodeId] ?? ''
const withNote = boardNodes.filter((nodeId) => sessionOfNode(nodeId).length > 0)
const jumpNode = withNote[0]
const backNode = withNote[1]
const farNode = withNote[2]
const recordNode = withNote[3]
/* 新加的那一格当「哪儿都没写会话」那一档：工具加它的时候替它记下了创建它的那条会话，那
 * 一份笔记下面会摘掉（再没有第二次落笔会替它补上）。 */
const bareNode = added
const labelOf = (nodeId) => `${(nodeId ?? '').slice(0, 8)}@${sessionOfNode(nodeId ?? '').slice(0, 18) || '（没有会话）'}`
check(
  '看板上挑得出这一节要的五张卡：去的那一张、回的那一张、一条不在这台机器上的会话、记录本体上写着会话的、哪儿都没写会话的',
  jumpNode !== undefined && backNode !== undefined && farNode !== undefined && recordNode !== undefined && bareNode !== undefined
    && bareNode === added
    && new Set([sessionOfNode(jumpNode), sessionOfNode(backNode), sessionOfNode(farNode), sessionOfNode(recordNode)]).size === 4,
  `卡片=${boardNodes.map(labelOf).join(' ')} ｜ 新加的那一格=${added.slice(0, 8)}`,
)

/* 这一节要的两条会话：去的那条开在第二份记录那个工作区，回的那条开在这一份。名册里只放
 * 这三条（当前这条、去的那条、回的那条），别人的会话在这台机器上就没有落点。 */
const jumpSession = sessionOfNode(jumpNode ?? '')
const backSession = sessionOfNode(backNode ?? '')
sessionWorkspaces.set(jumpSession, parkedWorkspace)
sessionWorkspaces.set(backSession, workspace)
liveList.known = [sessionId, jumpSession, backSession]
liveList.build()

/* 三档要在这份拷贝上先造出来（本仓那份记录里每一格都有笔记，也没有哪个节点身上带着记录
 * 本体那个字段）：
 *   - `recordNode`：把它的笔记拿掉、在记录本体上给它写一条会话——旧一版记录把会话写在节
 *     点身上，这一档照那个字段点得动；
 *   - `bareNode`（新加的那一格）：把工具替它记下的那一份也摘掉，记录本体上也不写——笔记
 *     与记录两处都没有它，这一档没有去处。
 * 三处都在下面那一次渲染之前改完，面板读到的就是改过之后的记录与笔记。 */
const recordNote = join(record, 'meta', 'sessions', `${recordNode ?? ''}.json`)
const hadRecordNote = existsSync(recordNote)
check('那条要摘的笔记本来就在这份拷贝上', hadRecordNote, recordNote.replace(root, '.'))
if (hadRecordNote) rmSync(recordNote, { force: true })
const addedNote = join(record, 'meta', 'sessions', `${added ?? ''}.json`)
check('工具加那一格时替它记下的那一份笔记也在（要摘掉才量得出「哪儿都没写会话」那一档）', existsSync(addedNote), addedNote.replace(root, '.'))
rmSync(addedNote, { force: true })
const ideasPath = join(record, 'ideas.json')
const ideas = JSON.parse(readFileSync(ideasPath, 'utf8'))
ideas.nodes[recordNode].dsh_session = backSession
delete ideas.nodes[added].dsh_session
writeFileSync(ideasPath, `${JSON.stringify(ideas, null, 2)}\n`)
const notesAfter = await gateway.readSessions(sessionId)
check(
  '三档摆在拷贝上：记录本体上写着会话的那一格、笔记与记录两处都没写的那一格',
  JSON.parse(readFileSync(ideasPath, 'utf8')).nodes[recordNode].dsh_session === backSession
    && JSON.parse(readFileSync(ideasPath, 'utf8')).nodes[added].dsh_session === undefined
    && Object.hasOwn(notesReading.sessions, recordNode)
    && notesAfter.sessions[recordNode] === undefined
    && notesAfter.sessions[added] === undefined,
  `${(recordNode ?? '').slice(0, 8)}：记录本体上=${backSession} ｜ 摘之前笔记里=${String(notesReading.sessions[recordNode])} ｜ 摘之后=${String(notesAfter.sessions[recordNode])} ｜ ${String(added).slice(0, 8)}：工具原来记的=${String(notesReading.sessions[added])}，摘掉之后=${String(notesAfter.sessions[added])}`,
)

const goHost = window.document.createElement('div')
window.document.body.appendChild(goHost)
const goRoot = createRoot(goHost)
const goMain = booted.ledger.get(`main:${client.PANEL_ID}`)
const clickOn = async (node) => {
  await act(async () => { node?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
}
await act(async () => {
  goRoot.render(React.createElement(goMain.component, { ...goMain.options.inject(), useSessions: liveUseSessions }))
})
await settle()
/* 面板自己的标签页与信息量跟着设置文档走（前面几节翻过），这一节先拨到要量的那一档。 */
await clickOn(goHost.querySelector('#tab-now'))
const infoSeg = (label) => [...goHost.querySelectorAll('#pane-now .pf-modes .pf-segbtn')]
  .find((button) => button.textContent === label)
await clickOn(infoSeg('展开'))

const homeProject = readProject({ ...(await gateway.read(sessionId, {})), at: new Date() })
const boardOf = (host) => ({
  pills: [...host.querySelectorAll('#census .pf-pill')].map((pill) => [
    pill.getAttribute('title'),
    Number.parseInt((pill.querySelector('.pf-num')?.textContent ?? '').replace(/[^\d]/gu, ''), 10),
  ]),
  columns: [...host.querySelectorAll('#cols .pf-col')].map((column) => column.querySelectorAll('.pf-card').length),
})
const expectedBoard = (project, cap) => ({
  pills: [
    ...(project.columns.shelved.length > 0 ? [['等待处理', project.columns.shelved.length]] : []),
    ['已交付', project.columns.completed.length],
    ['进行中', project.columns.running.length],
    ['未开始', project.columns.todo.length],
  ],
  columns: [
    Math.min(cap, project.columns.shelved.length + project.columns.running.length),
    Math.min(cap, project.columns.completed.length),
    Math.min(cap, project.columns.ready.length),
  ],
})
const homeBoard = boardOf(goHost)
const cardFor = (nodeId) => [...goHost.querySelectorAll('#cols .pf-card')]
  .find((card) => card.querySelector('.pf-card-title')?.getAttribute('title') === nodeId)
/** 有去处的那一身：按得动、键盘也够得着。 */
const lived = (card) => card !== undefined && card.getAttribute('role') === 'button'
  && card.getAttribute('tabindex') === '0' && card.className.includes('is-inert') === false
/** 没有去处的那一身：不挂按钮，那两下也收着。 */
const quiet = (card) => card !== undefined && card.getAttribute('role') === null
  && card.hasAttribute('tabindex') === false && card.className.includes('is-inert')
const pressedInfo = () => [...goHost.querySelectorAll('#pane-now .pf-modes .pf-segbtn')]
  .find((button) => button.getAttribute('aria-pressed') === 'true')?.textContent

check(
  '起始这一屏：看板上的数与这条会话自己的工作区逐项对上',
  JSON.stringify(homeBoard) === JSON.stringify(expectedBoard(homeProject, 3)),
  `看板上=${JSON.stringify(homeBoard)} ｜ 记录现算=${JSON.stringify(expectedBoard(homeProject, 3))}`,
)

const jumpCard = cardFor(jumpNode ?? '')
const recordCard = cardFor(recordNode ?? '')
const farCard = cardFor(farNode ?? '')
const bareCard = cardFor(bareNode ?? '')
check(
  '这五张卡都在看板上，一个一个找得到',
  jumpCard !== undefined && recordCard !== undefined && farCard !== undefined && bareCard !== undefined,
  `屏上=${[...goHost.querySelectorAll('#cols .pf-card')].map((card) => (card.querySelector('.pf-card-title')?.getAttribute('title') ?? '').slice(0, 8)).join(' ')}`,
)
check(
  '记录里那条会话在本机上：这一张卡挂得住那两下（按钮那一身 + 手上那一档）',
  lived(jumpCard),
  `${labelOf(jumpNode)} ｜ role=${String(jumpCard?.getAttribute('role'))} tabindex=${String(jumpCard?.getAttribute('tabindex'))} class=${String(jumpCard?.className)}`,
)
check(
  '旧一版记录把会话写在节点身上：笔记里没有它，卡片照样点得动',
  lived(recordCard) && notesAfter.sessions[recordNode ?? ''] === undefined,
  `${(recordNode ?? '').slice(0, 8)}@记录本体上=${backSession} ｜ 笔记里=${String(notesAfter.sessions[recordNode ?? ''])} ｜ role=${String(recordCard?.getAttribute('role'))} class=${String(recordCard?.className)}`,
)
check(
  '那条会话不在这台机器上：卡片安安静静地摆着，不给按钮那一身',
  quiet(farCard),
  `${labelOf(farNode)} ｜ role=${String(farCard?.getAttribute('role'))} tabindex=${String(farCard?.getAttribute('tabindex'))} class=${String(farCard?.className)}`,
)
check(
  '这一格还没有会话（笔记与记录本体两处都没写）：卡片同样没有去处',
  quiet(bareCard),
  `${(bareNode ?? '').slice(0, 8)} ｜ 笔记里=${String(notesAfter.sessions[bareNode ?? ''])} ｜ 记录本体上=${String(JSON.parse(readFileSync(ideasPath, 'utf8')).nodes[bareNode ?? ''].dsh_session)} ｜ role=${String(bareCard?.getAttribute('role'))} class=${String(bareCard?.className)}`,
)

/* 一屏十几张卡：能点的那些，名字要各自带着自己那一格的身份，读屏用户才分得开。 */
const liveNames = [...goHost.querySelectorAll('#cols .pf-card')]
  .filter((card) => card.getAttribute('role') === 'button')
  .map((card) => [
    card.querySelector('.pf-card-title')?.getAttribute('title') ?? '',
    card.getAttribute('aria-label') ?? '',
  ])
check(
  '能点的卡片，名字各自带着自己那一格的身份（一屏上彼此分得开）',
  liveNames.length > 0
    && liveNames.every(([nodeId, name]) => name.includes(nodeId.slice(0, 8)))
    && new Set(liveNames.map(([, name]) => name)).size === liveNames.length,
  `可点的卡片=${liveNames.map(([nodeId, name]) => `${nodeId.slice(0, 8)}→${JSON.stringify(name)}`).join(' ')}`,
)

/* 没有去处的卡片点下去：什么也不发生，控制台那条 error 由最后一节统一量。 */
const navBeforeInert = navCalls.length
const beforeInert = liveList.current
await clickOn(farCard)
await clickOn(bareCard)
check(
  '没有去处的卡片点下去什么都不发生：会话没换，导航口子没被叫到',
  liveList.current === beforeInert && navCalls.length === navBeforeInert,
  `会话=${liveList.current}（点之前 ${beforeInert}）｜ 口子收过 ${String(navCalls.length)} 次（点之前 ${String(navBeforeInert)} 次）`,
)

/* 留一手面板自己的状态：信息量拨到「铺满」，切走再回来时它该还在。 */
await clickOn(infoSeg('铺满'))
const infoBeforeJump = pressedInfo()

await clickOn(jumpCard)
const targetProject = readProject({ ...(await gateway.read(jumpSession, {})), at: new Date() })
const targetBoard = expectedBoard(targetProject, 3)
check(
  '点一张卡：活动会话切到记录里指出的那一条',
  liveList.current === jumpSession && navCalls[navCalls.length - 1] === jumpSession,
  `那一格写的是=${jumpSession} ｜ 活动会话=${liveList.current} ｜ 口子收过的=${navCalls.join(', ')}`,
)
check(
  '那一格的内容确实是它自己的：看板换成那条会话自己的工作区，与另一条会话的读数分得开',
  JSON.stringify(boardOf(goHost)) === JSON.stringify(targetBoard)
    && JSON.stringify(targetBoard) !== JSON.stringify(homeBoard),
  `前一条会话=${JSON.stringify(homeBoard)} ｜ 这一条会话自己的=${JSON.stringify(targetBoard)} ｜ 屏上=${JSON.stringify(boardOf(goHost))}`,
)

/* 切回来：那一条会话自己的工作区里也有这一格，回车与鼠标一样算数。 */
const backCard = cardFor(backNode ?? '')
check(
  '切过去之后，回程那一张卡照样是能点的',
  lived(backCard),
  `${labelOf(backNode)} ｜ role=${String(backCard?.getAttribute('role'))}`,
)
await act(async () => { backCard?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
await settle()
check(
  '回车也算数：切回原来那一条会话',
  liveList.current === backSession,
  `活动会话=${liveList.current}（要的是 ${backSession}）`,
)
check(
  '切走再回来：那一屏又是这条会话自己的工作区，面板自己那几个状态还在',
  JSON.stringify(boardOf(goHost)) === JSON.stringify(expectedBoard(homeProject, 3))
    && pressedInfo() === infoBeforeJump,
  `看板上=${JSON.stringify(boardOf(goHost))} ｜ 记录现算=${JSON.stringify(expectedBoard(homeProject, 3))} ｜ 信息量=${String(pressedInfo())}（切走之前 ${String(infoBeforeJump)}）`,
)
await act(async () => { goRoot.unmount() })

/* ---- 6a-2. 写回被拒：控件不许静默弹回，那一节现有的提示行要说得出来 --------------
 *
 * 同一趟往返里的第二笔踩到的就是这个：手里那个修订号已经过期，宿主把这一笔拒掉，交回来的
 * 只是一个 `false`（理由吞在它自己那里），面板那几处 `void …write(…)` 又把它丢掉。这一条让
 * 这份文档一律拒收，再翻一次开关：头一笔带围栏、第二笔摘掉围栏，两笔都不作数时设置页现有
 * 的那条提示行（`.pfset-msg`）上要摆出一句话。 */

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
 *
 * 真部署里「重启第二个实例」是另一个进程照同一份 `$DSH_HOME` 配置重新读一遍。夹具这一
 * 趟能到的最远处是：把刚才那份文档原样当作下一份文档的起点，重新走一遍 `apply`（新的
 * 上下文、新的注册名册、新的设置口子），再看新挂上来的面板与设置页读出来的是不是那几个
 * 值。浏览器级的第二实例（真起进程、真重启）不归这一格，见报告里的缺口。 */

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

/* ---- 6d. 卸载那一趟：停插件之后，四处都不留东西 --------------------------
 *
 * 完成判定第 2 条。另起一条插件（新名册、新落点、自己的 effect），把两处经真代码渲染一遍
 * ——两张样式表由渲染那条路挂上（`Entry` 的 `ensureStyle` 与设置页的 `ensureSettingsStyle`），
 * 再把它那几条 effect 全收掉：名册清空，两张标签从文档里摘干净。
 *
 * 清理那一趟的次序（先撤注册再摘样式）是设计意图，写在 `mount.ts` 的清理那一段里；这里与
 * 单测都只量终局——判定 2 要的是「四处都不留东西」，没有一条要求次序。 */

const unload = { ledger: new Map(), calls: [], effects: [] }
const unloaded = bootClient(backend, {}, unload)
check(
  '卸载那一趟：五条都登记上了',
  unload.ledger.size === 5,
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
  '卸载之后：名册清空，四处都没有残留',
  unload.ledger.size === 0,
  `名册=${[...unload.ledger.keys()].join(', ') || '（空）'}`,
)
check(
  '卸载之后：两张注入的样式标签都摘干净了',
  tagOf(client.PANEL_STYLE_ID) === null && tagOf(client.SETTINGS_STYLE_ID) === null,
  `面板那一张=${String(tagOf(client.PANEL_STYLE_ID))} 设置那一张=${String(tagOf(client.SETTINGS_STYLE_ID))}`,
)

/* ---- 7. 控制台 ---------------------------------------------------------- */

check('控制台没有 error', consoleErrors.length === 0, consoleErrors.length === 0 ? '0 条' : consoleErrors.join(' | '))

/* ---- 读数落文件 --------------------------------------------------------- */

const report = lines.join('\n')
writeFileSync(join(work, 'panel-check.txt'), `${report}\n`)
console.log(report)
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${String(lines.filter((line) => line.startsWith('ok  ')).length)} passed, ${String(failures.length)} failed`)
process.exit(failures.length === 0 ? 0 : 1)