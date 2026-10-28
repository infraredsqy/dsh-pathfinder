/* 5. The detail split: really present, really draggable, still there after reopening; then 6a-2, rejected writes must not be silent
 *
 * The settings section’s existing note line speaks on refusal — on both surfaces. */

/** runDetailAndRefuse */
export async function runDetailAndRefuse(ctx) {
  const { window, React, act, settle, check, container, tabs, reactRoot, winningDeclarations, settingsDoc, settingsForm, rowNamed, flipSwitch, settingsHost, panel, trackedPort, createRoot, sessionId } = ctx

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

}
