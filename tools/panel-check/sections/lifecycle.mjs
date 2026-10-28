/* 6b-6e. Restart from the same document, the localStorage sweep, the unload pass and the hot-reload pass
 *
 * Positive readings at all three clear points: roster, seats, the two injected style tags. */

/** runLifecycle */
export async function runLifecycle(ctx) {
  const { window, React, act, settle, createRoot, client, makeConfigForms, bootClient, SEAT_ENTRIES, backend, settingsDoc, poolCleared, trackedPort, container, LEGACY_SEEDED, sessionsAt, emptySessionId, sessionId, check } = ctx

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
      && (poolCleared
        ? /* 零行形态：登记簿不上屏，那一档跟着它一起不在，档位只落在文档里 */ restartedFull === undefined
        : restartedFull === (keptPrefs.showOtherStates === true ? '完整' : '精简')),
    `文档=${JSON.stringify(keptPrefs)} ｜ 面板上 标签=${String(restartedTab)} 宽度=${String(restartedWidth)} 问题池=${poolCleared ? `（池子已清空：不上屏）${String(restartedFull)}` : String(restartedFull)}`,
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

}
