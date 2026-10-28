/* Draw it, open each view in turn: tracked port, the five tabs, the map readings, the session notes
 *
 * Also creates the write-call/root-ask trackers the later sections assert against.
 * Cut as-is from the single-file fixture (8743643): the criteria, the readings, the section
 * names and their order are untouched — this is a move, not a rewrite. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** runViews */
export async function runViews(ctx) {
  const { window, React, act, createRoot, panel, track, check, lines, settle, root, record, gateway, readProject, readSessions, sessionId, t } = ctx

  /* ---- 4. Draw it, open each view in turn ---------------------------------- */

  const container = window.document.getElementById('app')
  const reactRoot = createRoot(container)

  /* How many times the write face was called: clicking through the views must leave this count frozen. */
  const writeCalls = []
  /** Which roots the panel asked the host for: what the top workspace picker selects is visible here. */
  const askedRoots = []
  const trackedPort = {
    ...panel.port,
    read(id, workspaceRoot, signal) {
      askedRoots.push(workspaceRoot)
      return track(panel.port.read(id, workspaceRoot, signal))
    },
    readSessions(id, workspaceRoot) {
      return track(panel.port.readSessions(id, workspaceRoot))
    },
    write(verb, id, workspaceRoot, target) {
      writeCalls.push(`write/${verb}`)
      return track(panel.port.write(verb, id, workspaceRoot, target))
    },
    say(id, workspaceRoot, text, scope, cycle, node) {
      writeCalls.push(`say/${scope}`)
      return track(panel.port.say(id, workspaceRoot, text, scope, cycle, node))
    },
    setPolicy(id, workspaceRoot, cycle, key, value) {
      writeCalls.push(`setPolicy/${key}`)
      return track(panel.port.setPolicy(id, workspaceRoot, cycle, key, value))
    },
    readConfig(id, workspaceRoot) {
      return track(panel.port.readConfig(id, workspaceRoot))
    },
    setConfig(id, workspaceRoot, key, value) {
      writeCalls.push(`setConfig/${key}`)
      return track(panel.port.setConfig(id, workspaceRoot, key, value))
    },
  }
  await act(async () => {
    reactRoot.render(React.createElement(panel.Panel, { port: trackedPort, sessionId, prefs: panel.prefs }))
  })
  await settle()

  const text = () => container.textContent ?? ''
  const tabs = [...container.querySelectorAll('.pf-tab')]
  check('五个标签都在', tabs.length === 5, tabs.map((tab) => tab.textContent).join('/'))

  const views = ['地图', '明细', '指令', '问题', '设置']
  for (const [index, label] of views.entries()) {
    await act(async () => { tabs[index].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    const pane = container.querySelector(`#pane-${['map', 'detail', 'notes', 'issue', 'config'][index]}`)
    check(`看法「${label}」渲染出内容`, pane !== null && pane.hidden === false, pane === null ? '没有这一格' : `pane-${pane.id}`)
  }

  /* Fill follows the view: the map and the detail pane both take the whole footprint. */
  await act(async () => { tabs[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  const frameMap = container.querySelector('#frame')
  check('地图那一格撑满', frameMap.classList.contains('is-fill') === true, `class=${frameMap.className}`)
  await act(async () => { tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  check('明细那一格撑满', container.querySelector('#frame').classList.contains('is-fill') === true, 'is-fill')

  /* The map's readings must match the record: the four pill counts, one card per node, one wire per
   * edge, and one rail row per line plus the whole workspace. "The pane has text"-style asserts would
   * not do — the rail alone would satisfy them, regardless of the record. */
  await act(async () => { tabs[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  const reading = await gateway.read(sessionId, '', {})
  const project = readProject({ nodes: reading.nodes, cycles: reading.cycles, instructions: reading.instructions, issues: reading.issues, at: new Date() })
  lines.push(`      记录里的读数：${JSON.stringify(reading.sources)}`)
  const expectedPills = [
    ...(project.columns.shelved.length > 0 ? [['等待处理', project.columns.shelved.length]] : []),
    ['已交付', project.columns.completed.length],
    ['进行中', project.columns.running.length],
    ['未开始', project.columns.todo.length],
  ]
  const pillReadings = [...container.querySelectorAll('#census .pf-pill')].map((pill) => [
    pill.getAttribute('title'),
    Number.parseInt((pill.querySelector('.pf-num')?.textContent ?? '').replace(/[^\d]/gu, ''), 10),
  ])
  /* The page draws at most MAP_CAP cards; this record is far below it, so the drawn set is the record. */
  const MAP_CAP = 1000
  const mapPane = () => container.querySelector('#pane-map')
  const cardIds = [...(mapPane()?.querySelectorAll('.pf-mnode') ?? [])].map((card) => card.getAttribute('data-id'))
  const wireCount = mapPane()?.querySelectorAll('.pf-mwire').length ?? 0
  const railRows = [...(mapPane()?.querySelectorAll('.pf-rail-item') ?? [])]
  const expectedRail = [t('common.global'), ...project.cycles.map((cycle) => cycle.id)]
  check(
    '地图上的数从记录里来：胶囊、每格一张卡、每条边一根线、左栏一行一拍，逐项对上',
    JSON.stringify(pillReadings) === JSON.stringify(expectedPills)
      && JSON.stringify([...cardIds].sort()) === JSON.stringify(project.nodes.slice(0, MAP_CAP).map((node) => node.id).sort())
      && wireCount === project.graph.edges.length
      && JSON.stringify(railRows.map((row) => row.textContent)) === JSON.stringify(expectedRail)
      && railRows[0]?.getAttribute('aria-pressed') === 'true',
    `记录现算 胶囊=${JSON.stringify(expectedPills)} 卡=${String(Math.min(MAP_CAP, project.nodes.length))} 线=${String(project.graph.edges.length)} 栏=${JSON.stringify(expectedRail)} ｜ 面板上 胶囊=${JSON.stringify(pillReadings)} 卡=${String(cardIds.length)} 线=${String(wireCount)} 栏=${JSON.stringify(railRows.map((row) => row.textContent))}`,
  )

  /* A card's two lines, read off the drawn ones: the title leads, and under it the state mark leads the
   * foot row — so the mark stands at one place on every card. The line's id follows it, and a card that
   * belongs to no line renders none at all: an empty span would still take up the row's gap and leave
   * two cards' marks out of line, which is the whole point of the order. */
  const cardShapes = [...(mapPane()?.querySelectorAll('.pf-mnode') ?? [])].map((card) => {
    const id = card.getAttribute('data-id') ?? ''
    const reading = project.nodeById[id]
    const meta = card.querySelector('.pf-mmeta')
    return {
      title: card.firstElementChild?.classList.contains('pf-mtitle') === true,
      mark: meta?.firstElementChild?.classList.contains('pf-cell') === true,
      tag: card.querySelector('.pf-mtag') === null ? '' : (card.querySelector('.pf-mtag')?.textContent ?? ''),
      line: reading?.cycleIds[0] ?? '',
    }
  })
  check(
    '地图上每张卡：标题起头，状态点领着底栏，没有拍的那一格不占位',
    cardShapes.length > 0
      && cardShapes.every((shape) => shape.title && shape.mark && shape.tag === shape.line),
    `卡=${String(cardShapes.length)} 标题不在首位=${String(cardShapes.filter((shape) => !shape.title).length)} 状态点不在首=${String(cardShapes.filter((shape) => !shape.mark).length)} 拍名不齐=${String(cardShapes.filter((shape) => shape.tag !== shape.line).length)}`,
  )

  /* Session notes: the host half hauls that directory back as-is, and the model layer reads "which
   * session each pane points to" against it. The fixture recomputes the mapping from the copied
   * record itself to audit the haul → read chain — keys are file names minus the extension; when a
   * pane has several, the latest timestamp wins, and a same-timestamp run beats a discussion. */
  const sessionsDir = join(record, 'meta', 'sessions')
  const wantSessions = {}
  for (const name of existsSync(sessionsDir) ? readdirSync(sessionsDir) : []) {
    if (!name.endsWith('.json')) continue
    let note
    try {
      note = JSON.parse(readFileSync(join(sessionsDir, name), 'utf8'))
    } catch {
      continue
    }
    let best
    for (const [rank, kind] of [[1, 'run'], [0, 'discussion']]) {
      for (const ref of Array.isArray(note?.[kind]) ? note[kind] : []) {
        if (typeof ref?.session !== 'string' || ref.session.length === 0) continue
        const at = typeof ref.at === 'string' ? ref.at : ''
        if (best === undefined || at > best.at || (at === best.at && rank > best.rank)) best = { session: ref.session, at, rank }
      }
    }
    if (best !== undefined) wantSessions[name.slice(0, -'.json'.length)] = best.session
  }
  const hauled = await gateway.readSessions(sessionId, '')
  const gotSessions = readSessions(hauled.notes)
  check(
    '会话笔记：宿主搬回的原样经模型层读出，每一格该去的那条与夹具现算的对上',
    JSON.stringify(gotSessions) === JSON.stringify(wantSessions),
    `夹具现算 ${String(Object.keys(wantSessions).length)} 格 ｜ 链上读出 ${String(Object.keys(gotSessions).length)} 格`,
  )

  ctx.container = container
  ctx.reactRoot = reactRoot
  ctx.writeCalls = writeCalls
  ctx.askedRoots = askedRoots
  ctx.trackedPort = trackedPort
  ctx.tabs = tabs
  ctx.project = project
  ctx.mapPane = mapPane
}
