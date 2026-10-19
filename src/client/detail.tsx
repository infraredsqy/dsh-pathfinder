/**
 * 主面板第二格：明细。左边一条线路侧栏（每条线一枚挑选钮、一枚「设置」），正文是选中那条线的
 * 节点清单，按五组分；侧栏与正文之间有一道可挪的缝。
 *
 * 挑哪条线、开哪一枚设置、缝挪到哪，都递回外壳（`onPickLine` / `onOpenSettings` /
 * `onSideWidth` / `onSideCommit`）；写回设置文档那一手在外壳。
 */
import * as React from 'react'
import type { CycleReading, DetailGroupKey, NodeReading, ProjectReading } from '../model/index.ts'
import { nodesOf } from '../model/index.ts'
import { clampSide, SIDE_DEFAULT, SIDE_MAX, SIDE_MIN } from './prefs.ts'
import { NOT_ENABLED } from './constants.ts'
import { nodeName, nodeHover } from './nodes.ts'
import { Grip } from './widgets.tsx'
import { gateTitle, StateMark } from './marks.tsx'
import { DepsChip } from './field.tsx'

/** 明细那五组，顺序就是读者遇到它们的顺序。 */
interface Group {
  readonly key: DetailGroupKey
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

/** 键盘挪明细那道缝时一步走多远；按住 shift 走两步。 */
const SPLIT_STEP = 16

/**
 * 明细那一格的整格版面：线路侧栏、那道缝与正文。
 * @param props - 露不露面、这一格收不收成一句话、记录里那几条线与挑中的那条、那一刻的读数、
 *   缝的宽窄与它的两下去处，以及挑线与开设置那两下的去处。
 */
export function DetailPane(props: {
  readonly active: boolean
  readonly noNodes: boolean
  readonly cycles: readonly CycleReading[]
  readonly picked: CycleReading | null
  readonly project: ProjectReading | null
  readonly sideWidth: number
  readonly onSideWidth: (px: number) => void
  readonly onSideCommit: (px: number) => void
  readonly onPickLine: (id: string) => void
  readonly onOpenSettings: (id: string) => void
}): React.ReactElement {
  return (
    <div
      className="pf-pane"
      id="pane-detail"
      role="tabpanel"
      aria-labelledby="tab-detail"
      data-fill=""
      hidden={!props.active}
    >
      {props.noNodes ? <p className="pf-innone">{NOT_ENABLED}</p> : (
      <div className="pf-detail" style={{ ['--pf-side-w' as string]: `${props.sideWidth}px` }}>
        <div className="pf-lineside" role="group" aria-label="线路">
          {props.cycles.map((cycle) => (
            <div className="pf-lineitem" key={cycle.id}>
              <button
                type="button"
                className="pf-linepick"
                aria-current={cycle.id === props.picked?.id}
                aria-label={`${cycle.id} · ${stateWord(cycle)}`}
                onClick={() => props.onPickLine(cycle.id)}
              >
                <LineMark cycle={cycle} />
                <span className="pf-cycle">{cycle.id}</span>
              </button>
              <button
                type="button"
                className="pf-mini"
                aria-label={`${cycle.id} 的设置`}
                onClick={() => props.onOpenSettings(cycle.id)}
              >
                设置
              </button>
            </div>
          ))}
        </div>
        {/* 侧栏与正文之间那道缝：单边挪 Δ，量的是这一列的宽度。 */}
        <Grip
          id="detail-split"
          label="调整线路侧栏的宽度"
          value={props.sideWidth}
          min={SIDE_MIN}
          max={SIDE_MAX}
          clamp={clampSide}
          step={SPLIT_STEP}
          onChange={props.onSideWidth}
          onCommit={props.onSideCommit}
          resetTo={SIDE_DEFAULT}
        />
        <div className="pf-linemain">
          <div className="pf-scroll" role="region" aria-label="明细" tabIndex={0}>
            {props.picked === null ? null : <DetailList cycle={props.picked} project={props.project as ProjectReading} />}
          </div>
        </div>
      </div>
      )}
    </div>
  )
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

/** 明细：选中那条线的节点清单，按五组分。 */
function DetailList(props: { readonly cycle: CycleReading; readonly project: ProjectReading }): React.ReactElement {
  const { cycle, project } = props
  const at = project.at
  return (
    <React.Fragment>
      {GROUPS.map((group) => {
        const list = nodesOf(group.key, cycle, project)
        if (list.length === 0) return null
        return <DetailGroup key={group.key} group={group} nodes={list} at={at} />
      })}
    </React.Fragment>
  )
}

/** 一组的组头与它下面的行。 */
function DetailGroup(props: { readonly group: Group; readonly nodes: readonly NodeReading[]; readonly at: Date }): React.ReactElement {
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
        <div className={`pf-row ${group.cls}`} key={node.id} data-id={node.id} title={gateTitle(node, props.at)}>
          <StateMark node={node} kind={group.key} at={props.at} />
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
