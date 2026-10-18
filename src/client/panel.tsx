/**
 * 主面板：六格标签行、看法之间的切换、以及当前 / 明细 / 指令三格各自的版面。
 *
 * 读数一个都不在这里算：四份记录从口子上进来，由 `src/model` 那套纯函数读成那一刻的读数，这一层
 * 只把读数画出来。面板自己那几个显示偏好住在 Host 的设置文档里，经 `prefs.ts` 那条口子读写。
 */
import * as React from 'react'
import type { PathfinderInstruction, PathfinderReading, PathfinderSourceState } from '../host/contract.ts'
import type { CyclePolicyKey, InstructionScope } from '../host/gateway.ts'
import type { CycleReading, InstructionReading, NodeReading, ProjectReading } from '../model/index.ts'
import { clock, dayLabel, duration, elapsedSince, readProject } from '../model/index.ts'
import type { InfoLevel, PrefField, PrefsSource, ViewId } from './prefs.ts'
import {
  clampSide,
  DEFAULT_SOURCE,
  INFO_LABELS,
  PANEL_PREF_FIELDS,
  POLICY_KEYS,
  SIDE_DEFAULT,
  SIDE_MAX,
  SIDE_MIN,
  VIEW_LABELS,
} from './prefs.ts'
import type { PanelPort, WriteVerb } from './data.ts'
import { bucketOf, NO_WORKSPACES, type WorkspaceSource } from './workspaces.ts'
import { ConfigPane } from './config.tsx'
import { DependencyField } from './field.tsx'
import { IssuePool } from './pool.tsx'

/** 六个看法：身份、标签上的字、以及这一格要不要吃掉整块地界。 */
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

/** 明细那五组，顺序就是读者遇到它们的顺序。 */
interface Group {
  readonly key: 'shelved' | 'run' | 'ready' | 'wait' | 'done'
  readonly label: string
  readonly cls: string
  readonly deps: boolean
}

/* 五组一律摊开：这一格叫明细，读者点进来要看的就是那几行。折起来那一手还留着，
 * 由读者按下去。 */
const GROUPS: readonly Group[] = [
  { key: 'shelved', label: '等待处理', cls: 'is-shelved', deps: false },
  { key: 'run', label: '进行中', cls: 'is-running', deps: false },
  { key: 'ready', label: '可开工', cls: 'is-todo', deps: false },
  { key: 'wait', label: '未开始', cls: 'is-todo', deps: true },
  { key: 'done', label: '已交付', cls: 'is-done', deps: false },
]

/** 收起归档时，一组里最多露几行不算数的。 */
const NOTES_ROWS = 5

/** 设置服务没到场时面板上那句话：这一下只活在这一屏上。 */
const PREFS_NOT_KEPT = '显示偏好未能保存：设置服务未连接，本次改动只在当前页面生效。'

/** 这个工作区里没有这份记录时，面板正文摆的那一句。 */
const NO_RECORD = '当前工作区没有 pathfinder 的记录。'

/** 记录在、四份来源一份都解不出来时摆的另一句：与没记录是两件事。 */
const UNREADABLE_RECORD = '无法读取当前工作区的记录。'

/** 四份来源是不是都落在同一个结局上。 */
function everySourceIs(reading: PathfinderReading, state: PathfinderSourceState): boolean {
  const states = Object.values(reading.sources)
  return states.length > 0 && states.every((one) => one === state)
}

