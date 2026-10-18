/* 调度中心那两处挂载点：锁的是「注册了哪两条」与「卸载撤干净」。
 *
 * 锁的几条：
 *   1. 两处各自的槽位名、条目 id / key、order、侧栏那一行上的名字；
 *      中央栏那一格交出去的正好是**这次 apply 装的那块面板**。
 *   2. 收掉那条 effect：两条注册从名册上撤下来，两张注入的样式标签跟着摘掉（次序不锁，
 *      判定 2 要的是「都不留东西」）。
 *   3. 同一本名册上再起一条插件（profile 重载、HMR 会走到这里）：重复登记那一下抛在
 *      这一层里面，名册还是那两条。
 *   4. 没有 `effect` 的上下文上那一条路：两条照挂，这一层不往调用点交回清理函数——那种
 *      上下文上没有卸载通知可归（真 Cordis 的上下文都带 `effect`）。
 *   5. 会话身份那几手：`sessionsSnapshotOf` 靠恒等投影取回整份快照，`currentSessionOf` 从
 *      那份快照里挑当前那一条，`knownSessionsOf` 交出这台机器上此刻的名册，`createSessionNav`
 *      把身份递给 DSH 那条导航口子。
 *
 * 两处替身按真协议写：`slots.inject(key, register)` 收槽位名、跑那一趟注册；`slots.register`
 * 收 options + component，返回的摘除器能把那一条收回去，同一个 id 重复注册会抛（真协议
 * 就是这么抛的）。两张样式表的正文由 `styles.ts` / `settings.tsx` 各自持有，`virtual:pf-styles`
 * 在 Node 里解不开、这两份进不来单测；这里按同一对记号把标签挂上再量卸载——挂与摘认的是
 * 那两枚记号，卸载那一趟摘没摘干净，这里量得出来。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import {
  PANEL_ORDER,
  SEAT_LABEL,
  createSessionNav,
  currentSessionOf,
  knownSessionsOf,
  registerSeats,
  sessionsSnapshotOf,
} from '../src/client/mount.ts'
import { PANEL_STYLE_ID, SETTINGS_STYLE_ID, dropStyleTag, ensureStyleTag } from '../src/client/style-tags.ts'

/** 面板那一层交出去的 id 与名字；注册拿的就是这几个字。 */
const PANEL_ID = 'pathfinder'

/** 一处注册在名册上的钥匙：单座与列表认 `id`，按 key 分派的那一格认 `key`。 */
function entryKey(options) {
  return `${options.name}:${options.id ?? options.key}`
}

/**
 * 一架替身上下文：`slots`、`effect`、`inject` 三样都在，形状与真部署一致。
 * @param options - `effect: false` 时摘掉 `effect`，量「没有 effect 的上下文」那一条路；
 *   `services` 是这条上下文上另外挂着的服务（例如那条导航口子）。
 * @returns 名册、调用记录、effect 记录、以及把插件挂上去的那一手。
 */
function harness({ withEffect = true, services = {} } = {}) {
  const ledger = new Map()
  const calls = []
  const effects = []
  const slots = {
    inject(key, register) {
      calls.push(`inject/${key}`)
      const off = register()
      return typeof off === 'function' ? off : () => undefined
    },
    register(options, component) {
      const id = entryKey(options)
      calls.push(`register/${id}`)
      if (ledger.has(id)) throw new Error(`list slot "${options.name}" already has an entry with id "${String(options.id ?? options.key)}"`)
      ledger.set(id, { options, component })
      return () => { ledger.delete(id) }
    },
  }
  const ctx = {
    get: (name) => (name === 'slots' ? slots : services[name]),
    inject: (names, callback) => callback(ctx),
    provide: () => undefined,
  }
  if (withEffect) {
    ctx.effect = (run, name) => {
      const off = run()
      const dispose = () => { if (typeof off === 'function') off() }
      effects.push({ name, run, dispose })
      return dispose
    }
  }
  return { ledger, calls, effects, ctx }
}

/** 一块面板：组件与口子都是替身，量的是两条注册本身。 */
function fakePanel() {
  const Panel = () => null
  return {
    id: PANEL_ID,
    title: '寻路',
    port: { source: 'none' },
    prefs: {},
    Panel,
  }
}

