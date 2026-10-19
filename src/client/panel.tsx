/**
 * 主面板的外壳：六格标签行、看法之间的切换、读数与偏好的取数线，以及各格的装配。
 *
 * 各格自己的版面各成一篇：看板 `board.tsx`、明细 `detail.tsx`、指令簿 `notes.tsx`、项目设置
 * `config.tsx`，依赖与问题池两格在 `field.tsx` / `pool.tsx`；两枚模态看 `line-settings.tsx`
 * 与 `delete-confirm.tsx`，看板、明细、指令簿三格共用的读法小构件看 `marks.tsx`。
 *
 * 读数一个都不在这里算：四份记录从口子上进来，由 `src/model` 那套纯函数读成那一刻的读数，这一层
 * 只把读数画出来。面板自己那几个显示偏好住在 Host 的设置文档里，经 `prefs.ts` 那条口子读写。
 */
import * as React from 'react'
import type { PathfinderReading } from '../host/contract.ts'
import type { InstructionReading, ProjectReading } from '../model/index.ts'
import { everySourceIs, readProject, readSessions } from '../model/index.ts'
import type { InfoLevel, PrefField, PrefsSource, ViewId } from './prefs.ts'
import { clampSide, DEFAULT_SOURCE, PANEL_PREF_FIELDS, VIEW_LABELS } from './prefs.ts'
import { NOT_ENABLED } from './constants.ts'
import type { PanelPort } from './data.ts'
import { bucketOf, NO_WORKSPACES, type WorkspaceSource } from './workspaces.ts'
import { Pill } from './widgets.tsx'
import { BoardPane, type CardGo } from './board.tsx'
import { ConfigPane } from './config.tsx'
import { DeleteConfirm } from './delete-confirm.tsx'
import { DetailPane } from './detail.tsx'
import { DependencyField } from './field.tsx'
import { LineSettings } from './line-settings.tsx'
import { NotesPane } from './notes.tsx'
import { IssuePool } from './pool.tsx'

interface View {
  readonly id: ViewId
  readonly label: string
  /** 自带高度下限的那几格撑满地界，其余跟着内容长。 */
  readonly fill: boolean
}

const VIEWS: readonly View[] = [
  { id: 'now', label: VIEW_LABELS.now, fill: false },
  { id: 'detail', label: VIEW_LABELS.detail, fill: true },
  { id: 'notes', label: VIEW_LABELS.notes, fill: true },
  { id: 'wires', label: VIEW_LABELS.wires, fill: true },
  { id: 'issue', label: VIEW_LABELS.issue, fill: true },
  { id: 'config', label: VIEW_LABELS.config, fill: true },
]

/** 每列几张卡的三档，以及「铺满」够不着尺子时的落脚点。 */
const INFO_CAPS: Readonly<Record<Exclude<InfoLevel, 'full'>, number>> = { lean: 1, three: 3 }
const FULL_MAX = 8
const FULL_FALLBACK = 3

/** 设置服务没到场时面板上那句话：这一下只活在这一屏上。 */
const PREFS_NOT_KEPT = '显示偏好未能保存：设置服务未连接，本次改动只在当前页面生效。'

/** 这个工作区里没有这份记录时，面板正文摆的那一句。 */
const NO_RECORD = '当前工作区没有 pathfinder 的记录。'

/** 这条会话落在某个工作区里、读者却挑了「未分组」：那一格不是哪个根，名下没有记录可读。 */
const UNGROUPED_EMPTY = '未分组名下没有记录；这条会话属于清单里的某个工作区。'

/** 记录在、四份来源一份都解不出来时摆的另一句：与没记录是两件事。 */
const UNREADABLE_RECORD = '无法读取当前工作区的记录。'

export interface PanelProps {
  readonly port: PanelPort
  /** 读哪条会话所在的工作区；没有就画不出东西来。 */
  readonly sessionId?: string | undefined
  /** 面板自己的偏好住哪份设置文档。不给就按出厂那几条画。 */
  readonly prefs?: PrefsSource | undefined
  /** 卡上那一下的去处：DSH 那条导航口子。不给就点不动。 */
  readonly openSession?: ((target: string) => void) | undefined
  /** 这台机器上此刻有哪些会话：卡上那条记录指向的会话在不在里面，由它说了算。 */
  readonly knownSessions?: ReadonlySet<string> | undefined
  /** DSH 那份工作区清单，面板顶上那枚选择器从它来；不给就一个工作区都挑不了，只读这条会话
   * 自己那个工作区。 */
  readonly workspaces?: WorkspaceSource | undefined
}

