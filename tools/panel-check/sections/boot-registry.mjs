/* Boot registry: the panel mounted as a service, the three seats it registers, the effect discipline
 *
 * Runs right after the fixture boots; every later section reuses its roster and backend. */

/** runBootRegistry */
export async function runBootRegistry(ctx) {
  const { client, t, backend, booted, panel, check, bootClient } = ctx

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
    '侧栏那一行上的名字是「寻路中心」，中央栏那一格与它同一个 id',
    booted.ledger.get(`sidebar.panellist:${client.PANEL_ID}`)?.options.label() === t(client.SEAT_WORD)
      && client.SEAT_WORD === 'seat.label' && t(client.SEAT_WORD) === '寻路中心'
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

  ctx.SEAT_ENTRIES = SEAT_ENTRIES
}
