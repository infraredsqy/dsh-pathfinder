/* 4b. The map pane: one card per node, one wire per edge, a rail that changes the emphasis, a camera that really moves
 *
 * Expected placement and camera come from the same engine the panel calls. */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** runMapPane */
export async function runMapPane(ctx) {
  const { window, act, settle, click, check, container, tabs, project, mapPane, recordDigest, writeCalls, askedRoots, root } = ctx

  /* ---- 4b. The map pane: one card per node, one wire per edge, a rail that changes the emphasis, and
   * a camera that really moves ----
   * The drawing is read here the way a reader reads it: which cards are in ink, which rail row is
   * pressed, and where the camera stands afterwards. The expected placement and camera come from the
   * same engine the panel calls, so this section measures the panel against the record rather than
   * against a copy of the arithmetic. */

  const { emphasisOf, fitView, focusView, place, rankedOf } = await import(pathToFileURL(join(root, 'src', 'client', 'map-layout.ts')).href)

  /** Before this section starts: how often the write face was called, and what the record looked like. */
  const writesBefore = writeCalls.length
  const recordBefore = recordDigest()

  await act(async () => { tabs[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()

  const drawnCards = () => [...(mapPane()?.querySelectorAll('.pf-mnode') ?? [])]
  const litIds = () => drawnCards().filter((card) => card.classList.contains('is-lit')).map((card) => card.getAttribute('data-id'))
  const aheadIds = () => drawnCards().filter((card) => card.classList.contains('is-ahead')).map((card) => card.getAttribute('data-id'))
  const cardOf = (id) => drawnCards().find((card) => card.getAttribute('data-id') === id)
  const canvasOf = () => mapPane()?.querySelector('.pf-canvas')
  const scaleOf = () => Number(/scale\(([\d.]+)\)/u.exec(canvasOf()?.style.transform ?? '')?.[1] ?? Number.NaN)
  const transformOf = () => {
    const held = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/u.exec(canvasOf()?.style.transform ?? '')
    return held === null ? null : { tx: Number(held[1]), ty: Number(held[2]), s: Number(held[3]) }
  }
  const placement = place({ nodes: project.nodes, edges: project.graph.edges })
  const nameOf = (node) => (node.title ?? (node.id.length > 8 ? node.id.slice(0, 8) : node.id))

  check(
    '地图那一格：一格一张卡、一条边一根线，卡上的名字就是记录里那个标题',
    drawnCards().length === project.nodes.length
      && (mapPane()?.querySelectorAll('.pf-mwire').length ?? 0) === project.graph.edges.length
      && drawnCards().every((card) => {
        const node = project.nodeById[card.getAttribute('data-id') ?? '']
        return node !== undefined && card.querySelector('.pf-mtitle')?.textContent === nameOf(node)
      }),
    `记录里 ${String(project.nodes.length)} 格 / ${String(project.graph.edges.length)} 条边 ｜ 面板上 ${String(drawnCards().length)} 张卡 / ${String(mapPane()?.querySelectorAll('.pf-mwire').length ?? 0)} 根线，头三个 ${drawnCards().slice(0, 3).map((card) => card.querySelector('.pf-mtitle')?.textContent ?? '').join(' / ')}`,
  )

  /* Press one card: the emphasis follows the press — that card, what it owes, what owes it, plus the
   * whole workspace's gates while the rail stands on the whole workspace. */
  const hub = project.graph.edges[0]?.from
  const hubCard = hub === undefined ? undefined : cardOf(hub)
  if (hubCard !== undefined) await click(hubCard)
  const wantLit = hub === undefined ? [] : [...emphasisOf(placement, hub, null).lit].sort()
  check(
    '地图那一格：点一格，点亮它自己、它欠的、欠它的，加上全工作区的人闸',
    hubCard !== undefined && JSON.stringify(litIds().sort()) === JSON.stringify(wantLit),
    `记录现算 ${String(wantLit.length)} 格（${wantLit.map((id) => id.slice(0, 8)).join(',')}）｜ 面板上 ${String(litIds().length)} 格（${litIds().map((id) => (id ?? '').slice(0, 8)).join(',')}）`,
  )

  /* A rail row is a hit scope, not a filter: the whole drawing stays, and the row's own line gets the
   * ink. Every other line's cards and the cycle-less cards fall back to structure. */
  const scopeLine = project.cycles.find((cycle) => project.nodes.some((node) => node.cycleIds.includes(cycle.id)))
  const lineRow = [...(mapPane()?.querySelectorAll('.pf-rail-item') ?? [])].find((row) => row.textContent === scopeLine?.id)
  const lineNodes = scopeLine === undefined ? [] : project.nodes.filter((node) => node.cycleIds.includes(scopeLine.id)).map((node) => node.id)
  if (lineRow !== undefined) await click(lineRow)
  check(
    '地图那一格：左栏选一条线，那条线碰过的格子全点亮，整张图仍在一格不少',
    scopeLine !== undefined && lineRow?.getAttribute('aria-pressed') === 'true'
      && lineNodes.every((id) => litIds().includes(id))
      && (lineNodes.length === project.nodes.length || litIds().length < project.nodes.length)
      && drawnCards().length === project.nodes.length,
    `这条线碰过 ${String(lineNodes.length)} 格 ｜ 点亮的 ${String(litIds().length)} 格 ｜ 图上 ${String(drawnCards().length)} 格（记录里 ${String(project.nodes.length)} 格）`,
  )

  /* The tiers below the picked line: a card no line has touched yet is "ahead", a card on another
   * line is neither of the two — it keeps its state in its mark and its words, not in its frame. */
  const noLine = project.nodes.filter((node) => node.cycleIds.length === 0).map((node) => node.id)
  const otherLine = project.nodes.filter((node) => node.cycleIds.length > 0 && !node.cycleIds.includes(scopeLine?.id)).map((node) => node.id)
  check(
    '地图那一格：选一条线，没有线的格子低一档，别的线的格子两档都不占',
    lineNodes.every((id) => litIds().includes(id))
      && noLine.every((id) => aheadIds().includes(id))
      && otherLine.every((id) => !litIds().includes(id) && !aheadIds().includes(id)),
    `选中的线碰过 ${String(lineNodes.length)} 格 ｜ 没有线的 ${String(noLine.length)} 格 ｜ 别的线的 ${String(otherLine.length)} 格 ｜ 面板上：墨 ${String(litIds().length)} / 未来 ${String(aheadIds().length)}`,
  )

  /* The overview: one press on the top-right magnifier, and the camera takes the engine's own fit. */
  const fit = fitView({ w: 1280, h: 720 }, placement)
  const fitKey = mapPane()?.querySelector('#map-fit')
  if (fitKey !== undefined) await click(fitKey)
  check(
    '地图那一格：全览那一枚按下去，整张图按全览那个倍率摆进视口',
    fitKey?.getAttribute('aria-pressed') === 'true' && Math.abs(scaleOf() - fit.s) < 1e-6,
    `引擎算的全览倍率=${String(fit.s.toFixed(4))} ｜ 面板上的=${String(scaleOf())} aria-pressed=${String(fitKey?.getAttribute('aria-pressed'))}`,
  )

  /* The wheel is the zoom: a turn really changes the scale, and the pane leaves the overview tier. */
  const beforeWheel = scaleOf()
  await act(async () => {
    mapPane()?.querySelector('.pf-field')?.dispatchEvent(new window.WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaY: -240, clientX: 400, clientY: 300,
    }))
  })
  check(
    '地图那一格：滚轮真的在缩放，不是只换一个数',
    Number.isFinite(scaleOf()) && Math.abs(scaleOf() - beforeWheel) > 1e-6,
    `滚之前=${String(beforeWheel)} 滚之后=${String(scaleOf())}`,
  )

  /* The drag pans the drawing: at the focus the reader walks the map rather than looking at a still
   * picture, and the scale the wheel set is kept through the move. */
  const beforeDrag = transformOf()
  await act(async () => {
    const field = mapPane()?.querySelector('.pf-field')
    if (field === null || field === undefined) return
    const at = (type, clientX, clientY) => field.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }))
    at('pointerdown', 400, 300)
    at('pointermove', 470, 300)
    at('pointerup', 470, 300)
  })
  await settle()
  const afterDrag = transformOf()
  check(
    '地图那一格：按住横着拖七十像素，整张图就跟着走七十像素，倍率不变',
    beforeDrag !== null && afterDrag !== null
      && Math.abs(afterDrag.tx - beforeDrag.tx - 70) < 0.5
      && afterDrag.s === beforeDrag.s
      /* The drag is level: nothing asked the page to move vertically, so it must not. */
      && afterDrag.ty === beforeDrag.ty,
    `拖之前=${JSON.stringify(beforeDrag)} 拖之后=${JSON.stringify(afterDrag)}`,
  )

  /* The rail row is also the way back: the camera stands where the drag and the wheel left it, and one
   * press on a row returns it to that row's first card — so the page needs no reset button of its own. */
  const scopeDefault = scopeLine === undefined
    ? rankedOf(project.nodes)[0]?.id ?? null
    : rankedOf(project.nodes.filter((node) => node.cycleIds.includes(scopeLine.id)))[0]?.id ?? null
  const railRow = [...(mapPane()?.querySelectorAll('.pf-rail-item') ?? [])].find((row) => row.textContent === scopeLine?.id)
  if (railRow !== undefined) await click(railRow)
  const wantBack = railRow === undefined ? null : focusView({ w: 1280, h: 720 }, placement, scopeDefault)
  const back = transformOf()
  check(
    '地图那一格：拖远缩远之后点一下左栏，镜头回到那一栏的第一格',
    railRow !== undefined && wantBack !== null && back !== null
      && Math.abs(back.s - wantBack.s) < 1e-6 && Math.abs(back.tx - wantBack.tx) < 1e-6 && Math.abs(back.ty - wantBack.ty) < 1e-6,
    `那一栏的第一格=${String(scopeDefault)} ｜ 引擎=${JSON.stringify(wantBack)} ｜ 面板上=${JSON.stringify(back)}`,
  )

  /* And the refresh: the panel hands the read out again, so what is on screen is this record now. */
  askedRoots.length = 0
  await click(mapPane()?.querySelector('#map-refresh'))
  check(
    '地图那一格：右上那枚刷新让面板照着这份记录再读一遍',
    askedRoots.length > 0,
    `问过的根=${JSON.stringify([...new Set(askedRoots)])}`,
  )

  ctx.writesBefore = writesBefore
  ctx.recordBefore = recordBefore
}