/** 还没有会话的笔记：哪一格都没有去处。 */
const NO_NOTES: Readonly<Record<string, string>> = Object.freeze({})

const NO_SESSIONS: ReadonlySet<string> = new Set<string>()

/** 一条读数走到哪一步了。 */
type Load =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ok'; readonly reading: PathfinderReading }
  | { readonly phase: 'failed'; readonly message: string }

/**
 * 面板此刻读的那一档。
 *
 * 先按设置文档里那个值站着；读者在面板上当场改了就先按改的来，设置里那一个（别处翻了一行、或者
 * 写回落定）一有新值就跟着换。
 * @param stored - 设置文档此刻说的那个值。
 */
function usePreference<T>(stored: T): [T, (next: T) => void] {
  const [local, setLocal] = React.useState<T>(stored)
  React.useEffect(() => {
    setLocal(stored)
  }, [stored])
  return [local, setLocal]
}

export function PathfinderPanel(props: PanelProps): React.ReactElement {
  const { port, sessionId, openSession, knownSessions } = props
  /* 面板顶上那枚工作区选择器：候选是 DSH 自己那份清单，读的是挑中的那个工作区。挑中的那一个只活
   * 在这一屏上，面板自己的偏好与它无关，本地存储里也不留键。没挑过时跟着这条会话落在哪个桶走；
   * 会话不属于任何工作区就是「未分组」，那正是这条会话自己那个根。 */
  const workspaceStore = props.workspaces ?? NO_WORKSPACES
  const workspaceList = React.useSyncExternalStore(
    workspaceStore.subscribe,
    workspaceStore.getSnapshot,
    workspaceStore.getSnapshot,
  )
  const items = workspaceList.items
  const mine = React.useMemo(() => bucketOf(items, sessionId), [items, sessionId])
  const [pickedSpace, setPickedSpace] = React.useState<string | null | undefined>(undefined)
  const chosen = React.useMemo(() => {
    if (pickedSpace === undefined) return mine
    if (pickedSpace === null) return undefined
    /* 挑过的那一个不在清单里了（别处把它删了）：退回这条会话自己那个桶。 */
    return items.find((item) => item.workspaceId === pickedSpace) ?? mine
  }, [pickedSpace, mine, items])
  /* 递给宿主半身的那个根：空字符串＝没挑，按这条会话自己那个根读。 */
  const workspaceRoot = chosen?.path ?? ''
  /* 会话明明落在某个工作区里、读者却挑了「未分组」：未分组不是哪个根，不读。不作这一步，空根
   * 会顺着这条会话的 cwd 读回它所属的那个工作区——多半就是方才那个，字面一动不动，看着像没刷新。
   * 这条会话自己就在未分组那一桶里时，「未分组」仍是它自己那个根，照旧读。 */
  const pickedNone = pickedSpace === null && mine !== undefined
  /* 面板自己的偏好：读数从设置那一份表单上来，写回也从这条口子出去；设置服务还没接上时它给的是
   * 出厂那几条，面板照常画。 */
  const store = props.prefs ?? DEFAULT_SOURCE
  const preferences = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const stored = preferences.prefs
  const [tab, setTab] = usePreference<ViewId>(stored.tab)
  const [info, setInfo] = usePreference<InfoLevel>(stored.info)
  const [sideWidth, setSideWidth] = usePreference<number>(stored.sideWidth)
  const [otherStates, setOtherStates] = usePreference<boolean>(stored.otherStates)
  const [load, setLoad] = React.useState<Load>({ phase: 'loading' })
  const [notes, setNotes] = React.useState<Readonly<Record<string, string>>>(NO_NOTES)
  /* 读到哪一刻：取数那一拍定下。展示一律按它——读数里现成带着这一刻，不另取当下。 */
  const [at, setAt] = React.useState<Date>(() => new Date())
  const [tick, setTick] = React.useState(0)
  const [note, setNote] = React.useState<string | null>(null)
  const [lineId, setLineId] = React.useState<string | null>(null)
  const [settingsFor, setSettingsFor] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<InstructionReading | null>(null)
  const stageRef = React.useRef<HTMLDivElement | null>(null)
  const colsRef = React.useRef<HTMLDivElement | null>(null)
  const [fullCap, setFullCap] = React.useState<number>(FULL_FALLBACK)

  /* 取数：这一个看法露面的那一趟读一次；换一个工作区、写完一条再读一次（`tick` 是那一趟的记号）。 */
  React.useEffect(() => {
    if (sessionId === undefined || sessionId.length === 0) {
      setLoad({ phase: 'failed', message: '尚未选中会话，无法确定工作区。' })
      return undefined
    }
    if (pickedNone) return undefined
    let live = true
    setLoad({ phase: 'loading' })
    port.read(sessionId, workspaceRoot).then(
      (reading) => {
        if (!live) return
        setAt(new Date())
        setLoad({ phase: 'ok', reading })
      },
      (error: unknown) => {
        if (!live) return
        setLoad({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => { live = false }
  }, [port, sessionId, workspaceRoot, tick, pickedNone])

  /* 会话笔记：宿主半身把那一层目录原样搬回来，「每一格该去哪条会话」由模型层对着它读出来。
   * 只有当前那一格（看板）有卡片要点，所以只在这一格露面那一趟去读；读不回来就按空画。
   * 写面那几条动不到笔记，`tick` 不跟。 */
  React.useEffect(() => {
    if (pickedNone || tab !== 'now' || sessionId === undefined || sessionId.length === 0) {
      setNotes(NO_NOTES)
      return undefined
    }
    let live = true
    port.readSessions(sessionId, workspaceRoot).then(
      (reading) => { if (live) setNotes(readSessions(reading.notes)) },
      () => { if (live) setNotes(NO_NOTES) },
    )
    return () => { live = false }
  }, [port, sessionId, workspaceRoot, tab, pickedNone])

  /* 卡上那一下：记录里那条会话此刻在本机上，卡片才点得动。会话身份两处都认——先看这台机器自己
   * 的笔记，再看记录本体上那个字段。名册或导航口子缺一样，这一屏的卡片就都安安静静地摆着。 */
  const cardGo = React.useMemo<CardGo | null>(() => {
    if (openSession === undefined) return null
    const known = knownSessions ?? NO_SESSIONS
    return {
      targetOf: (node) => {
        const session = notes[node.id] ?? node.session
        return session !== undefined && session.length > 0 && known.has(session) ? session : null
      },
      open: openSession,
    }
  }, [notes, knownSessions, openSession])

  const reading = load.phase === 'ok' ? load.reading : null
  const project = React.useMemo(
    () => (reading === null
      ? null
      : readProject({
        nodes: reading.nodes,
        cycles: reading.cycles,
        instructions: reading.instructions,
        issues: reading.issues,
        at,
      })),
    [reading, at],
  )

  const cycles = project?.cycles ?? []
  const picked = cycles.find((cycle) => cycle.id === lineId) ?? cycles[0] ?? null

  /* 这个工作区里有没有节点：读数里一格都没有就是没有。没有的时候，五个跟节点走的格子各自
   * 收成一句话，页头那排计数也一起收走——空列头与三个 0 是替记录说它没说的话。「四栏互斥、
   * 并起来是全部」这个不变量在模型层一处成立，这里不拿栏长求和重推一遍。 */
  const noNodes = project !== null && project.nodes.length === 0

  /* 铺满要现算：量不到地界就退回上一趟的数，再没有就退回固定档。 */
  React.useLayoutEffect(() => {
    if (info !== 'full' || tab !== 'now') return
    const stage = stageRef.current
    const cols = colsRef.current
    if (stage === null || cols === null) return
    const card = cols.querySelector('.pf-card') as HTMLElement | null
    if (card === null || card.offsetHeight === 0) return
    const column = cols.firstElementChild as HTMLElement | null
    const gap = column === null ? 0 : Number.parseFloat(getComputedStyle(column).rowGap) || 0
    const head = cols.getBoundingClientRect().top - stage.getBoundingClientRect().top
    const rows = Math.floor((stage.clientHeight - head + gap) / (card.offsetHeight + gap))
    setFullCap(Math.max(1, Math.min(FULL_MAX, rows)))
  }, [info, tab, project, fullCap])

  /* 面板上落笔的那几处都走这一手：把那句话原样摆到提示行上，写成了就再读一次（`tick` 一动，
   * 上面那条读数的口子就重跑）。交回「成了没有」是给「记下一条」那一行用的——写成的那一句才
   * 把框里清空，工具拒了的话，原话留在框里等人接着改。 */
  const onWrite = React.useCallback(
    (run: () => Promise<{ ok: boolean; text: string }>): Promise<boolean> => {
      setNote(null)
      return run().then(
        (outcome) => {
          setNote(outcome.text.length > 0 ? outcome.text : null)
          if (outcome.ok) setTick((value) => value + 1)
          return outcome.ok
        },
        (error: unknown) => {
          setNote(error instanceof Error ? error.message : String(error))
          return false
        },
      )
    },
    [],
  )

  /* 面板上改的那一下：先按改的来，再把它写回设置文档——两边读同一份表单，所以设置页那一行当场
   * 也跟着动。写不进去时控件不静默弹回：这条口子的读数里那句话落在下面那条提示行上，服务没到场
   * 时也有自己的一句话。 */
  const prefNote = React.useRef<string | null>(null)
  const keep = React.useCallback((field: PrefField, value: unknown): void => {
    void store.write(field, value).then((accepted) => {
      const said = accepted ? null : (store.getSnapshot().failure ?? PREFS_NOT_KEPT)
      const was = prefNote.current
      prefNote.current = said
      /* 落定了就把上一句「没保存」收回去，别的提示（写面那几条）不动。 */
      if (said === null) setNote((held) => (held === was ? null : held))
      else setNote(said)
    }, () => undefined)
  }, [store])

  const pickView = React.useCallback((id: ViewId) => {
    setTab(id)
    keep(PANEL_PREF_FIELDS.defaultTab, id)
  }, [keep])

  const pickInfo = React.useCallback((level: InfoLevel) => {
    setInfo(level)
    keep(PANEL_PREF_FIELDS.infoLevel, level)
  }, [keep])

  const pickOtherStates = React.useCallback((on: boolean) => {
    setOtherStates(on)
    keep(PANEL_PREF_FIELDS.showOtherStates, on)
  }, [keep])

  const active = VIEWS.find((view) => view.id === tab) ?? VIEWS[0] as View

  /* 这一屏有没有话可说。挑了「未分组」而这条会话有归属，就是那一格名下无记录；四份来源里一份都
   * 列不到，就是那个工作区里没有这份记录；列到了、却一份也解不出来，就是读不动。三种情形六格都
   * 无话可说，这一格收成一句话——牌位与工作区留着，标签、计数与正文一起收走。 */
  const nothing = pickedNone
    ? UNGROUPED_EMPTY
    : load.phase === 'failed'
      ? load.message
      : reading !== null && everySourceIs(reading, 'missing')
        ? NO_RECORD
        : reading !== null && everySourceIs(reading, 'unusable')
          ? UNREADABLE_RECORD
          : null

  return (
    <div className="pf-page">
      <header className="pf-head">
        <div className="pf-head-left">
          <div className="pf-head-top">
            <span className="pf-brand">PATHFINDER</span>
            {items.length === 0 ? null : (
              <span className="pf-pick">
                <select
                  aria-label="工作区"
                  value={chosen?.workspaceId ?? ''}
                  onChange={(event) => setPickedSpace(event.target.value.length === 0 ? null : event.target.value)}
                >
                  {items.map((item) => <option key={item.workspaceId} value={item.workspaceId}>{item.title}</option>)}
                  {/* 会话不属于任何工作区的那一堆，DSH 自己叫它「未分组」，站在名单最后。 */}
                  <option value="">未分组</option>
                </select>
              </span>
            )}
          </div>
        </div>
        {nothing === null && !noNodes ? (
          <div className="pf-count" id="census">
            {project === null ? null : <Census project={project} />}
          </div>
        ) : null}
        {nothing === null ? (
          <div className="pf-tabs" role="tablist">
            {VIEWS.map((view) => (
              <button
                key={view.id}
                type="button"
                className="pf-tab"
                id={`tab-${view.id}`}
                role="tab"
                aria-selected={view.id === tab}
                aria-controls={`pane-${view.id}`}
                onClick={() => pickView(view.id)}
              >
                {view.label}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      {nothing === null ? (
      <div className="pf-stage" ref={stageRef}>
        {/* 只剩一句话的那一屏也撑满：舞台把不撑满的模块上下居中，那句话就漂在当中、还比页头
            那条左缘右一步；撑满之后它跟另外五格同处——这一格自己的左上角。 */}
        <div className={`pf-frame${active.fill || noNodes ? ' is-fill' : ''}`} id="frame">
          <BoardPane
            active={tab === 'now'}
            noNodes={noNodes}
            project={project}
            info={info}
            cap={capOf(info, fullCap)}
            go={cardGo}
            colsRef={colsRef}
            onPickInfo={pickInfo}
          />

          <DetailPane
            active={tab === 'detail'}
            noNodes={noNodes}
            cycles={cycles}
            picked={picked}
            project={project}
            sideWidth={sideWidth}
            onSideWidth={setSideWidth}
            onSideCommit={(px) => keep(PANEL_PREF_FIELDS.sideWidth, clampSide(px))}
            onPickLine={setLineId}
            onOpenSettings={setSettingsFor}
          />

          <NotesPane
            active={tab === 'notes'}
            noNodes={noNodes}
            project={project}
            cycles={cycles}
            showArchived={stored.archived}
            onAdd={(text, scope, cycle, node) => (
              onWrite(() => port.say(sessionId ?? '', workspaceRoot, text, scope, cycle, node))
            )}
            onArchive={(id) => { void onWrite(() => port.write('archive', sessionId ?? '', workspaceRoot, id)) }}
            onRevive={(id) => { void onWrite(() => port.write('revive', sessionId ?? '', workspaceRoot, id)) }}
            onDelete={(instruction) => setDeleting(instruction)}
          />

          {/* 依赖与问题这两格各是蓝本里的一份独立文档，在面板里由这一格当它的页根：
              `is-embed` 那枚让位记号与页记号（`pf-wires` / `pf-issue`）一道挂在它上面，
              构建口按页记号收拢各表那一份，两张表因此互不越界。 */}
          <div
            className="pf-pane is-frame is-embed pf-wires"
            id="pane-wires"
            role="tabpanel"
            aria-labelledby="tab-wires"
            data-fill=""
            hidden={tab !== 'wires'}
          >
            {noNodes ? <p className="pf-innone">{NOT_ENABLED}</p>
              : project === null ? null : <DependencyField project={project} active={tab === 'wires'} />}
          </div>

          <div
            className="pf-pane is-frame is-embed pf-issue"
            id="pane-issue"
            role="tabpanel"
            aria-labelledby="tab-issue"
            data-fill=""
            hidden={tab !== 'issue'}
          >
            {project === null ? null : (
              <IssuePool project={project} showOtherStates={otherStates} onShowOtherStates={pickOtherStates} />
            )}
          </div>

          <ConfigPane
            port={port}
            sessionId={sessionId ?? ''}
            workspaceRoot={workspaceRoot}
            noNodes={noNodes}
            active={tab === 'config'}
            onNote={setNote}
          />
        </div>
      </div>
      ) : (
        <div className="pf-none">
          <p>{nothing}</p>
        </div>
      )}

      {note === null ? null : <p className="pf-innone">{note}</p>}

      {settingsFor === null ? null : (
        <LineSettings
          cycle={cycles.find((candidate) => candidate.id === settingsFor) ?? null}
          raw={reading?.cycles.find((candidate) => candidate.id === settingsFor)}
          onClose={() => setSettingsFor(null)}
          onWrite={(key, value) => onWrite(() => port.setPolicy(sessionId ?? '', workspaceRoot, settingsFor, key, value))}
        />
      )}

      {deleting === null ? null : (
        <DeleteConfirm
          instruction={deleting}
          said={deleting.text ?? ''}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const id = deleting.id
            setDeleting(null)
            onWrite(() => port.write('remove', sessionId ?? '', workspaceRoot, id))
          }}
        />
      )}
    </div>
  )
}

function capOf(info: InfoLevel, fullCap: number): number {
  return info === 'full' ? fullCap : INFO_CAPS[info]
}

/** 右上角四个数；等待处理只在真有出局等人的时候才露面，且站在最前。 */
function Census(props: { readonly project: ProjectReading }): React.ReactElement {
  const { columns } = props.project
  return (
    <React.Fragment>
      {columns.shelved.length > 0 ? <Pill cls="is-shelved" n={columns.shelved.length} label="等待处理" /> : null}
      <Pill cls="is-done" n={columns.completed.length} label="已交付" />
      <Pill cls="is-running" n={columns.running.length} label="进行中" />
      <Pill cls="is-todo" n={columns.todo.length} label="未开始" />
    </React.Fragment>
  )
}
