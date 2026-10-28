/* The top workspace picker and the CSS token landings
 *
 * Whichever workspace is picked is the one read; the shipped sheet lands its tokens on the panel root. */

/** runPickerAndTokens */
export async function runPickerAndTokens(ctx) {
  const { window, React, act, createRoot, panel, trackedPort, settle, setSelect, check, saidNoRecord, saidUnreadable, saidUngroupedEmpty, root, workspace, emptyWorkspace, emptySessionId, brokenWorkspace, brokenSessionId, sessionId, container, askedRoots, winningDeclarations, flat } = ctx

  /* ---- 3d. The top workspace picker: whichever is picked is the one read ----
   *
   * The list follows DSH's manifest (titles plus the trailing "Ungrouped" entry), the default stays
   * on the bucket this session falls in, and switching entries hands that root to the host with the
   * screen swapping to what that root reads. Switches hand over absolute paths (`askedRoots` compares
   * per entry); "Ungrouped" is not a root, and splits in two: when the session
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
    await setSelect(spaceSelect(), value)
  }

  askedRoots.length = 0
  await pickWorkspace('w-empty')
  const spaceEmpty = flat(spaceHost.querySelector('.pf-none p'))
  check(
    `拨到空记录那个工作区：递出去的是它的绝对路径，正文当场换成「${saidNoRecord}」`,
    askedRoots.includes(emptyWorkspace) && spaceEmpty === saidNoRecord
      && spaceHost.querySelector('.pf-tabs') === null && spaceHost.querySelectorAll('.pf-pane').length === 0,
    `问过的根=${JSON.stringify([...new Set(askedRoots)].map((one) => (one === '' ? '（空）' : one.replace(root, '.'))))} ｜ .pf-none p=${JSON.stringify(spaceEmpty)}`,
  )

  askedRoots.length = 0
  await pickWorkspace('w-broken')
  const spaceBroken = flat(spaceHost.querySelector('.pf-none p'))
  check(
    `拨到读不动那个工作区：正文摆的是「${saidUnreadable}」，与「没有记录」分得开`,
    askedRoots.includes(brokenWorkspace) && spaceBroken === saidUnreadable
      && spaceBroken !== saidNoRecord,
    `问过的根=${JSON.stringify([...new Set(askedRoots)].map((one) => (one === '' ? '（空）' : one.replace(root, '.'))))} ｜ .pf-none p=${JSON.stringify(spaceBroken)}`,
  )

  askedRoots.length = 0
  await pickWorkspace('')
  const spaceUngrouped = flat(spaceHost.querySelector('.pf-none p'))
  const ungroupedSelect = spaceHost.querySelector('.pf-head .pf-pick select')
  check(
    `拨到「未分组」：这条会话有归属，一趟读数都不发，正文收成「${saidUngroupedEmpty}」那一句，选择器还留着`,
    askedRoots.length === 0 && spaceUngrouped === saidUngroupedEmpty
      && ungroupedSelect !== null && ungroupedSelect.value === ''
      && spaceHost.querySelector('.pf-tabs') === null && spaceHost.querySelectorAll('.pf-pane').length === 0,
    `问过的根=${JSON.stringify([...new Set(askedRoots)])} ｜ .pf-none p=${JSON.stringify(spaceUngrouped)} ｜ 选择器=${ungroupedSelect === null ? '（没了）' : `选中=${JSON.stringify(ungroupedSelect.value)}`} ｜ 五格 ${String(spaceHost.querySelectorAll('.pf-pane').length)} 格`,
  )

  await act(async () => { spaceRoot.unmount() })

  /* The session truly outside every workspace: the same manifest, only no bucket carries this session —
   * DSH files it under "Ungrouped" and defaults there; it still reads its own root. */
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
  await setSelect(loneSelect(), 'w-empty')
  askedRoots.length = 0
  await setSelect(loneSelect(), '')
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
   * stage and the frame that fills it: the stage takes the pane under the header and scrolls when the
   * footprint is short, and the frame fills the footprint — width and height both, in every view. */
  const stageWon = winningDeclarations(container.querySelector('.pf-stage'), ['padding', 'overflow-y', 'justify-content'])
  const frameWon = winningDeclarations(container.querySelector('.pf-frame'), ['width', 'height', 'display'])
  check(
    '舞台与框在蓝本里的有效值进了包',
    stageWon.padding === '8px 0' && stageWon['overflow-y'] === 'auto' && stageWon['justify-content'] === 'center'
      && frameWon.width === '100%' && frameWon.height === '100%' && frameWon.display === 'flex',
    `stage padding=${JSON.stringify(stageWon.padding)} overflow-y=${JSON.stringify(stageWon['overflow-y'])} justify-content=${JSON.stringify(stageWon['justify-content'])} ｜ frame width=${JSON.stringify(frameWon.width)} height=${JSON.stringify(frameWon.height)} display=${JSON.stringify(frameWon.display)}`,
  )

}
