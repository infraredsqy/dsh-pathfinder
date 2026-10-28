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
import { NOT_ENABLED_WORD } from './constants.ts'
import { useT } from './locale.ts'
import type { WordKey } from './locales/index.ts'
import { gateTitle, gateWord, stateWord, unit } from './words.ts'
import { nodeName, nodeHover } from './nodes.ts'
import { Grip } from './widgets.tsx'
import { DepsChip, LineMark, StateMark } from './marks.tsx'

/** The five detail sections, in the order readers meet them. */
interface Group {
  readonly key: DetailGroupKey
  /** Which word heads this section, looked up when the header is drawn so the table knows no language. */
  readonly word: WordKey
  readonly cls: string
  readonly deps: boolean
}

/* The five sections always start expanded: this pane is called detail, and the rows are what the
 * reader came to see. The folding move survives, triggered by the reader. */
const GROUPS: readonly Group[] = [
  { key: 'shelved', word: 'state.shelved', cls: 'is-shelved', deps: false },
  { key: 'run', word: 'state.running', cls: 'is-running', deps: false },
  { key: 'ready', word: 'state.ready', cls: 'is-todo', deps: false },
  { key: 'wait', word: 'state.todo', cls: 'is-todo', deps: true },
  { key: 'done', word: 'state.done', cls: 'is-done', deps: false },
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
  const t = useT()
  return (
    <div
      className="pf-pane"
      id="pane-detail"
      role="tabpanel"
      aria-labelledby="tab-detail"
      data-fill=""
      hidden={!props.active}
    >
      {props.noNodes ? <p className="pf-innone">{t(NOT_ENABLED_WORD)}</p> : (
      <div className="pf-detail" style={{ ['--pf-side-w' as string]: `${props.sideWidth}px` }}>
        <div className="pf-lineside" role="group" aria-label={t('detail.lines.aria')}>
          {props.cycles.map((cycle) => (
            <div className="pf-lineitem" key={cycle.id}>
              <button
                type="button"
                className="pf-linepick"
                aria-current={cycle.id === props.picked?.id}
                aria-label={`${cycle.id} · ${stateWord(t, cycle)}`}
                onClick={() => props.onPickLine(cycle.id)}
              >
                <LineMark cycle={cycle} />
                <span className="pf-cycle">{cycle.id}</span>
              </button>
              <button
                type="button"
                className="pf-mini"
                aria-label={t('detail.line.settings.aria', { cycle: cycle.id })}
                onClick={() => props.onOpenSettings(cycle.id)}
              >
                {t('common.settings')}
              </button>
            </div>
          ))}
        </div>
        {/* The split between sidebar and body: one edge moving Δ measures this column's width. */}
        <Grip
          id="detail-split"
          label={t('detail.side-grip.aria')}
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
          <div className="pf-scroll" role="region" aria-label={t('view.detail')} tabIndex={0}>
            {props.picked === null ? null : <DetailList cycle={props.picked} project={props.project as ProjectReading} />}
          </div>
        </div>
      </div>
      )}
    </div>
  )
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
  const t = useT()
  const [folded, setFolded] = React.useState(false)
  return (
    <section className={`pf-sec${folded ? ' is-folded' : ''}`}>
      <button
        type="button"
        className="pf-rowhead"
        aria-expanded={!folded}
        onClick={() => setFolded((value) => !value)}
      >
        <span className="pf-rowhead-key">{t(group.word)}</span>
        {folded
          ? <span className="pf-rowhead-figs pf-rowcount"><b className="pf-num">{props.nodes.length}</b>{unit(t, 'detail.folded.cells.one', 'detail.folded.cells.other', props.nodes.length)}</span>
          : null}
      </button>
      {props.nodes.map((node) => (
        <div className={`pf-row ${group.cls}`} key={node.id} data-id={node.id} title={gateTitle(t, node, props.at)}>
          <StateMark node={node} at={props.at} />
          <span className="pf-rowtitle" title={nodeHover(node)}>{nodeName(node)}</span>
          <span className="pf-rowfigs">{group.deps ? <DepsChip node={node} /> : null}</span>
          {/* The section already says its own gate kind: a node gated that same way adds no second
              badge here. Both sides are the structured kind — a gate's kind against the section's. */}
          {node.gate !== null && node.gate.kind !== group.key
            ? <span className={`pf-gate pf-rowgate${node.state === 'todo' ? ' is-quiet' : ''}`}>{gateWord(t, node.gate)}</span>
            : null}
        </div>
      ))}
    </section>
  )
}
