/**
 * The second pane of the main panel: detail. A line sidebar on the left (each line with a pick
 * button and a "Settings" button), and the body is the picked line's node list grouped into five
 * sections; a movable split sits between sidebar and body.
 *
 * Picking a line, opening a line's settings, and moving the split are all handed back to the shell
 * (`onPickLine` / `onOpenSettings` / `onSideWidth` / `onSideCommit`); writing back to the settings
 * document is the shell's job.
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

/** The five detail sections, in the order readers meet them. */
interface Group {
  readonly key: DetailGroupKey
  readonly label: string
  readonly cls: string
  readonly deps: boolean
}

/* The five sections always start expanded: this pane is called detail, and the rows are what the
 * reader came to see. The folding move survives, triggered by the reader. */
const GROUPS: readonly Group[] = [
  { key: 'shelved', label: '等待处理', cls: 'is-shelved', deps: false },
  { key: 'run', label: '进行中', cls: 'is-running', deps: false },
  { key: 'ready', label: '可开工', cls: 'is-todo', deps: false },
  { key: 'wait', label: '未开始', cls: 'is-todo', deps: true },
  { key: 'done', label: '已交付', cls: 'is-done', deps: false },
]

/** How far one keyboard move of the detail split travels; Shift takes two steps. */
const SPLIT_STEP = 16

/**
 * The full layout of the detail pane: the line sidebar, the split, and the body.
 * @param props - Visibility, whether to collapse to one sentence, the record's lines with the
 *   picked one, the reading at this moment, the split width with its two write-backs, and where
 *   the pick-line and open-settings actions go.
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
        {/* The split between sidebar and body: one edge moving Δ measures this column's width. */}
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

/** A line's mark: parked and idle when stopped, spinning while running, drawn as blocked when it owes waiting nodes. */
function LineMark(props: { readonly cycle: CycleReading }): React.ReactElement {
  const { cycle } = props
  const cls = cycle.parked.length > 0 ? 'is-blocked' : cycle.inService ? 'is-run' : ''
  return <span className={`pf-linemark ${cls}`.trim()} title={stateWord(cycle)} />
}

function stateWord(cycle: CycleReading): string {
  if (cycle.parked.length > 0) return '阻塞'
  return cycle.inService ? '运行中' : '停止'
}

/** Detail: the picked line's node list, grouped into five sections. */
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

/** A section's header and the rows under it. */
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
