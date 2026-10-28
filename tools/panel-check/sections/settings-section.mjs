/* 4a. The settings section: a navigation row plus the page it opens, reading the same settings form as the panel
 *
 * Flip one row and the panel reading follows at once; also carries the detail-group readings and the instruction CRUD. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** runSettingsSection */
export async function runSettingsSection(ctx) {
  const { window, React, act, createRoot, settle, click, setSelect, check, lines, container, tabs, booted, backend, client, t, groupWord, project, gateway, record, sessionId, outcomeText } = ctx

  /**
   * Which groups the instructions pane should show: recomputed from the record as of now, ordered by
   * the panel pane's reader order — global first, then the record's cycles, then unrecognized scopes,
   * then the last group; empty groups are not drawn.
   *
   * The reading carries a key per group and nothing else; what that group is CALLED is the client's
   * word, so the heading is spelled through the shipped lookup table (`groupWord`) rather than carried
   * out of the model — the panel compares its head against this same spelling.
   */
  function expectedNoteGroups(project, showArchived) {
    const groups = new Map()
    const hold = (key) => {
      if (!groups.has(key)) groups.set(key, [])
      return groups.get(key)
    }
    hold('global')
    for (const cycle of project.cycles) hold(`cycle:${cycle.id}`)
    hold('cycle:')
    hold('node')
    for (const entry of project.instructions) {
      /* Archived entries stay hidden by default: they return to their groups only once the settings switch is on. */
      if (showArchived !== true && entry.standing !== true) continue
      const key = entry.scope === 'global'
        ? 'global'
        : entry.scope === 'cycle'
          ? (entry.cycleId === null ? 'cycle:' : `cycle:${entry.cycleId}`)
          : 'node'
      hold(key).push(entry)
    }
    const order = ['global', ...[...groups.keys()].filter((key) => key.startsWith('cycle:') && key !== 'cycle:'), 'cycle:', 'node']
    return order
      .filter((key) => groups.get(key).length > 0)
      .map((key) => ({
        label: groupWord(t, { key }),
        rows: groups.get(key)
          .slice()
          .sort((left, right) => ((left.inForce ? 0 : 1) - (right.inForce ? 0 : 1))
            || ((right.saidAt?.getTime() ?? 0) - (left.saidAt?.getTime() ?? 0)))
          .map((entry) => entry.text ?? ''),
      }))
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
  /* ---- 4a. The settings section: a navigation row + the page it opens, reading the same settings form as the panel ----
   * This section lives in DSH's own settings panel, not in the main panel's tree, so the product's
   * registered component is mounted into a DOM of its own here. The criterion: flip one row and the
   * panel's corresponding reading follows at once.
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
    '设置里那一页是三行，侧栏宽度不在其中',
    settingRows().length === 3 && rowNames.join('/') === '默认标签页/指令里显示已归档的/问题池里显示未解决之外的',
    `三行=${rowNames.join('/') || '（一行都没有）'}`,
  )

  const flipSwitch = async (label) => {
    const button = rowNamed(label)?.querySelector('.pfset-switch')
    await act(async () => { button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await settle()
  }

  /* Default tab: picking "Instructions" in settings switches the panel to that pane at once. The row
   * is picked by its word (the driver takes values), so the word's entry is found first. */
  const tabPick = () => rowNamed('默认标签页')?.querySelector('.pfset-select')
  const pickTab = async (word) => {
    const select = tabPick()
    const option = [...(select?.options ?? [])].find((one) => one.textContent === word)
    if (select === null || select === undefined || option === undefined) return
    await setSelect(select, option.value)
  }
  await pickTab('指令')
  check(
    '翻设置里「默认标签页」那一行：面板当场停到那一格',
    container.querySelector('#tab-notes')?.getAttribute('aria-selected') === 'true' && settingsDoc().defaultTab === 'notes',
    `选中的标签=${String(container.querySelector('.pf-tab[aria-selected="true"]')?.id)} ｜ 文档里 defaultTab=${String(settingsDoc().defaultTab)}`,
  )
  await pickTab('地图')

  await act(async () => { tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  const detailA = detailReadings(container)
  check(
    '明细的组头按记录长出来',
    detailA.length > 0,
    detailA.map((group) => `${group.label}(${String(group.rows.length)})`).join('/'),
  )
  /* The detail pane is exactly the rows a reader clicks in for: nodes with a title in the record print
   * that title on their row; and the pane opens with every group expanded — folding is the reader's move. */
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
  /* Folding stays in the reader's hands: one press on a group head folds it and reports its row count at the right; another press unfolds. */
  const doneWord = t('state.done')
  const completedRowsWant = detailA.find((group) => group.label === doneWord)?.rows.length ?? 0
  const completedHead = [...container.querySelectorAll('#pane-detail .pf-rowhead')]
    .find((head) => head.querySelector('.pf-rowhead-key')?.textContent === doneWord)
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
      && afterFold.every((group) => (group.label === doneWord ? group.folded : group.folded === false))
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

    /* The archive action is pressed from the panel's own button: the write face runs from UI all the way to the tool, then reads back. */
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

    /* Flip "show archived instructions" on: archived entries return to their groups, and the row's action becomes "Revive". */
    await flipSwitch('指令里显示已归档的')
    check(
      '翻设置里「指令里显示已归档的」：已归档的当场回到页面上，右边那枚是复原',
      (notes()?.textContent ?? '').includes(live.text) === true
        && (rowOf()?.textContent ?? '').includes('已归档')
        && buttonOf(rowOf(), '复原') !== undefined
        && settingsDoc().showArchived === true,
      `那一行=${(rowOf()?.textContent ?? '（没有这一行）').slice(0, 48)} ｜ 文档里 showArchived=${String(settingsDoc().showArchived)}`,
    )

    /* Revive is pressed from the UI too: the row now carries "Revive". */
    const reviveKey = buttonOf(rowOf(), '复原')
    check('归档之后那一行摆的是复原', reviveKey !== undefined, '复原')
    if (reviveKey !== undefined) await click(reviveKey)
    const revived = JSON.parse(readFileSync(join(record, 'instructions.json'), 'utf8')).instructions.find((entry) => entry.id === live.id)
    check('复原：它又回到 live', revived?.state === 'live', `state=${String(revived?.state)}`)
    check('复原之后面板上不再标已归档', (notes()?.textContent ?? '').includes('已归档') === false, '那一行回到了生效那一堆')
    /* Flip the row back off at the end: the later readings return to this pass's starting tier. */
    await flipSwitch('指令里显示已归档的')
    check(
      '翻回关上：归档的收起来，文档里那一格也回到关着',
      settingsDoc().showArchived === false && (notes()?.textContent ?? '').includes('已归档') === false,
      `文档里 showArchived=${String(settingsDoc().showArchived)}`,
    )

    /* Delete: the original text is shown first; the second press does the deed. */
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
    check('删除之后复原拿不回来', restore.ok === false, `revive=${outcomeText(restore).split('\n')[0].slice(0, 60)}`)
  }

  /* Add a note: write one sentence through this row — panel → host → tool → record, read back onto
     the page. The global scope is picked: this check is about the path working; scope-to-cycle
     binding has its own check. */
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

  ctx.settingsForm = settingsForm
  ctx.settingsDoc = settingsDoc
  ctx.rowNamed = rowNamed
  ctx.flipSwitch = flipSwitch
  ctx.settingsHost = settingsHost
}