test('两处注册：槽位、id / key、order、侧栏那一行的名字逐条对上', () => {
  const { ledger, ctx } = harness()
  const panel = fakePanel()

  registerSeats(ctx, panel, () => undefined)

  /* 两条各落在**不同**的槽位，谁先登记在 DSH 里没有语义（`order` 只在同一个 list 槽内部
   * 才有意义）：这里只量「哪两条在册」，不锁它们之间的先后。 */
  assert.deepEqual([...ledger.keys()].sort(), [
    `main:${PANEL_ID}`,
    `sidebar.panellist:${PANEL_ID}`,
  ].sort())

  const side = ledger.get(`sidebar.panellist:${PANEL_ID}`).options
  assert.equal(side.name, 'sidebar.panellist')
  assert.equal(side.id, PANEL_ID)
  assert.equal(side.order, PANEL_ORDER)
  assert.equal(typeof side.label, 'function')
  assert.equal(side.label(), SEAT_LABEL)
  assert.equal(side.label(), '调度中心')

  const main = ledger.get(`main:${PANEL_ID}`).options
  assert.equal(main.name, 'main')
  assert.equal(main.key, PANEL_ID)
  assert.equal(main.key === 'conversation', false)

  /* 两条各交了一件真东西出去，没有一条是空手登记。 */
  for (const [, entry] of ledger) assert.equal(typeof entry.component, 'function')
})

test('中央栏那一格交的是这次 apply 装的那块面板，口子、偏好与卡上那一下的去处都是它的', () => {
  const opened = []
  const { ledger, ctx } = harness({ services: { uiWorkspace: { openSession: (target) => opened.push(target) } } })
  const panel = fakePanel()

  registerSeats(ctx, panel, () => undefined)

  const main = ledger.get(`main:${PANEL_ID}`)
  assert.equal(main.component, panel.Panel)
  const given = main.options.inject()
  assert.deepEqual({ port: given.port, prefs: given.prefs }, { port: panel.port, prefs: panel.prefs })
  assert.equal(typeof given.openSession, 'function')
  given.openSession('session-7')
  assert.deepEqual(opened, ['session-7'])
})

test('那条导航口子还没到场：卡上那一下点下去什么也不发生，这一层不抛', () => {
  const { ledger, ctx } = harness()
  registerSeats(ctx, fakePanel(), () => undefined)

  const given = ledger.get(`main:${PANEL_ID}`).options.inject()
  assert.equal(typeof given.openSession, 'function')
  assert.doesNotThrow(() => { given.openSession('session-7') })
})

test('中央栏那一格另交出那份工作区清单：顶上那枚选择器读的就是它', () => {
  const items = [{ workspaceId: 'w-1', path: 'C:\\ws', title: '一个工作区', sessionIds: ['s-1'] }]
  const snapshot = { items }
  const { ledger, ctx } = harness({
    services: { workspaces: { list: { getSnapshot: () => snapshot, subscribe: () => () => undefined } } },
  })
  registerSeats(ctx, fakePanel(), () => undefined)

  const given = ledger.get(`main:${PANEL_ID}`).options.inject()
  assert.equal(typeof given.workspaces?.getSnapshot, 'function')
  assert.equal(typeof given.workspaces?.subscribe, 'function')
  assert.deepEqual(given.workspaces.getSnapshot().items, items)
})

test('工作区清单那份服务还没到场：交出去的是一份空名单，它一到场就叫一声', () => {
  const listeners = []
  const items = [{ workspaceId: 'w-1', path: 'C:\\ws', title: '一个工作区', sessionIds: ['s-1'] }]
  let registered
  const { ledger, ctx } = harness()
  /* 这条上下文上 `inject` 就是「立刻拿这个 owner 叫一次」；那一手在这里被记下来，
   * 量的是「服务晚到」那一趟：先给空名单，等它到场再通知订阅者。 */
  ctx.inject = (names, callback) => {
    if (names.includes('workspaces')) registered = callback
    else callback(ctx)
  }
  registerSeats(ctx, fakePanel(), () => undefined)

  const source = ledger.get(`main:${PANEL_ID}`).options.inject().workspaces
  assert.deepEqual(source.getSnapshot(), { items: [] })
  source.subscribe(() => listeners.push('changed'))
  assert.deepEqual(listeners, [])

  const snapshot = { items }
  registered({ get: (name) => (name === 'workspaces' ? { list: { getSnapshot: () => snapshot, subscribe: () => () => undefined } } : undefined) })
  assert.deepEqual(source.getSnapshot().items, items)
  assert.deepEqual(listeners, ['changed'])
})