/** 一条线自己那三个数，一个数一行；名字与那句话都照蓝本。 */
const POLICY_ROWS: readonly { key: CyclePolicyKey; name: string; note: string }[] = [
  {
    key: 'parallel',
    name: '可并行的会话数上限',
    note: '单条管线可以并行启动的会话数量，默认值为 1。',
  },
  {
    key: 'test_seconds_limit',
    name: '测试套件的运行时间上限（秒）',
    note: '全量验证的实际时长上限阈值；超过该上限会自动加入精简或加速测试的节点。',
  },
  {
    key: 'issue_pool_weight_limit',
    name: '问题池加权和的上限',
    note: '问题池里不同等级的问题，按加权权重（P3/P2/P1/P0 = 1/2/4/8）算出的总和上限阈值；超过该阈值会自动加入解决问题的节点。',
  },
]

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
  }, [port, sessionId, workspaceRoot, tick])

  /* 会话笔记：这一格最近开过的那条会话住在记录库那一层按节点分的小份笔记上，由宿主半身那条端点
   * 交回来。只有当前那一格（看板）有卡片要点，所以只在这一格露面那一趟去读；读不回来就按空画。
   * 写面那几条动不到笔记，`tick` 不跟。 */
  React.useEffect(() => {
    if (tab !== 'now' || sessionId === undefined || sessionId.length === 0) {
      setNotes(NO_NOTES)
      return undefined
    }
    let live = true
    port.readSessions(sessionId, workspaceRoot).then(
      (reading) => { if (live) setNotes(reading.sessions) },
      () => { if (live) setNotes(NO_NOTES) },
    )
    return () => { live = false }
  }, [port, sessionId, workspaceRoot, tab])

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

  /* 这一屏有没有话可说。四份来源里一份都列不到，就是那个工作区里没有这份记录；列到了、却一份也
   * 解不出来，就是读不动。两种情形六格都无话可说，这一格收成一句话——牌位与工作区留着，标签、
   * 计数与正文一起收走。 */
  const nothing = load.phase === 'failed'
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
        {nothing === null ? (
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
        <div className={`pf-frame${active.fill ? ' is-fill' : ''}`} id="frame">
          <section
            className="pf-pane pf-board"
            id="pane-now"
            role="tabpanel"
            aria-labelledby="tab-now"
            hidden={tab !== 'now'}
          >
            <div className="pf-boardbar">
              <h3 className="pf-colhead">进行中</h3>
              <h3 className="pf-colhead">刚完成</h3>
              <div className="pf-boardtail">
                <h3 className="pf-colhead">即将进线</h3>
                <div className="pf-seg pf-modes" role="group" aria-label="每列几张卡">
                  {(['lean', 'three', 'full'] as const).map((level) => (
                    <button
                      key={level}
                      type="button"
                      className="pf-segbtn"
                      aria-pressed={level === info}
                      onClick={() => pickInfo(level)}
                    >
                      {INFO_LABELS[level]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="pf-cols" id="cols" ref={colsRef}>
              {project === null ? null : <BoardColumns project={project} cap={capOf(info, fullCap)} go={cardGo} />}
            </div>
          </section>

          <div
            className="pf-pane"
            id="pane-detail"
            role="tabpanel"
            aria-labelledby="tab-detail"
            data-fill=""
            hidden={tab !== 'detail'}
          >
            <div className="pf-detail" style={{ ['--pf-side-w' as string]: `${sideWidth}px` }}>
              <div className="pf-lineside" role="group" aria-label="线路">
                {cycles.map((cycle) => (
                  <div className="pf-lineitem" key={cycle.id}>
                    <button
                      type="button"
                      className="pf-linepick"
                      aria-current={cycle.id === picked?.id}
                      aria-label={`${cycle.id} · ${stateWord(cycle)}`}
                      onClick={() => setLineId(cycle.id)}
                    >
                      <LineMark cycle={cycle} />
                      <span className="pf-cycle">{cycle.id}</span>
                    </button>
                    <button
                      type="button"
                      className="pf-mini"
                      aria-label={`${cycle.id} 的设置`}
                      onClick={() => setSettingsFor(cycle.id)}
                    >
                      设置
                    </button>
                  </div>
                ))}
              </div>
              <SplitHandle
                value={sideWidth}
                onChange={(px) => setSideWidth(px)}
                onCommit={(px) => keep(PANEL_PREF_FIELDS.sideWidth, clampSide(px))}
              />
              <div className="pf-linemain">
                <div className="pf-scroll" role="region" aria-label="明细" tabIndex={0}>
                  {picked === null ? null : <DetailList cycle={picked} project={project as ProjectReading} />}
                </div>
              </div>
            </div>
          </div>

          <div
            className="pf-pane"
            id="pane-notes"
            role="tabpanel"
            aria-labelledby="tab-notes"
            data-fill=""
            hidden={tab !== 'notes'}
          >
            {project === null ? null : (
              <InstructionAdd
                cycles={cycles}
                inHand={project.columns.running[0] ?? null}
                onAdd={(text, scope, cycle, node) => (
                  onWrite(() => port.say(sessionId ?? '', workspaceRoot, text, scope, cycle, node))
                )}
              />
            )}
            <div className="pf-scroll" id="notes-scroll" role="region" aria-label="用户指令" tabIndex={0}>
              {project === null ? null : (
                <InstructionBook
                  project={project}
                  raw={reading?.instructions ?? []}
                  showArchived={stored.archived}
                  onArchive={(id) => { void onWrite(() => port.write('archive', sessionId ?? '', workspaceRoot, id)) }}
                  onRevive={(id) => { void onWrite(() => port.write('revive', sessionId ?? '', workspaceRoot, id)) }}
                  onDelete={(instruction) => setDeleting(instruction)}
                />
              )}
            </div>
          </div>

          {/* 依赖与问题这两格各是蓝本里的一份独立文档，在面板里由这一格当它的页根：
              构建口按 `pf-wires` / `pf-issue` 收拢它们各自那张表，两张表因此互不越界。 */}
          <div
            className="pf-pane is-frame pf-wires"
            id="pane-wires"
            role="tabpanel"
            aria-labelledby="tab-wires"
            data-fill=""
            hidden={tab !== 'wires'}
          >
            {project === null ? null : <DependencyField project={project} active={tab === 'wires'} />}
          </div>

          <div
            className="pf-pane is-frame pf-issue"
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

function Pill(props: { readonly cls: string; readonly n: number; readonly label: string }): React.ReactElement {
  return (
    <span className="pf-pill" title={props.label}>
      <i className={`pf-cell ${props.cls}`} />
      <b className="pf-num">{`× ${String(props.n)}`}</b>
    </span>
  )
}

/**
 * 三列看板：进行中（等待处理的排在上头）、刚完成、即将进线。
 * @param props - 那一刻的读数、每列几张卡，以及卡上那一下的去处。
 */
function BoardColumns(props: { readonly project: ProjectReading; readonly cap: number; readonly go: CardGo | null }): React.ReactElement {
  const { columns } = props.project
  const first = gatesFirst(columns.shelved, 'shelved', props.go).concat(gatesFirst(columns.running, 'run', props.go))
  return (
    <React.Fragment>
      <Column items={first} cap={props.cap} go={props.go} />
      <Column items={gatesFirst(columns.completed, 'done', props.go)} cap={props.cap} go={props.go} />
      <Column items={gatesFirst(columns.ready, 'next', props.go)} cap={props.cap} go={props.go} />
    </React.Fragment>
  )
}

/** 等人优先：有闸的格排到前面，其余的保持记录给的那个次序。顺手把每张卡的去处定下来。 */
function gatesFirst(list: readonly NodeReading[], kind: CardKind, go: CardGo | null): readonly Paired[] {
  return list
    .map((node) => ({ node, kind, target: go === null ? null : go.targetOf(node) }))
    .slice()
    .sort((left, right) => (left.node.gate === null ? 1 : 0) - (right.node.gate === null ? 1 : 0))
}

/** 一张卡连同它此刻的读法：`target` 是点下去要去的那条会话，没有去处就是 `null`。 */
interface Paired {
  readonly node: NodeReading
  readonly kind: CardKind
  readonly target: string | null
}

interface CardGo {
  targetOf(node: NodeReading): string | null
  open(target: string): void
}

type CardKind = 'shelved' | 'run' | 'next' | 'done'

/** 一列卡片：一张卡都没有的列，底下什么也不印。 */
function Column(props: { readonly items: readonly Paired[]; readonly cap: number; readonly go: CardGo | null }): React.ReactElement {
  return (
    <section className="pf-col">
      {props.items.slice(0, props.cap).map((item) => <Card key={`${item.kind}:${item.node.id}`} {...item} go={props.go} />)}
    </section>
  )
}

/**
 * 一张卡。
 *
 * 记录里记着这一格的会话、而那条会话此刻就在这台机器上时，点它切到那一格去：卡片上挂得住那两下
 * （指针是手、悬停与按住提一档描边），键盘上回车与空格按下去等于点一下。
 *
 * 记录里没写会话、或那条会话不在这台机器上时，这一格在这台机器上没有去处：卡片照旧摆着，只是没
 * 有可点的样子。屏上不给一句解释——去处没了这件事，卡片自己说得出。
 * @param props - 这一格、它的读法、它的去处，以及叫哪一手。
 */
function Card(props: Paired & { readonly go: CardGo | null }): React.ReactElement {
  const { node, kind, target, go } = props
  const cls = kind === 'shelved' ? 'shelved' : kind === 'run' ? 'run' : kind === 'next' ? 'next' : 'done'
  const loud = node.gate !== null && node.state !== 'todo'
  /* 去处分两截备好：没有去处时那个 `null` 让下面整批属性一个都不落。 */
  const jump = target === null || go === null ? null : { target, open: go.open }
  return (
    <article
      className={`pf-card is-${cls}${loud ? ' is-gate' : ''}${jump === null ? ' is-inert' : ''}`}
      data-id={node.id}
      {...(jump === null ? {} : {
        role: 'button',
        tabIndex: 0,
        /* 名字带上这一格的身份：一屏十几张卡，同一句名字读屏用户分不出是哪一张；身份就是
         * 悬停里那段八字的把手，这句话与卡片上那一行同源。 */
        'aria-label': `${nodeHover(node)} 的会话`,
        onClick: () => jump.open(jump.target),
        onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          jump.open(jump.target)
        },
      })}
    >
      <div className="pf-card-meta">
        <span className="pf-card-cycle">{node.cycleIds[0] ?? ''}</span>
      </div>
      <h2 className="pf-card-title" title={nodeHover(node)}>{nodeName(node)}</h2>
      <div className="pf-card-run">
        <StateMark node={node} kind={kind} />
        {node.gate === null ? null : (
          <span className={`pf-gate${loud ? '' : ' is-quiet'}`}>{node.gate.word}</span>
        )}
        {kind === 'shelved'
          ? <span className={`pf-elapsed${node.parkedSince === null ? ' is-unknown' : ''}`}><span className="pf-num">{durationOf(node.parkedSince)}</span></span>
          : kind === 'run'
            ? <span className={`pf-elapsed${node.elapsedSeconds === null ? ' is-unknown' : ''}`}><span className="pf-num">{duration(node.elapsedSeconds)}</span></span>
            : kind === 'next'
              ? <DepsChip node={node} />
              : <span className="pf-card-time pf-num">{timeOf(node.completedAt)}</span>}
      </div>
    </article>
  )
}

/** 一格的标题：记录里那段标题；记录里没写标题的格才轮到 id 的短写。 */
function nodeName(node: NodeReading): string {
  return node.title ?? shortId(node.id)
}

/** 一格的悬停：全名，后面跟一段八字把手；名字本身就是那八个字时不重复一遍。 */
function nodeHover(node: NodeReading): string {
  const short = shortId(node.id)
  return node.title === undefined || node.title === short ? nodeName(node) : `${node.title} · ${short}`
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** 那一刻到今天／没有那一刻的样子。 */
function timeOf(moment: Date | null): string {
  return moment === null ? '--' : `${dayLabel(moment, new Date())} ${clock(moment)}`
}

function durationOf(moment: Date | null): string {
  return moment === null ? '--' : elapsedSince(moment, new Date())
}

/** 依赖那两句话，逐字是记录里的词：可开工 / 前置节点 N 个。落定的格不欠谁的前置。 */
function DepsChip(props: { readonly node: NodeReading }): React.ReactElement | null {
  const { node } = props
  if (node.state === 'completed') return null
  const open = node.openDependencies.length
  return (
    <span className={`pf-deps${open === 0 ? ' is-ready' : ''}`}>
      {open === 0 ? '可开工' : <React.Fragment>{'前置节点 '}<b className="pf-num">{open}</b>{' 个'}</React.Fragment>}
    </span>
  )
}

/** 状态标：有闸的格一律是那枚暂停，其余按它在哪一列画。 */
function StateMark(props: { readonly node: NodeReading; readonly kind: CardKind | Group['key'] }): React.ReactElement {
  const { node } = props
  const loud = node.gate !== null && node.state !== 'todo'
  if (loud) {
    return (
      <span className="pf-state is-gate" title={gateTitle(node)}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M4.6 2.6v6.8M7.4 2.6v6.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </span>
    )
  }
  if (props.kind === 'run') {
    return <span className="pf-state is-run" title={node.elapsedSeconds === null ? '进行中' : `进行中 · ${duration(node.elapsedSeconds)}`} />
  }
  if (props.kind === 'next' || props.kind === 'wait' || props.kind === 'ready') {
    return <span className="pf-state is-next" title="即将进线" />
  }
  return (
    <span className="pf-state is-done" title="已交付">
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <path d="M2.5 6.5l2.4 2.4 4.6-5.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

/** 那一格的闸：哪一个词、哪一刻。 */
function gateTitle(node: NodeReading): string {
  if (node.gate === null) return ''
  return node.gate.since === null ? node.gate.word : `${node.gate.word} · ${timeOf(node.gate.since)}`
}

/** 一条线的记号：停着空着，跑着转圈，名下有人等着的画成阻塞。 */
function LineMark(props: { readonly cycle: CycleReading }): React.ReactElement {
  const { cycle } = props
  const cls = cycle.parked.length > 0 ? 'is-blocked' : cycle.inService ? 'is-run' : ''
  return <span className={`pf-linemark ${cls}`.trim()} title={stateWord(cycle)} />
}

function stateWord(cycle: CycleReading): string {
  if (cycle.parked.length > 0) return '阻塞'
  return cycle.inService ? '运行中' : '停止'
}

/** 侧栏与正文之间那道缝：单边挪 Δ，量的是这一列的宽度。 */
function SplitHandle(props: {
  readonly value: number
  readonly onChange: (px: number) => void
  readonly onCommit: (px: number) => void
}): React.ReactElement {
  const { value, onChange, onCommit } = props
  const from = React.useRef(0)
  const base = React.useRef(value)
  return (
    <div
      className="pf-grip"
      id="detail-split"
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      aria-label="调整线路侧栏的宽度"
      aria-valuenow={value}
      aria-valuemin={SIDE_MIN}
      aria-valuemax={SIDE_MAX}
      onPointerDown={(event) => {
        from.current = event.clientX
        base.current = value
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        const moved = Math.round(clampSide(base.current + (event.clientX - from.current)))
        if (moved !== value) onChange(moved)
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        onCommit(value)
      }}
      onDoubleClick={() => { onChange(SIDE_DEFAULT); onCommit(SIDE_DEFAULT) }}
    />
  )
}

/** 明细：选中那条线的节点清单，按五组分。 */
function DetailList(props: { readonly cycle: CycleReading; readonly project: ProjectReading }): React.ReactElement {
  const { cycle, project } = props
  return (
    <React.Fragment>
      {GROUPS.map((group) => {
        const list = nodesOf(group.key, cycle, project)
        if (list.length === 0) return null
        return <DetailGroup key={group.key} group={group} nodes={list} />
      })}
    </React.Fragment>
  )
}

/** 一组属于这条线的格子：走过它的算，它此刻正握着的也算。 */
function nodesOf(key: Group['key'], cycle: CycleReading, project: ProjectReading): readonly NodeReading[] {
  const mine = (list: readonly NodeReading[]): readonly NodeReading[] =>
    list.filter((node) => node.cycleIds[0] === cycle.id || node.heldBy.includes(cycle.id))
  if (key === 'shelved') return mine(project.columns.shelved)
  if (key === 'run') return mine(project.columns.running)
  if (key === 'ready') return mine(project.columns.ready)
  if (key === 'wait') return mine(project.columns.blocked)
  return mine(project.columns.completed)
    .slice()
    .sort((left, right) => (right.completedAt?.getTime() ?? 0) - (left.completedAt?.getTime() ?? 0))
}

/** 一组的组头与它下面的行。 */
function DetailGroup(props: { readonly group: Group; readonly nodes: readonly NodeReading[] }): React.ReactElement {
  const { group } = props
  const [folded, setFolded] = React.useState(false)
  return (
    <section className={`pf-sec${folded ? ' is-folded' : ''}`}>
      <button
        type="button"
        className="pf-rowhead"
        aria-expanded={!folded}
        onClick={() => setFolded((value) => !value)}
      >
        <span className="pf-rowhead-key">{group.label}</span>
        {folded
          ? <span className="pf-rowhead-figs pf-rowcount"><b className="pf-num">{props.nodes.length}</b>{' 格'}</span>
          : null}
      </button>
      {props.nodes.map((node) => (
        <div className={`pf-row ${group.cls}`} key={node.id} data-id={node.id} title={gateTitle(node)}>
          <StateMark node={node} kind={group.key} />
          <span className="pf-rowtitle" title={nodeHover(node)}>{nodeName(node)}</span>
          <span className="pf-rowfigs">{group.deps ? <DepsChip node={node} /> : null}</span>
          {node.gate !== null && node.gate.word !== group.label
            ? <span className={`pf-gate pf-rowgate${node.state === 'todo' ? ' is-quiet' : ''}`}>{node.gate.word}</span>
            : null}
        </div>
      ))}
    </section>
  )
}

/** 范围那一枚挑出来的三样：范围词、绑哪条线、绑哪一格。 */
interface ScopeChoice {
  readonly value: string
  readonly label: string
  readonly scope: InstructionScope
  readonly cycle: string
  readonly node: string
}

/** 全局那一项：范围表上的头一项，挑过的那条线不在了就退到它。 */
const GLOBAL_CHOICE: ScopeChoice = { value: 'global', label: '全局', scope: 'global', cycle: '', node: '' }

/**
 * 范围那一列摆哪几项：全局、记录里那几条线、此刻在手里的那一格。
 *
 * 蓝本那一行也只摆这三样，只是它每回只点得到最上面那个在跑着的格；真面板里在手里的是哪
 * 一格由记录自己说，没有就是没有这一项。
 * @param cycles - 那一刻记录里那几条线。
 * @param inHand - 此刻在手里的那一格；没有就只留前两样。
 */
function scopeChoices(cycles: readonly CycleReading[], inHand: NodeReading | null): readonly ScopeChoice[] {
  const out: ScopeChoice[] = [GLOBAL_CHOICE]
  for (const cycle of cycles) {
    out.push({ value: `cycle:${cycle.id}`, label: cycle.id, scope: 'cycle', cycle: cycle.id, node: '' })
  }
  if (inHand !== null) {
    const name = inHand.title ?? inHand.id
    const short = name.length > 12 ? `${name.slice(0, 12)}…` : name
    out.push({ value: `node:${inHand.id}`, label: `这一格 · ${short}`, scope: 'node', cycle: '', node: inHand.id })
  }
  return out
}

/**
 * 「记下一条」那一行：范围点名 + 原话照抄，站在这一格的最上头。
 *
 * 写成了才把那句话从框里收走：工具拒了的话，用户自己那句原话还留在原处等着改。
 */
function InstructionAdd(props: {
  readonly cycles: readonly CycleReading[]
  readonly inHand: NodeReading | null
  readonly onAdd: (text: string, scope: InstructionScope, cycle: string, node: string) => Promise<boolean>
}): React.ReactElement {
  const [text, setText] = React.useState('')
  const [picked, setPicked] = React.useState(GLOBAL_CHOICE.value)
  const box = React.useRef<HTMLInputElement | null>(null)
  const choices = scopeChoices(props.cycles, props.inHand)
  const chosen = choices.find((one) => one.value === picked) ?? GLOBAL_CHOICE

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const said = text.trim()
    if (said.length === 0) {
      box.current?.focus()
      return
    }
    void props.onAdd(said, chosen.scope, chosen.cycle, chosen.node).then((accepted) => {
      if (accepted) setText('')
    })
  }

  return (
    <form className="pf-add" id="add" onSubmit={submit}>
      <span className="pf-pick">
        <select
          aria-label="这句话管到哪儿"
          value={chosen.value}
          onChange={(event) => setPicked(event.target.value)}
        >
          {choices.map((one) => <option key={one.value} value={one.value}>{one.label}</option>)}
        </select>
      </span>
      <input
        ref={box}
        type="text"
        placeholder="原话照抄"
        aria-label="原话照抄"
        autoComplete="off"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="pf-btn">添加</button>
    </form>
  )
}

/** 指令那一格：按范围分组的登记簿。 */
function InstructionBook(props: {
  readonly project: ProjectReading
  readonly raw: readonly PathfinderInstruction[]
  readonly showArchived: boolean
  readonly onArchive: (id: string) => void
  readonly onRevive: (id: string) => void
  readonly onDelete: (instruction: InstructionReading) => void
}): React.ReactElement {
  const { project, raw } = props
  const [folded, setFolded] = React.useState<Readonly<Record<string, boolean>>>({})
  const [open, setOpen] = React.useState<Readonly<Record<string, boolean>>>({})
  const extras = React.useMemo(() => {
    const table: Record<string, PathfinderInstruction> = {}
    for (const entry of raw) if (typeof entry.id === 'string') table[entry.id] = entry
    return table
  }, [raw])

  /* 已归档的条目默认收起来：一屏里先看见现在还算数的。设置里那一行打开之后，它们回到各自的段
   * 里，行右边那枚动作照旧可用。 */
  const visible = props.showArchived
    ? project.instructions
    : project.instructions.filter((entry) => entry.standing)
  const groups = groupInstructions(project, visible)
  if (project.instructions.length === 0) {
    return <p className="pf-innone">这份记录里还没有指令。</p>
  }
  return (
    <React.Fragment>
      {groups.length === 0
        ? <p className="pf-innone">现在没有生效的指令。</p>
        : groups.map((group) => {
          const live = group.entries.filter((entry) => entry.inForce).length
          const isFolded = folded[group.key] === true
          const isOpen = open[group.key] === true
          const hidden = Math.max(0, group.entries.length - live - NOTES_ROWS)
          const shown = isOpen ? group.entries : group.entries.slice(0, live + NOTES_ROWS)
          return (
            <section className={`pf-sec${isFolded ? ' is-folded' : ''}`} key={group.key}>
              <button
                type="button"
                className="pf-rowhead"
                aria-expanded={!isFolded}
                onClick={() => setFolded((table) => ({ ...table, [group.key]: !isFolded }))}
              >
                <span className="pf-rowhead-key">{group.label}</span>
                <span className="pf-rowhead-figs">
                  <b className="pf-num">{live}</b>
                  {' 生效'}
                  <React.Fragment>{' · '}<b className="pf-num">{group.entries.length}</b>{' 条'}</React.Fragment>
                </span>
              </button>
              {shown.map((entry) => (
                <InstructionRow
                  key={entry.id}
                  entry={entry}
                  extra={extras[entry.id]}
                  onArchive={props.onArchive}
                  onRevive={props.onRevive}
                  onDelete={props.onDelete}
                />
              ))}
              {hidden > 0 && !isOpen
                ? (
                  <button type="button" className="pf-trim" onClick={() => setOpen((table) => ({ ...table, [group.key]: true }))}>
                    {`展开其余 ${String(hidden)} 条`}
                  </button>
                )
                : null}
              {hidden > 0 && isOpen
                ? (
                  <button type="button" className="pf-trim" onClick={() => setOpen((table) => ({ ...table, [group.key]: false }))}>
                    收起
                  </button>
                )
                : null}
            </section>
          )
        })}
    </React.Fragment>
  )
}

interface InstructionGroup {
  readonly key: string
  readonly label: string
  readonly entries: readonly InstructionReading[]
}

/**
 * 按范围分组：全局在前，然后每条线（在跑的在前），再是不认得的那条线，最后一格。
 *
 * 组内还算数的排在前头、新说的在前——读者先遇到此刻正管着他的那几句。
 * @param project - 那一刻的项目读数，分组用的几条线从它来。
 * @param entries - 这一刻真的要摆上页面的那几条；已归档的露不露面由调用方先筛过。
 */
function groupInstructions(
  project: ProjectReading,
  entries: readonly InstructionReading[],
): readonly InstructionGroup[] {
  const groups = new Map<string, { label: string; entries: InstructionReading[] }>()
  const group = (key: string, label: string): { label: string; entries: InstructionReading[] } => {
    const held = groups.get(key)
    if (held !== undefined) return held
    const fresh = { label, entries: [] as InstructionReading[] }
    groups.set(key, fresh)
    return fresh
  }
  group('global', '全局')
  for (const cycle of project.cycles) group(`cycle:${cycle.id}`, cycle.id)
  group('cycle:', '未分组')
  group('node', '这一格')

  for (const entry of entries) {
    const key = entry.scope === 'global'
      ? 'global'
      : entry.scope === 'cycle'
        ? (entry.cycleId === null ? 'cycle:' : `cycle:${entry.cycleId}`)
        : 'node'
    group(key, key === 'node' ? '这一格' : key === 'cycle:' ? '未分组' : key).entries.push(entry)
  }

  const order = ['global', ...[...groups.keys()].filter((key) => key.startsWith('cycle:') && key !== 'cycle:'), 'cycle:', 'node']
  const out: InstructionGroup[] = []
  for (const key of order) {
    const held = groups.get(key)
    if (held === undefined || held.entries.length === 0) continue
    held.entries.sort((left, right) => {
      const byForce = (left.inForce ? 0 : 1) - (right.inForce ? 0 : 1)
      if (byForce !== 0) return byForce
      return (right.saidAt?.getTime() ?? 0) - (left.saidAt?.getTime() ?? 0)
    })
    out.push({ key, label: held.label, entries: held.entries })
  }
  return out
}

function InstructionRow(props: {
  readonly entry: InstructionReading
  readonly extra: PathfinderInstruction | undefined
  readonly onArchive: (id: string) => void
  readonly onRevive: (id: string) => void
  readonly onDelete: (instruction: InstructionReading) => void
}): React.ReactElement {
  const { entry, extra } = props
  const moment = entry.inForce ? entry.saidAt : (entry.closedAt ?? entry.saidAt)
  const mark = entry.inForce ? '' : entry.standing ? '范围外' : '已归档'
  return (
    <article className={`pf-ins${entry.inForce ? '' : ' is-out'}`} title={entry.nodeId ?? ''}>
      <div className="pf-ins-text">{entry.text ?? ''}</div>
      <div className="pf-ins-read" title={`${entry.inForce ? '说于' : `${mark}于`} ${timeOf(moment)}`}>
        {mark.length === 0 ? null : <span className="pf-ins-mark">{mark}</span>}
        <span className="pf-num">{dayLabel(moment, new Date())}</span>
      </div>
      <span className="pf-ins-acts">
        {entry.standing
          ? <button type="button" className="pf-mini" title="收进归档：这一条不再生效，条目留在原处" onClick={() => props.onArchive(entry.id)}>归档</button>
          : <button type="button" className="pf-mini" title="让它重新生效" onClick={() => props.onRevive(entry.id)}>复原</button>}
        <button
          type="button"
          className="pf-mini"
          title="删掉：这一条连同正文一起从记录里拿走，放不回来"
          onClick={() => props.onDelete(entry)}
        >
          删除
        </button>
      </span>
      {extra?.note === undefined || extra.note === null ? null : (
        <div className="pf-ins-foot"><span className="pf-ins-note">{String(extra.note)}</span></div>
      )}
    </article>
  )
}

/** 这条线自己的三个数：一枚模态，从侧栏那一行行尾的「设置」打开。 */
function LineSettings(props: {
  readonly cycle: CycleReading | null
  readonly raw: { readonly policies?: Readonly<Record<string, unknown>> } | undefined
  readonly onClose: () => void
  readonly onWrite: (key: CyclePolicyKey, value: string) => void
}): React.ReactElement | null {
  const { cycle, raw } = props
  const modal = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') props.onClose() }
    modal.current?.focus()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props])
  if (cycle === null) return null
  const policies = raw?.policies ?? {}
  return (
    <div className="pf-modal" onClick={(event) => { if (event.target === event.currentTarget) props.onClose() }}>
      <div className="pf-modal-panel" role="dialog" aria-modal="true" aria-labelledby="line-modal-name" ref={modal} tabIndex={-1}>
        <div className="pf-modal-head">
          <span className="pf-modal-name" id="line-modal-name" title={cycle.id}>{cycle.id}</span>
          <button type="button" className="pf-mini" onClick={props.onClose}>关闭</button>
        </div>
        <div className="pf-fold">
          <div className="pf-set">
            {POLICY_ROWS.map((row) => (
              <PolicyRow
                key={row.key}
                row={row}
                value={policies[row.key]}
                onWrite={(value) => props.onWrite(row.key, value)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function PolicyRow(props: {
  readonly row: { readonly key: CyclePolicyKey; readonly name: string; readonly note: string }
  readonly value: unknown
  readonly onWrite: (value: string) => void
}): React.ReactElement {
  const { row } = props
  const current = typeof props.value === 'number' ? props.value : null
  const [text, setText] = React.useState(current === null ? '' : String(current))
  /* 记录里那个数变了（写完再读回来、或从别处改了），框里就跟着换成新的那个。 */
  React.useEffect(() => {
    setText(current === null ? '' : String(current))
  }, [current])
  const noteId = `note-${row.key}`
  /* 落笔那一手：框里的字变成一个值，空的就是「这条线没立这一条」。失焦与回车上都算改完了——
   * 只认失焦的话，敲完字直接换一格看的人会以为已经写进去了。 */
  const commit = (): void => {
    const trimmed = text.trim()
    props.onWrite(trimmed.length === 0 ? 'off' : trimmed)
  }
  return (
    <div className="pf-setrow">
      <div className="pf-settext">
        <div className="pf-setlabel">{row.name}</div>
        <div className="pf-setcaption" id={noteId}>{row.note}</div>
      </div>
      <input
        className={`pf-numin${current === null ? ' is-unset' : ''}`}
        type="number"
        min={1}
        aria-label={row.name}
        aria-describedby={noteId}
        placeholder={current === null ? '未设置' : ''}
        value={text}
        title={`${row.key} = ${current === null ? 'off' : String(current)} · pf cycle policy ${row.key}`}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          commit()
        }}
      />
    </div>
  )
}

/** 删一条：原话照抄，点第二下才动手。 */
function DeleteConfirm(props: {
  readonly instruction: InstructionReading
  readonly said: string
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): React.ReactElement {
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') props.onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props])
  return (
    <div className="pf-modal" onClick={(event) => { if (event.target === event.currentTarget) props.onCancel() }}>
      <div className="pf-modal-panel" role="dialog" aria-modal="true" aria-labelledby="ins-del-name">
        <div className="pf-modal-head">
          <span className="pf-modal-name" id="ins-del-name">{'删除这一条'}</span>
          <button type="button" className="pf-mini" onClick={props.onCancel}>关闭</button>
        </div>
        <blockquote className="pf-del-said">{props.said}</blockquote>
        <div className="pf-del-warn">
          <p>{'此次删除将移除该指令的存在痕迹。'}</p>
        </div>
        <div className="pf-modal-acts">
          <button type="button" className="pf-btn" onClick={props.onCancel}>取消</button>
          <button type="button" className="pf-btn" onClick={props.onConfirm}>删除</button>
        </div>
      </div>
    </div>
  )
}

/** 写面那三个动作的名字，仅供调用方对着读。 */
export const WRITE_VERBS: readonly WriteVerb[] = ['archive', 'revive', 'remove']

/** 那三个键的次序，面板与工具一致。 */
export const POLICY_ORDER: readonly CyclePolicyKey[] = POLICY_KEYS