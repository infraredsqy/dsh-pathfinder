/* 4d. The settings pane: this workspace’s own project settings, read here and edited here
 *
 * Expected rows come from the real tool’s own listing plus the shipped layout table; invalid values must bounce. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** runConfigPane */
export async function runConfigPane(ctx) {
  const { window, act, settle, setSelect, typeNumber, check, lines, container, tabs, panel, trackedPort, React, createRoot, runPf, hostCtx, workspace, record, root, sessionId, outcomeText } = ctx

  /* ---- 4d. The settings pane: this workspace's own project settings, read here and edited here ----
   * One row per key the tool prints, grouped under a category index down the left edge: a row is the
   * key's name over its one sentence, its control, and a layer tag at the end. Readings on both sides:
   * what the panel shows, and the lines the real tool prints against the same workspace; the expected
   * rows, their categories, and their order are derived from that reading and the shipped table, never
   * written out by hand here. Each edit writes back to this project's layer and is read again — the
   * reading lands on the record file (`workspace/.pf/config.json`); what the panel reads back on its
   * own does not count.
   *
   * Two invalid-value cases: an out-of-range number (typed into the number box for real) and a tier
   * not in the option list (a forged option injected into the dropdown, then picked). Both must land
   * on "record keeps its original value, UI returns to it".
   */

  const { parseConfigList } = await import(pathToFileURL(join(root, 'src', 'host', 'project-config.ts')).href)
  const { configSectionsOf } = await import(pathToFileURL(join(root, 'src', 'client', 'config-rows.ts')).href)
  const listed = await runPf(hostCtx, workspace, ['config', 'list'], new AbortController().signal)
  /* A run's outcome carries the tool's output on success and a code-plus-detail refusal otherwise: only
   * the success branch has a text stream to parse. */
  const truth = parseConfigList(listed.ok ? listed.text : '')
  /** The record's three layer names as the panel's three words. */
  const LAYER_WORD = { default: '默认', project: '本项目', global: '全局' }
  check(
    '设置那一格：真工具对着这份工作区印得出设置行',
    listed.ok && Object.keys(truth).length > 0,
    listed.ok
      ? listed.text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join(' ｜ ')
      : outcomeText(listed),
  )

  const storedConfig = () => JSON.parse(readFileSync(join(record, 'config.json'), 'utf8'))

  /* What the page should hold, derived from the tool's own reading and the shipped layout table: the
   * fixture never states "these seven keys" by hand — the tool says which keys exist, and the table
   * says which category each one stands in and in what order. */
  const expectedSections = configSectionsOf(truth)
  const expectedRows = expectedSections.flatMap((section) => section.rows)
  const expectedKeys = expectedRows.map((row) => row.key)
  const GROUP_WORD = { general: '常规', issue: '问题', test: '测试' }
  const LAYER_OF = (key) => (truth[key] === undefined || truth[key].layer === null ? '（没有层签）' : LAYER_WORD[truth[key].layer])
  /* What a row should show for a value the record holds: the tool marks a limit nobody filled in with a
   * dash, and a number box shows nothing there — the box says "unset" instead of carrying the mark. */
  const shownValueOf = (row, config) => {
    const value = String(config[row.key] ?? '（记录里没有这个键）')
    return row.kind === 'num' && value === '-' ? '' : value
  }

  const configReadings = (scope) => [...(scope?.querySelectorAll('#pane-config .pf-cfgrow') ?? [])].map((row) => {
    const pick = row.querySelector('select')
    const box = row.querySelector('input')
    const pressed = [...row.querySelectorAll('.pf-segbtn')].find((button) => button.getAttribute('aria-pressed') === 'true')
    return {
      key: row.getAttribute('data-key'),
      name: row.querySelector('.pf-setlabel')?.textContent ?? '',
      value: pick !== null ? pick.value : box !== null ? box.value : pressed?.textContent === '开' ? 'on' : pressed === undefined ? '（未设置）' : 'off',
      layer: row.querySelector('.pf-vlayer')?.textContent ?? '（没有层签）',
      section: row.closest('.pf-cfgsec')?.getAttribute('data-cat') ?? '（没有段）',
    }
  })
  const configNav = (scope) => [...(scope?.querySelectorAll('#pane-config .pf-cfgitem') ?? [])].map((item) => ({
    group: item.getAttribute('data-cat'),
    name: item.querySelector('.pf-cfgitem-name')?.textContent ?? '',
    count: item.querySelector('.pf-cfgitem-count')?.textContent ?? '',
    current: item.getAttribute('aria-current'),
  }))

  await act(async () => { tabs[4].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
  const configPane = container.querySelector('#pane-config')
  const shownFirst = configReadings(container)
  const truthValues = Object.fromEntries(Object.entries(truth).map(([key, entry]) => [key, entry.value]))
  const wantedFirst = expectedRows.map((row) => ({
    key: row.key,
    value: shownValueOf(row, truthValues),
    layer: LAYER_OF(row.key),
    section: expectedSections.find((section) => section.rows.some((one) => one.key === row.key))?.group ?? '（没有段）',
  }))
  check(
    '设置那一格：每个键一行，值与层签逐行与真工具印的那份对上，行落在它的分组里',
    JSON.stringify(shownFirst.map((row) => [row.key, row.value, row.layer, row.section]))
      === JSON.stringify(wantedFirst.map((row) => [row.key, row.value, row.layer, row.section])),
    `工具那边：${wantedFirst.map((row) => `${row.key}=${row.value}(${row.layer}/${row.section})`).join(' ')} ｜ 面板这边：${shownFirst.map((row) => `${row.key}=${row.value}(${row.layer}/${row.section})`).join(' ')}`,
  )
  check(
    '设置那一格：一行一个控件（下拉、数字框、开-关各照表），层签一枚不少',
    shownFirst.length === expectedKeys.length
      && configPane?.querySelectorAll('select').length === expectedRows.filter((row) => row.kind === 'pick').length
      && configPane?.querySelectorAll('input.pf-numin').length === expectedRows.filter((row) => row.kind === 'num' || row.kind === 'text').length
      && configPane?.querySelectorAll('.pf-seg').length === expectedRows.filter((row) => row.kind === 'toggle').length
      && configPane?.querySelectorAll('.pf-vlayer').length === expectedKeys.filter((key) => LAYER_OF(key) !== '（没有层签）').length,
    `行=${String(shownFirst.length)} 下拉=${String(configPane?.querySelectorAll('select').length)} 数字框=${String(configPane?.querySelectorAll('input.pf-numin').length)} 开-关=${String(configPane?.querySelectorAll('.pf-seg').length)} 层签=${String(configPane?.querySelectorAll('.pf-vlayer').length)} ｜ 名字=${shownFirst.map((row) => row.name).join('/')}`,
  )
  check(
    '设置那一格：每一行的名字都是自己的说法，键名只在悬停时给出',
    shownFirst.every((row) => row.name.length > 0 && row.name !== row.key),
    `名字=${shownFirst.map((row) => row.name).join(' / ')}`,
  )
  check(
    '设置那一格：左边的索引一栏一个分组，数目就是那一栏的行数，落笔那一栏点着',
    JSON.stringify(configNav(container))
      === JSON.stringify(expectedSections.map((section, index) => ({
        group: section.group,
        name: GROUP_WORD[section.group],
        count: String(section.rows.length),
        current: index === 0 ? 'true' : 'false',
      }))),
    `索引=${configNav(container).map((item) => `${item.group}:${item.name}(${item.count})${item.current === 'true' ? '·点着' : ''}`).join(' ')}`,
  )
  check(
    '设置那一格：索引脚下写着这些值住的那个文件',
    configPane?.querySelector('.pf-cfgnavfoot-path')?.textContent === '.pf/config.json'
      && (configPane?.querySelector('.pf-cfgnavfoot-term')?.textContent ?? '').length > 0,
    `脚下=${String(configPane?.querySelector('.pf-cfgnavfoot-term')?.textContent)} / ${String(configPane?.querySelector('.pf-cfgnavfoot-path')?.textContent)}`,
  )
  check(
    '设置那一格：那一列顶满格子，宽度跟着格子走（把手和外框都退场了）',
    configPane?.querySelectorAll('.pf-grip').length === 0
      && configPane?.querySelector('.pf-configwrap') === null
      && configPane?.style.getPropertyValue('--pf-config-w') === '',
    `把手=${String(configPane?.querySelectorAll('.pf-grip').length)} 外框=${configPane?.querySelector('.pf-configwrap') === null ? '没有' : '还在'}`,
  )

  /* Each row's control gets a driver from the shared set at the top: dropdown and number box go
   * through the shared drivers' prototype-setter path, and the on-off toggle just needs a click. */
  const rowIn = (scope, key) => [...(scope?.querySelectorAll('#pane-config .pf-cfgrow') ?? [])]
    .find((row) => row.getAttribute('data-key') === key)
  const pressToggle = async (row, word) => {
    const button = [...row.querySelectorAll('.pf-segbtn')].find((one) => one.textContent === word)
    await act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await settle()
  }
  const noteLine = () => [...container.querySelectorAll('.pf-innone')].map((node) => node.textContent ?? '').join(' | ')
  const other = (list, current) => list.find((one) => one !== current) ?? current

  const wrote = []
  /* The tool's own mark for a limit nobody filled in is a dash; the box states "unset" instead of
   * standing empty, which could be read as a zero. */
  const unsetRows = expectedRows.filter((row) => row.kind === 'num' && truthValues[row.key] === '-')
  check(
    '设置那一格：工具印「-」的那个上限，框里挂「未设置」的灰字',
    unsetRows.length > 0 && unsetRows.every((row) => {
      const box = rowIn(container, row.key)?.querySelector('input.pf-numin')
      return box !== null && box !== undefined && box.classList.contains('is-unset') && box.getAttribute('placeholder') === '未设置'
    }),
    `- 的上限=${unsetRows.map((row) => `${row.key}:${String(rowIn(container, row.key)?.querySelector('input.pf-numin')?.getAttribute('placeholder'))}`).join(' ')}`,
  )
  const worktreeRow = rowIn(container, 'worktree_mode')
  const worktreeNext = other([...worktreeRow.querySelectorAll('option')].map((option) => option.value), worktreeRow.querySelector('select').value)
  await setSelect(worktreeRow.querySelector('select'), worktreeNext)
  wrote.push(`worktree_mode → ${worktreeNext}`)
  check(
    'worktree 档改一次：记录里真的是那个值，面板上跟着换成它',
    storedConfig().worktree_mode === worktreeNext && rowIn(container, 'worktree_mode').querySelector('select').value === worktreeNext,
    `记录里=${String(storedConfig().worktree_mode)} 面板上=${rowIn(container, 'worktree_mode').querySelector('select').value}`,
  )

  const tierRow = rowIn(container, 'test_tier')
  const tierNext = other([...tierRow.querySelectorAll('option')].map((option) => option.value), tierRow.querySelector('select').value)
  await setSelect(tierRow.querySelector('select'), tierNext)
  wrote.push(`test_tier → ${tierNext}`)
  check(
    '测试档改一次：记录里真的是那个值，面板上跟着换成它',
    storedConfig().test_tier === tierNext && rowIn(container, 'test_tier').querySelector('select').value === tierNext,
    `记录里=${String(storedConfig().test_tier)} 面板上=${rowIn(container, 'test_tier').querySelector('select').value}`,
  )

  const agentRow = rowIn(container, 'max_agents')
  const agentNext = String(Number(agentRow.querySelector('input').value) + 1)
  await typeNumber(agentRow, agentNext)
  wrote.push(`max_agents → ${agentNext}`)
  check(
    '并行上限改一次：记录里真的是那个数，框里跟着换成它',
    storedConfig().max_agents === Number(agentNext) && rowIn(container, 'max_agents').querySelector('input').value === agentNext,
    `记录里=${String(storedConfig().max_agents)} 框里=${rowIn(container, 'max_agents').querySelector('input').value}`,
  )

  const switchedRow = expectedRows.find((row) => row.group === 'issue' && row.kind === 'toggle')
  const issueRow = rowIn(container, switchedRow?.key ?? 'issue_pool')
  await pressToggle(issueRow, '关')
  wrote.push(`${switchedRow?.key ?? 'issue_pool'} → off`)
  check(
    '问题池那个开关改一次：记录里真的是那个值，面板上跟着换成它',
    storedConfig()[switchedRow?.key ?? 'issue_pool'] === 'off'
      && rowIn(container, switchedRow?.key ?? 'issue_pool').querySelector('.pf-segbtn[aria-pressed="true"]')?.textContent === '关',
    `记录里=${String(storedConfig()[switchedRow?.key ?? 'issue_pool'])} 面板上按下的是=${String(rowIn(container, switchedRow?.key ?? 'issue_pool').querySelector('.pf-segbtn[aria-pressed="true"]')?.textContent)}`,
  )
  lines.push(`      设置那一格改了 ${String(wrote.length)} 行：${wrote.join(' ｜ ')}`)

  /* After writing those rows: their values live in this project's layer and their tags say so; the
   * keys nothing was written to still read the layer the tool printed for them. */
  const written = new Set(['worktree_mode', 'test_tier', 'max_agents', switchedRow?.key ?? 'issue_pool'])
  const shownAfter = configReadings(container)
  const configNow = storedConfig()
  /* What a row should show once the writes landed: the written keys read the record's own file; every
   * other key keeps the value the tool printed before, the writes never touched it. */
  const expectedAfterWrite = (row) => (written.has(row.key)
    ? shownValueOf(row, configNow)
    : shownValueOf(row, truthValues))
  check(
    '写完这几行：动过的那几枚层签读作「本项目」（写的永远是这一层），其余照工具印的层，值与记录里一致',
    shownAfter.length === expectedKeys.length
      && shownAfter.every((row) => row.layer === (written.has(row.key) ? '本项目' : LAYER_OF(row.key)))
      && shownAfter.every((row) => row.value === expectedAfterWrite(expectedRows.find((one) => one.key === row.key))),
    `层签=${shownAfter.map((row) => `${row.key}=${row.layer}`).join(' ')} ｜ 面板上=${JSON.stringify(shownAfter.map((row) => row.value))} ｜ 记录里=${JSON.stringify(configNow)}`,
  )

  /* Invalid value 1: out-of-range number. The record keeps its value, the box returns to it, and the tool's message lands on the panel's note line. */
  /* The words on that line are the TOOL's own, not the panel's: the expectation is read out of the tool
   * itself (the same command, run for real) rather than pinned to one language's wording. */
  const refusalWords = async (key, value) => {
    const outcome = await runPf(hostCtx, workspace, ['config', 'set', key, value], new AbortController().signal)
    return (outcome.ok ? outcome.text : (outcome.detail ?? '')).trim()
  }
  const numberRefusal = await refusalWords('max_agents', '0')
  const beforeIllegal = storedConfig()
  await typeNumber(rowIn(container, 'max_agents'), '0')
  check(
    '越界数字不落记录：记录保持原值，框里回到原值，提示行摆的是工具那句话',
    numberRefusal.length > 0
      && storedConfig().max_agents === beforeIllegal.max_agents
      && rowIn(container, 'max_agents').querySelector('input').value === String(beforeIllegal.max_agents)
      && noteLine().includes(numberRefusal),
    `记的是 0 ｜ 记录里=${String(storedConfig().max_agents)} 框里=${rowIn(container, 'max_agents').querySelector('input').value} 提示行=${noteLine() === '' ? '（空）' : noteLine()} ｜ 工具那句=${numberRefusal}`,
  )

  /* Invalid value 2: a tier not in the option list. A forged option is injected into the dropdown and picked — impossible to do on the real panel. */
  const tierRefusal = await refusalWords('test_tier', 'partial')
  const forgedRow = rowIn(container, 'test_tier')
  const forgedSelect = forgedRow.querySelector('select')
  const forged = window.document.createElement('option')
  forged.value = 'partial'
  forged.textContent = 'partial'
  forgedSelect.appendChild(forged)
  await setSelect(forgedSelect, 'partial')
  forged.remove()
  check(
    '非法档位不落记录：记录保持原值，下拉回到原值，提示行摆的是工具那句话',
    tierRefusal.length > 0
      && storedConfig().test_tier === beforeIllegal.test_tier
      && rowIn(container, 'test_tier').querySelector('select').value === beforeIllegal.test_tier
      && noteLine().includes(tierRefusal),
    `记的是 partial ｜ 记录里=${String(storedConfig().test_tier)} 下拉里=${rowIn(container, 'test_tier').querySelector('select').value} 提示行=${noteLine() === '' ? '（空）' : noteLine()} ｜ 工具那句=${tierRefusal}`,
  )

  /* Reopen a panel (same record, same session): every row still matches the value the record holds. */
  const reopenHost = window.document.createElement('div')
  window.document.body.appendChild(reopenHost)
  const reopenRoot = createRoot(reopenHost)
  await act(async () => {
    reopenRoot.render(React.createElement(panel.Panel, { port: trackedPort, sessionId, prefs: panel.prefs }))
  })
  await settle()
  await act(async () => { reopenHost.querySelector('#tab-config')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
  const reopened = configReadings(reopenHost)
  const storedAfter = storedConfig()
  check(
    '重开一份面板：设置那一格的每一行与记录里的值还对得上',
    reopened.length === expectedKeys.length
      && reopened.every((row) => row.value === expectedAfterWrite(expectedRows.find((one) => one.key === row.key)))
      && reopened.every((row) => row.layer === (written.has(row.key) ? '本项目' : LAYER_OF(row.key))),
    `重开后面板上=${JSON.stringify(reopened.map((row) => `${row.key}=${row.value}`))} ｜ 记录里=${JSON.stringify(storedAfter)}`,
  )
  await act(async () => { reopenRoot.unmount() })
  lines.push(`      设置那一格收尾时记录里那几个键：${JSON.stringify(storedAfter)}`)

}
