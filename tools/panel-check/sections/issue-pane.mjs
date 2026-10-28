/* 4c. The issue pane: register rows, whether the weight bar draws, and the built-in master-detail
 *
 * Tier flips, fold piles and the cleared-pool fork, all derived from the record’s own pool readings.
 * Cut as-is from the single-file fixture (8743643): the criteria, the readings, the section
 * names and their order are untouched — this is a move, not a rewrite. */

/** runIssuePane */
export async function runIssuePane(ctx) {
  const { act, settle, click, check, container, tabs, project, issueWord, t, settingsDoc, flipSwitch, saidNotEnabled, writeCalls, writesBefore, recordBefore, recordDigest, flat } = ctx

  /* ---- 4c. The issue pane: register rows, whether the weight bar draws, and the built-in master-detail ---- */

  await act(async () => { tabs[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
  const issuePane = container.querySelector('#pane-issue')
  const openGroup = project.pool.groups.find((group) => group.key === 'open')
  const openIds = (openGroup?.entries ?? []).map((entry) => entry.id)
  /* The record's own pool count decides which shape this section measures: a cleared pool collapses
   * the whole register (pool.tsx's `pool.rows.length === 0` early exit), so the tier expectations
   * branch on it instead of assuming rows are there — the poor section above runs the same fork. */
  const poolCleared = project.pool.rows.length === 0
  /** The pane's zero-row shape, pinned explicitly: no register, no tier switch, only the sentence. */
  const collapsedToOneSentence = () => poolCleared
    && [...(issuePane?.querySelectorAll('.pf-segbtn') ?? [])].length === 0
    && [...(issuePane?.querySelectorAll('button.pf-row[data-issue]') ?? [])].length === 0
    && flat(issuePane?.querySelector('.pf-innone')) === saidNotEnabled
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
    '问题那一格：「完整」那一档落在面板自己的偏好里，不碰记录；池子清空时那一档连同登记簿一起不上屏',
    poolCleared
      ? collapsedToOneSentence()
      : fullKey !== undefined && fullKey.getAttribute('aria-pressed') === 'true'
        && settingsDoc().showOtherStates === true,
    `池子读数=${poolCleared ? '（已清空）' : `${String(project.pool.rows.length)} 条`} ｜ aria-pressed=${String(fullKey?.getAttribute('aria-pressed'))} 设置文档里=${String(settingsDoc().showOtherStates)} ｜ 那一格=${issuePane?.querySelector('.pf-innone') !== null ? JSON.stringify(flat(issuePane.querySelector('.pf-innone'))) : '登记簿照画'}`,
  )
  /* The reverse direction: the previous section measured "panel → document"; this one flips the
     settings row to measure "document → panel" — flipping off returns the row to "lean" at once and
     withdraws the non-open rows from the register. */
  const issueRowIds = () => [...(issuePane?.querySelectorAll('button.pf-row[data-issue]') ?? [])]
    .map((row) => row.getAttribute('data-issue'))
  const segPressed = (label) => [...(issuePane?.querySelectorAll('.pf-segbtn') ?? [])]
    .find((button) => button.textContent === label)?.getAttribute('aria-pressed')
  await flipSwitch('问题池里显示未解决之外的')
  check(
    '翻设置里「问题池里显示未解决之外的」到关：面板当场回到「精简」，未解决之外的行退出去；池子清空时登记簿本就不在屏上',
    poolCleared
      ? collapsedToOneSentence() && typeof settingsDoc().showOtherStates === 'boolean'
      : segPressed('精简') === 'true' && segPressed('完整') === 'false'
        && settingsDoc().showOtherStates === false
        && JSON.stringify(issueRowIds()) === JSON.stringify(openIds),
    `面板上那一档=精简(${String(segPressed('精简'))}) 完整(${String(segPressed('完整'))}) ｜ 文档里 showOtherStates=${String(settingsDoc().showOtherStates)} ｜ 行=${JSON.stringify(issueRowIds())} ｜ 池子读数=${poolCleared ? '（已清空）' : `${String(project.pool.rows.length)} 条`}`,
  )
  /* Flip back on: the non-open groups fold into piles per the register's existing design (the design
     rule "folding never shifts layout"). Whether a pile is open follows pool.tsx's foldOf: first
     check for a manual click (the folds table, component state — tier flips do not reset it), then
     whether the selection fell in that pile, which auto-expands; the selection's source follows the
     fallback clause: the first open row, or when cleared, the first of the three laid-down piles in
     acknowledged → resolved → rejected order. This fixture is live data and the open set will
     eventually empty, so expectations must not assume "the full tier defaults to all folded" —
     open/closed, row sets and counts are all computed from project.pool. */
  const stackedGroups = project.pool.groups.filter((group) => group.key !== 'open')
  const foldButtons = () => [...(issuePane?.querySelectorAll('.pf-register .pf-fold') ?? [])]
  const foldReadings = () => foldButtons().map((button) => [
    button.getAttribute('aria-expanded'),
    (button.textContent ?? '').replace(/\s+/gu, ' ').trim(),
  ])
  const headLabels = () => [...(issuePane?.querySelectorAll('.pf-register .pf-head-label') ?? [])]
    .map((node) => node.textContent ?? '')
  await flipSwitch('问题池里显示未解决之外的')
  /* Which pile the selection falls in right now (pool.tsx's fallback: the first open row; only when cleared do the three laid-down piles get their turn). */
  const pickedGroupKey = (openGroup?.entries.length ?? 0) > 0
    ? 'open'
    : settingsDoc().showOtherStates !== true
      ? null
      : ['acknowledged', 'resolved', 'rejected']
        .map((key) => stackedGroups.find((group) => group.key === key))
        .find((group) => (group?.entries.length ?? 0) > 0)?.key ?? null
  /** Should a pile be open right now: folds is the fixture's record of manual clicks on the component's behalf (one click flips it; tier flips leave it alone). */
  const foldIsOpen = (folds, group) => folds[group.key] ?? (pickedGroupKey !== null && pickedGroupKey === group.key)
  const expectedFoldReadings = (folds) => stackedGroups.map((group) => (foldIsOpen(folds, group)
    ? ['true', '收起']
    : ['false', `展开其余 ${String(group.entries.length)} 条`]))
  const expectedRowIds = (folds) => project.pool.groups.flatMap((group) => (
    group.key === 'open' || foldIsOpen(folds, group) ? group.entries.map((entry) => entry.id) : []
  ))
  check(
    '翻回开：折堆头回到登记簿（组名在、每堆一枚展开钮标着条数），选中落入的那堆自动展开、其余折着；池子清空时登记簿照旧不上屏，文档里那一档照样翻上去',
    poolCleared
      ? collapsedToOneSentence() && typeof settingsDoc().showOtherStates === 'boolean'
        && stackedGroups.length === 0
      : segPressed('完整') === 'true' && settingsDoc().showOtherStates === true
        && stackedGroups.length > 0
        && JSON.stringify(issueRowIds()) === JSON.stringify(expectedRowIds({}))
        && JSON.stringify(headLabels()) === JSON.stringify(project.pool.groups.map((group) => issueWord(t, group.key)))
        && JSON.stringify(foldReadings()) === JSON.stringify(expectedFoldReadings({})),
    `面板上那一档=完整(${String(segPressed('完整'))}) ｜ 文档里 showOtherStates=${String(settingsDoc().showOtherStates)} ｜ 选中落在=${String(pickedGroupKey ?? '（无处）')} ｜ 行数=${String(issueRowIds().length)}（契约现算 ${String(expectedRowIds({}).length)} 条） ｜ 展开钮=${JSON.stringify(foldReadings())}（记录里非 open 的堆：${stackedGroups.map((group) => `${issueWord(t, group.key)} ${String(group.entries.length)} 条`).join('、') || '（没有）'}） ｜ 池子读数=${poolCleared ? '（已清空）' : `${String(project.pool.rows.length)} 条`}`,
  )
  /* Click one pile's fold button: that pile flips to the opposite of its previous state, with the row
     set and each pile's openness following the contract. When open rows exist that pile starts
     folded, so this click "opens" it; when the open set is clear and the selection fell into a
     laid-down pile, this click "closes" it — both shapes go through the same derivation, neither is
     skipped. Flipping off then withdraws the piles entirely — the expanded one included. */
  if (foldButtons()[0] !== undefined) {
    const clickedGroup = stackedGroups[0]
    const foldsAfterClick = { [clickedGroup.key]: !foldIsOpen({}, clickedGroup) }
    await click(foldButtons()[0])
    check(
      '点其中一堆的折堆钮：这一堆翻到相反的一面（该组行集合跟着开合现出或收起，身份从记录那一堆来），别的堆不受牵连',
      JSON.stringify(issueRowIds()) === JSON.stringify(expectedRowIds(foldsAfterClick))
        && JSON.stringify(foldReadings()) === JSON.stringify(expectedFoldReadings(foldsAfterClick)),
      `行数=${String(issueRowIds().length)}（未解决 ${String(openIds.length)} ＋ ${issueWord(t, clickedGroup.key)} ${String(clickedGroup.entries.length)}${foldIsOpen(foldsAfterClick, clickedGroup) ? '，这一堆现出' : '，这一堆收起'}） ｜ 展开钮=${JSON.stringify(foldReadings())}`,
    )
    await flipSwitch('问题池里显示未解决之外的')
    check(
      '翻到关：堆整个退出去——展开钮一枚不剩（展开中的那堆也在内），那一档停在「精简」',
      segPressed('精简') === 'true' && segPressed('完整') === 'false'
        && settingsDoc().showOtherStates === false
        && foldButtons().length === 0
        && JSON.stringify(issueRowIds()) === JSON.stringify(openIds),
      `面板上那一档=精简(${String(segPressed('精简'))}) ｜ 展开钮剩 ${String(foldButtons().length)} 枚 ｜ 行数=${String(issueRowIds().length)}（未解决 ${String(openIds.length)} 条）`,
    )
    /* Restore at the end: flip back to "full" and flip the clicked pile back — the panel returns to
       how it looked entering this section. Fold state survives tier flips (folds is component state,
       tier flips do not reset it) and that is exactly what the restore depends on, so it is pinned
       here: openness and row sets after the restore are recomputed from the same folds table — in
       this fixture that means every pile at aria-expanded=false, all folded; in the emptied-open-set
       shape, the selected pile returns to open per the contract. */
    await flipSwitch('问题池里显示未解决之外的')
    if (foldButtons()[0] !== undefined) await click(foldButtons()[0])
    const foldsAfterRestore = { ...foldsAfterClick, [clickedGroup.key]: !foldIsOpen(foldsAfterClick, clickedGroup) }
    check(
      '收尾还原：翻回「完整」再把点过的那堆翻回去，面板回到进这一节时的样子（折叠跨翻档保留，开合与行集合照契约现算）',
      segPressed('完整') === 'true' && settingsDoc().showOtherStates === true
        && JSON.stringify(issueRowIds()) === JSON.stringify(expectedRowIds(foldsAfterRestore))
        && JSON.stringify(foldReadings()) === JSON.stringify(expectedFoldReadings(foldsAfterRestore)),
      `面板上那一档=完整(${String(segPressed('完整'))}) ｜ 行数=${String(issueRowIds().length)}（契约现算 ${String(expectedRowIds(foldsAfterRestore).length)} 条） ｜ 展开钮=${JSON.stringify(foldReadings())}（契约现算 ${JSON.stringify(expectedFoldReadings(foldsAfterRestore))}）`,
    )
  }
  check(
    '两个看法都不落笔：点过一遍，写面一次都没被叫过，记录一个字节没动',
    writeCalls.length === writesBefore && recordDigest() === recordBefore,
    `写面调用 ${String(writeCalls.length - writesBefore)} 次 ｜ 记录 ${recordDigest() === recordBefore ? '一个字节没动' : '变了'}`,
  )

  ctx.poolCleared = poolCleared
}
