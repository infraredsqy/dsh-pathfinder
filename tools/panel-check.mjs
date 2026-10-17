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
function expectedNoteGroups(project) {
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
/* 座席那一格给的是个会记下动作的替身：这一层真要往 `slots` 上注册点什么，这里就留得下痕迹。
 * 旧写法问的是夹具自己那份 `get` 返不返回 `undefined`——那是夹具自己没造 `slots`，
 * 面板碰没碰它，那句话管不着，横竖不会红。 */
const slotCalls = []
const slotRecorder = new Proxy({}, {
  get: (_target, key) => (...args) => { slotCalls.push(`${String(key)}/${String(args.length)}`) },
})
const clientCtx = {
  get: (name) => {
    if (name === 'remote.pathfinderRecords') return remoteFace
    if (name === 'slots') return slotRecorder
    return undefined
  },
  provide: (key, value) => { provided[key] = value },
}
client.apply(clientCtx)
const panel = provided[client.SERVICE_KEY]
check('面板装成了一条服务', panel !== undefined && panel.id === 'pathfinder', `key=${client.SERVICE_KEY} id=${String(panel?.id)}`)
check('座席注册留给下游：这一层不碰 slots', slotCalls.length === 0, slotCalls.length === 0 ? 'slots 上一个动作都没有' : slotCalls.join(', '))

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
const trackedPort = {
  ...panel.port,
  read(id, signal) {
    return track(panel.port.read(id, signal))
  },
  write(verb, id, target) {
    return track(panel.port.write(verb, id, target))
  },
  setPolicy(id, cycle, key, value) {
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
  reactRoot.render(React.createElement(panel.Panel, { port: trackedPort, sessionId }))
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
  ['已成', project.columns.completed.length],
  ['在手', project.columns.running.length],
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
const SHEETS = ['tokens.css', 'styles/main.css', 'styles/board.css', 'styles/lines.css', 'styles/detail.css', 'styles/notes.css']
const CARRIED = [{ sheet: 'styles/settings.css', selectors: ['.pf-stage', '.pf-frame'] }]
const SCOPE = '.pf-page'
/** 蓝本里写在页面根上的那几段：收拢后落到面板根自己身上（判据 6 那两条读数管着它们）。 */
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

/** 「这一段已经收进面板那一层了」——切段之后逐段比，不看子串（`.pf-pagewrap` 不算）。 */
function alreadyScoped(part) {
  return part
    .split(/[\s>+~]+/u)
    .flatMap((segment) => segment.split(/[.#:[\]]/u))
    .some((token) => token === SCOPE.slice(1))
}

/** 这一段选择器进包之后该长成哪几段——这张表就是进包的约定，明写在这儿、与构建口各写一份。 */
function expectedPart(part) {
  const low = part.toLowerCase()
  if (low === '*') return [SCOPE, `${SCOPE} *`]
  if (low.startsWith('*::')) return [`${SCOPE}${part.slice(1)}`, `${SCOPE} ${part}`]
  if (PAGE_ROOTS.has(low)) return [SCOPE]
  return alreadyScoped(part) ? [part] : [`${SCOPE} ${part}`]
}

/** 一整串选择器（逗号列表）收拢后的样子：重复的只留一条。 */
function expectedPrelude(prelude) {
  const parts = prelude
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .flatMap((part) => expectedPart(part))
  return [...new Set(parts)].join(', ')
}

/** `mock/` 那一侧算出来的期望样子。`@keyframes` 这类整块原样带走，里面没有选择器可收拢。 */
function expectedOf(entry) {
  return {
    wrap: entry.wrap,
    prelude: entry.prelude.startsWith('@') ? entry.prelude : expectedPrelude(entry.prelude),
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
for (const sheet of SHEETS) {
  const expected = ruleEntries(readFileSync(join(root, 'mock', sheet), 'utf8')).map(expectedOf)
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
    return kept.length > 0 ? [expectedOf({ ...entry, prelude: [...new Set(kept)].join(', ') })] : []
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
  `产物 ${String(productEntries.length)} 条 ｜ 六张表 + CARRIED 算出来 ${String(cursor)} 条`,
)
lines.push(`      等价性：mock/ 那 ${String(SHEETS.length)} 张表 + CARRIED ${String(carriedWanted.length)} 条 → 产物 ${String(productEntries.length)} 条规则，逐条比选择器与声明正文（上面每张表一条读数）`)

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
const wantGroups = expectedNoteGroups(project)
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
  check('重读之后面板把它读作已归档', (notes()?.textContent ?? '').includes('已归档'), 'notes 上有那一行')

  /* 复原也是从界面上按：那一行现在摆的是「复原」。 */
  const reviveKey = buttonOf(rowOf(), '复原')
  check('归档之后那一行摆的是复原', reviveKey !== undefined, '复原')
  if (reviveKey !== undefined) await click(reviveKey)
  const revived = JSON.parse(readFileSync(join(record, 'instructions.json'), 'utf8')).instructions.find((entry) => entry.id === live.id)
  check('复原：它又回到 live', revived?.state === 'live', `state=${String(revived?.state)}`)
  check('复原之后面板上不再标已归档', (notes()?.textContent ?? '').includes('已归档') === false, '那一行回到了生效那一堆')

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
 * pointermove → pointerup。读数落两处——缝上的 aria-valuenow 与本地存储，手写存储不算数。 */
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
const widthStored = window.localStorage.getItem('dsh-pathfinder.sideWidth')
check(
  '真的拖一下：读数跟着指针走，松手之后宽度落进本地存储',
  widthDragged === widthBefore + 40 && widthStored === String(widthDragged),
  `拖前 ${String(widthBefore)} → 拖到 ${String(widthDragged)} ｜ 本地存储=${String(widthStored)}`,
)
await act(async () => { reactRoot.unmount() })
const again = createRoot(container)
await act(async () => { again.render(React.createElement(panel.Panel, { port: trackedPort, sessionId })) })
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
  await act(async () => { parkedRoot.render(React.createElement(panel.Panel, { port: trackedPort, sessionId: parkedSessionId })) })
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

/* ---- 7. 控制台 ---------------------------------------------------------- */

check('控制台没有 error', consoleErrors.length === 0, consoleErrors.length === 0 ? '0 条' : consoleErrors.join(' | '))

/* ---- 读数落文件 --------------------------------------------------------- */

const report = lines.join('\n')
writeFileSync(join(work, 'panel-check.txt'), `${report}\n`)
console.log(report)
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${String(lines.filter((line) => line.startsWith('ok  ')).length)} passed, ${String(failures.length)} failed`)
process.exit(failures.length === 0 ? 0 : 1)