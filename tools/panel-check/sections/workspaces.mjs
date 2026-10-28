/* The two dispatch-center seats mounted for real, then the four off-record workspaces: empty, unreadable, bare, pool-only
 *
 * Each render pins what the panel collapses to when a source is missing or unreadable.
 * Cut as-is from the single-file fixture (8743643): the criteria, the readings, the section
 * names and their order are untouched — this is a move, not a rewrite. */

/** runWorkspaces */
export async function runWorkspaces(ctx) {
  const { window, React, act, createRoot, client, t, booted, panel, trackedPort, settle, check, project, tabs, container, root, sessionId, saidNoRecord, saidUnreadable, saidNotEnabled, emptyWorkspace, emptySessionId, brokenWorkspace, brokenSessionId, bareWorkspace, bareSessionId, poorWorkspace, poorSessionId } = ctx

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
    `空记录的工作区：面板正文只留「${saidNoRecord}」，标签、计数与五格一起收走`,
    emptyHost.querySelector('.pf-none') !== null
      && emptySaid === saidNoRecord
      && emptyHost.querySelector('.pf-tabs') === null
      && emptyHost.querySelector('.pf-count') === null
      && emptyHost.querySelectorAll('.pf-pane').length === 0,
    `工作区=${emptyWorkspace.replace(root, '.')}（没有 .pf） ｜ .pf-none p=${JSON.stringify(emptySaid)} ｜ 标签 ${String(emptyHost.querySelectorAll('.pf-tabs').length)} 处、计数 ${String(emptyHost.querySelectorAll('.pf-count').length)} 处、五格 ${String(emptyHost.querySelectorAll('.pf-pane').length)} 处`,
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
    `记录读不动的工作区：面板正文摆「${saidUnreadable}」，与「没有记录」那句分得开`,
    brokenHost.querySelector('.pf-none') !== null
      && brokenSaid === saidUnreadable
      && brokenSaid !== saidNoRecord
      && brokenHost.querySelector('.pf-tabs') === null
      && brokenHost.querySelector('.pf-count') === null
      && brokenHost.querySelectorAll('.pf-pane').length === 0,
    `工作区=${brokenWorkspace.replace(root, '.')}（.pf 在、四份读不动） ｜ .pf-none p=${JSON.stringify(brokenSaid)} ｜ 标签 ${String(brokenHost.querySelectorAll('.pf-tabs').length)} 处、计数 ${String(brokenHost.querySelectorAll('.pf-count').length)} 处、五格 ${String(brokenHost.querySelectorAll('.pf-pane').length)} 处`,
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
    `有节点、问题池空的工作区：四个跟节点走的格子照旧，问题那一格收成「${saidNotEnabled}」`,
    bareHost.querySelector('.pf-none') === null
      && bareHost.querySelector('#pane-map .pf-rail') !== null
      && bareHost.querySelectorAll('#pane-map .pf-mnode').length > 0
      && bareHost.querySelector('#census .pf-pill') !== null
      && bareHost.querySelector('#pane-config') !== null
      && bareHost.querySelector('#pane-config .pf-innone') === null
      && bareSaid === saidNotEnabled
      && bareHost.querySelector('#pane-issue .pf-split') === null,
    `工作区=${bareWorkspace.replace(root, '.')}（管线在、问题池那一份不在） ｜ 地图 ${String(bareHost.querySelectorAll('#pane-map .pf-mnode').length)} 格 ｜ 问题那一格说=${JSON.stringify(bareSaid)}`,
  )

  /* The issue-pool-only case (what `pf issue scan` writes in a repo with no pipeline yet): each of
   * the four node-following panes collapses to the same sentence, and the header counts stop
   * reporting three zeros; the issue pane is the exception — it still draws the pool, every entry of it. */
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
      && poorSaid.every((said) => said === saidNotEnabled)
      && poorHost.querySelectorAll('.pf-tabs').length === 1
      && poorHost.querySelectorAll('.pf-pane').length === 5
      && poorHost.querySelector('#pane-map .pf-rail') === null
      && poorHost.querySelector('#census') === null
      && (project.pool.rows.length === 0
        ? poorIssueSaid === saidNotEnabled
        : poorIssueSaid === ''
          && poorHost.querySelector('#pane-issue .pf-split') !== null
          && JSON.stringify(poorRows.map((row) => row.getAttribute('data-issue'))) === JSON.stringify(poorOpenIds)),
    `工作区=${poorWorkspace.replace(root, '.')}（只有问题池） ｜ 四格=${JSON.stringify(poorSaid)} ｜ 页头计数 ${String(poorHost.querySelectorAll('#census').length)} 处、五格 ${String(poorHost.querySelectorAll('.pf-pane').length)} 格 ｜ 池子读数 共 ${String(project.pool.rows.length)} 条、未解决 ${String(poorOpenIds.length)} 条 ｜ 问题那一格 ${String(poorRows.length)} 行`,
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

  /* The readable record stays as usual: tabs, counts and five panes all present, no such sentence in the body. */
  check(
    '这一份记录读得回来：五格标签、右上那排计数与五格正文照旧画着，正文里没有那句话',
    tabs.length === 5 && container.querySelector('.pf-count') !== null
      && container.querySelectorAll('.pf-pane').length === 5
      && container.querySelector('.pf-none') === null,
    `标签 ${String(tabs.length)} 枚 ｜ 计数 ${String(container.querySelectorAll('.pf-count').length)} 处 ｜ 五格 ${String(container.querySelectorAll('.pf-pane').length)} 格 ｜ .pf-none ${container.querySelector('.pf-none') === null ? '（没有）' : '画了出来'}`,
  )

  ctx.flat = flat
  ctx.sessionsAt = sessionsAt
}