test('同一份空名单：没有工作区清单时每次给出的都是同一个对象', () => {
  const { ledger, ctx } = harness()
  registerSeats(ctx, fakePanel(), () => undefined)

  const source = ledger.get(`main:${PANEL_ID}`).options.inject().workspaces
  assert.equal(source.getSnapshot(), source.getSnapshot())
})

test('收掉那条 effect：两条从名册上撤下来，两张样式标签跟着摘掉', () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  globalThis.document = dom.window.document

  const { ledger, effects, ctx } = harness()
  const panel = fakePanel()
  registerSeats(ctx, panel, () => {
    dropStyleTag(PANEL_STYLE_ID)
    dropStyleTag(SETTINGS_STYLE_ID)
  })

  /* 两张表经渲染那条路挂上（替身按同一对记号挂，见文件头）。 */
  ensureStyleTag(PANEL_STYLE_ID, '.pf-page{color:red}')
  ensureStyleTag(SETTINGS_STYLE_ID, '.pfset-page{color:red}')
  assert.equal(ledger.size, 2)
  assert.equal(dom.window.document.getElementById(PANEL_STYLE_ID) === null, false)
  assert.equal(dom.window.document.getElementById(SETTINGS_STYLE_ID) === null, false)

  const seats = effects.find((one) => one.name === 'dsh-pathfinder: seats')
  assert.equal(seats === undefined, false)
  seats.dispose()

  assert.equal(ledger.size, 0)
  assert.equal(dom.window.document.getElementById(PANEL_STYLE_ID), null)
  assert.equal(dom.window.document.getElementById(SETTINGS_STYLE_ID), null)

  /* 再跑一遍：两条又回到名册上，没有重复。 */
  seats.run()
  assert.equal(ledger.size, 2)
})

test('没有 effect 的上下文：两条照样挂上，这一层不往调用点交回清理函数', () => {
  const { ledger, effects, ctx } = harness({ withEffect: false })
  const panel = fakePanel()
  let stylesDropped = 0
  const handedBack = registerSeats(ctx, panel, () => { stylesDropped += 1 })

  assert.equal(effects.length, 0)
  assert.equal(ledger.size, 2)

  /* 这种上下文上没有卸载通知可归（真 Cordis 的上下文都带 `effect`）：这一层不交回清理
   * 函数，调用点也就接不到东西；两条注册与两张样式标签随这个上下文一起走。 */
  assert.equal(handedBack, undefined)
  assert.equal(stylesDropped, 0)
})

test('同一本名册上再起一条插件：重复登记那一下停在这一层里，名册还是那两条', () => {
  const { ledger, calls, effects, ctx } = harness()
  const panel = fakePanel()

  /* 那一条抛被这一层收住了，但收住不等于咽下去：每条各留一句警告。 */
  const warned = []
  const realWarn = console.warn
  console.warn = (...args) => { warned.push(args.map(String).join(' ')) }
  try {
    registerSeats(ctx, panel, () => undefined)
    registerSeats(ctx, panel, () => undefined)
  } finally {
    console.warn = realWarn
  }

  assert.equal(ledger.size, 2)
  assert.equal(calls.filter((call) => call.startsWith('register/')).length, 4)
  assert.equal(effects.length, 2)
  assert.equal(warned.length, 2)

  /* 第二条插件那一条 effect 手上没有东西可撤：它一条也没登记上，收掉它不该动名册。 */
  effects[1].dispose()
  assert.equal(ledger.size, 2)
})

