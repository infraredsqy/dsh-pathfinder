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

const failures = []
const lines = []
function check(what, ok, reading) {
  lines.push(`${ok ? 'ok  ' : 'FAIL'}  ${what}  ${reading}`)
  if (!ok) failures.push(what)
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
  return {
    async resolveExecutable(command) {
      return await new Promise((resolve, reject) => {
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

const hostCtx = {
  workspaceFiles: workspaceFiles(workspace),
  sessions: {
    get: (id) => {
      if (id === sessionId) return { header: { cwd: workspace } }
      if (id === parkedSessionId) return { header: { cwd: parkedWorkspace } }
      return undefined
    },
  },
  sandboxPolicy: { workspaceRoot: workspace },
  get: (name) => (name === 'sessionPersistence' ? undefined : name === 'subprocess' ? spawner() : undefined),
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
  read: wrapped((...values) => gateway.read(...values)),
  archiveInstruction: wrapped((...values) => gateway.archiveInstruction(...values)),
  reviveInstruction: wrapped((...values) => gateway.reviveInstruction(...values)),
  removeInstruction: wrapped((...values) => gateway.removeInstruction(...values)),
  setCyclePolicy: wrapped((...values) => gateway.setCyclePolicy(...values)),
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
      const id = `${options.name}:${options.id}`
      calls.push(`register/${id}`)
      if (ledger.has(id)) throw new Error(`list slot "${options.name}" already has an entry with id "${options.id}"`)
      ledger.set(id, { options, component })
      return () => { ledger.delete(id) }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'remote.pathfinderRecords') return remoteFace
      if (name === 'slots') return slots
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
/* 这一层现在只注册一样东西：设置里那一节。`main` 与 `sidebar.panellist` 两座席仍然留给
 * 下游的挂载点那一格——夹具这里问的是「注册了哪些」，一份名册比一句「碰没碰 slots」经得起看。 */
const registeredIds = [...booted.ledger.keys()]
check(
  '这一层只注册了设置里那一节，座席那两排留给下游',
  registeredIds.length === 1 && registeredIds[0] === `${client.SECTION_SLOT}:${client.SETTINGS_NAMESPACE}`,
  registeredIds.length === 0 ? 'slots 上一个注册都没有' : `注册=${registeredIds.join(', ')}`,
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
  reuse.ledger.size === 1 && [...reuse.ledger.keys()][0] === `${client.SECTION_SLOT}:${client.SETTINGS_NAMESPACE}`
    && reuse.calls.filter((call) => call.startsWith('register/')).length === 2,
  `名册=${[...reuse.ledger.keys()].join(', ') || '（空）'} ｜ 试过注册 ${String(reuse.calls.filter((call) => call.startsWith('register/')).length)} 次`,
)

/* 同一条 effect 收掉再跑一遍（fiber 重入那一趟）：先撤上一次，再登记回来。
 * 接设置表单那一手另有一条 effect（m4）：收掉它，接在设置表单上的那个订阅者要跟着还回去。 */
const sectionEffect = reuse.effects.find((one) => one.name === 'dsh-pathfinder: settings page')
const formEffect = reuse.effects.find((one) => one.name === 'dsh-pathfinder: settings form')
const sharedForm = backend.form(client.SETTINGS_NAMESPACE)
check(
  '接设置表单那一手与登记那一页那一手各是一条 effect',
  formEffect !== undefined && sectionEffect !== undefined && formEffect !== sectionEffect,
  `effect=${reuse.effects.map((one) => String(one.name)).join(', ')}`,
)
check(
  '三趟 apply 各在设置表单上接了一个订阅者',
  sharedForm?.watching() === 3,
  `订阅者=${String(sharedForm?.watching())}`,
)
sectionEffect.off()
check('收掉那一条 effect：设置那一节从名册上撤下来', reuse.ledger.size === 0, `名册=${[...reuse.ledger.keys()].join(', ') || '（空）'}`)
sectionEffect.run()
check(
  'effect 再跑一遍：又登记回同一条，没有重复',
  reuse.ledger.size === 1 && [...reuse.ledger.keys()][0] === `${client.SECTION_SLOT}:${client.SETTINGS_NAMESPACE}`,
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

/* 取数那一趟的完成通知：面板每次读都把那个 promise 交到这里，夹具等的是**那一个**
 * promise 本身，不猜它多久回来。 */
const inFlight = []
const track = (promise) => {
  inFlight.push(promise.catch(() => undefined))
  return promise
}
/** 写面被叫过几次：两个新看法一遍点下来，这一次数必须停在原地。 */
const writeCalls = []
const trackedPort = {
  ...panel.port,
  read(id, signal) {
    return track(panel.port.read(id, signal))
  },
  write(verb, id, target) {
    writeCalls.push(`write/${verb}`)
    return track(panel.port.write(verb, id, target))
  },
  setPolicy(id, cycle, key, value) {
    writeCalls.push(`setPolicy/${key}`)
    return track(panel.port.setPolicy(id, cycle, key, value))
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
 * 对得上；差额只允许是明写取进来的 `CARRIED` 那两条。
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
const CARRIED = [{ sheet: 'styles/settings.css', selectors: ['.pf-stage', '.pf-frame'] }]
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
  '整张 settings.css 不进包，只按明写取进来的两条（.pf-stage / .pf-frame）与 mock/ 逐条等价',
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
}

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
  secondSection !== undefined && second.ledger.size === 1,
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

/* ---- 7. 控制台 ---------------------------------------------------------- */

check('控制台没有 error', consoleErrors.length === 0, consoleErrors.length === 0 ? '0 条' : consoleErrors.join(' | '))

/* ---- 读数落文件 --------------------------------------------------------- */

const report = lines.join('\n')
writeFileSync(join(work, 'panel-check.txt'), `${report}\n`)
console.log(report)
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${String(lines.filter((line) => line.startsWith('ok  ')).length)} passed, ${String(failures.length)} failed`)
process.exit(failures.length === 0 ? 0 : 1)