test('座席标准 props 里的 useSessions 是一条带投影的 hook，整份快照要靠恒等投影取回来', () => {
  /* 真形状：`ids` 是宿主清单次序，`byId` 里当前会话那条挂着 `retainedBy.mainView`，
   * 清单第一行是**另一条**会话（副会话也会进 `byId`，它只是没挂 mainView）。 */
  const snapshot = {
    ids: ['other', 's1'],
    byId: {
      other: { id: 'other', retainedBy: {} },
      s1: { id: 's1', retainedBy: { mainView: 1 } },
    },
    phase: 'ready',
    projectionsBySession: {},
  }
  const seen = []
  const useSessions = (select) => { seen.push(select); return select(snapshot) }

  assert.deepEqual(sessionsSnapshotOf(useSessions), snapshot)
  assert.equal(seen.length, 1)
  assert.equal(typeof seen[0], 'function')
  assert.equal(snapshot.ids[0], 'other')

  /* 当前会话落在 `ids` 第二位时挑的仍是它：`retainedBy.mainView` 那条。 */
  assert.equal(currentSessionOf(snapshot), 's1')

  /* 没人挂 `mainView` 时不许凭 `byId` 的键序挑人。 */
  assert.equal(currentSessionOf({ ids: [], byId: { z: { id: 'z', retainedBy: {} } }, phase: 'ready' }), undefined)

  /* 三个身份探针还在，服务别的形状与替身：有它们时先认它们。 */
  assert.equal(currentSessionOf({ ...snapshot, selectedId: 'picked' }), 'picked')

  /* 三者都没有、`mainView` 也没有时，落到 `ids[0]` 那条末尾兜底。 */
  const noMainView = { ids: ['first'], byId: { first: { id: 'first', retainedBy: {} } }, phase: 'ready' }
  assert.equal(currentSessionOf(noMainView), 'first')

  /* 这个部署上没有这条 hook 时什么都不是，不许抛。 */
  assert.equal(sessionsSnapshotOf(undefined), undefined)
  assert.equal(currentSessionOf(undefined), undefined)
})

test('会话名册：宿主清单与本地清单行两处都算数，其余的不许进册', () => {
  const snapshot = {
    ids: ['s1', '', 's2'],
    byId: {
      s2: { id: 's2', retainedBy: {} },
      s3: { id: 's3', retainedBy: { mainView: 1 } },
      '': { id: '', retainedBy: {} },
    },
    phase: 'ready',
  }

  assert.deepEqual([...knownSessionsOf(snapshot)].sort(), ['s1', 's2', 's3'])
  /* 空身份各处都不进册：记录里那条会话是空串时，卡片照样没有去处。 */
  assert.equal(knownSessionsOf(snapshot).has(''), false)
  /* 快照拿不到、或者 `ids` / `byId` 的形状不对时，交回一份空名册。 */
  assert.deepEqual([...knownSessionsOf(undefined)], [])
  assert.deepEqual([...knownSessionsOf({ ids: 's1', byId: null })], [])
})

test('切会话那一手：接上导航口子就把身份递过去，没接上就安安静静', () => {
  const opened = []
  const nav = createSessionNav({
    get: (name) => (name === 'uiWorkspace' ? { openSession: (target) => opened.push(target) } : undefined),
  })
  nav.open('session-7')
  assert.deepEqual(opened, ['session-7'])

  /* 口子晚一层到：这一层先在 `inject` 上等它，到了场就接上。 */
  const late = []
  let arrived
  const waiting = createSessionNav({
    get: () => undefined,
    inject: (names, callback) => { arrived = () => callback({ get: (name) => (name === 'uiWorkspace' ? { openSession: (target) => late.push(target) } : undefined) }) },
  })
  waiting.open('session-early')
  assert.deepEqual(late, [])
  arrived()
  waiting.open('session-late')
  assert.deepEqual(late, ['session-late'])

  /* 口子上那一手自己抛：停在这一层里，不往上带，那一下留一条警告。 */
  const warned = []
  const realWarn = console.warn
  console.warn = (...args) => { warned.push(args.map(String).join(' ')) }
  try {
    const noisy = createSessionNav({ get: (name) => (name === 'uiWorkspace' ? { openSession: () => { throw new Error('切不动') } } : undefined) })
    assert.doesNotThrow(() => { noisy.open('session-7') })
  } finally {
    console.warn = realWarn
  }
  assert.match(warned.join('\n'), /切不动/u)
})