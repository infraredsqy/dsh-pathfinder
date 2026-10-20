/**
 * The first pane of the main panel: the board. Three columns of cards — running (gated ones on
 * top), just completed, and entering next — plus a segmented row for "cards per column".
 *
 * The reading and the moment come in from here; where a card goes (`go`) is prepared by the shell;
 * how many cards a column holds is measured by the shell and passed in (`cap`). This pane computes
 * no readings and measures no layout itself.
 */
import * as React from 'react'
import type { NodeReading, ProjectReading } from '../model/index.ts'
import { duration, elapsedSince } from '../model/index.ts'
import type { InfoLevel } from './prefs.ts'
import { INFO_LABELS } from './prefs.ts'
import { NOT_ENABLED } from './constants.ts'
import { nodeName, nodeHover } from './nodes.ts'
import { DepsChip } from './field.tsx'
import { StateMark, timeOf, type CardKind } from './marks.tsx'

/**
 * The full layout of the board pane: column heads, the segmented buttons, and the three columns.
 * @param props - Visibility, whether to collapse to one sentence, the reading at this moment, cards
 *   per column with its level, where cards go, the mount point of the three-column row (the shell
 *   looks here when measuring the full mode), and where the segmented buttons go.
 */
export function BoardPane(props: {
  readonly active: boolean
  readonly noNodes: boolean
  readonly project: ProjectReading | null
  readonly info: InfoLevel
  readonly cap: number
  readonly go: CardGo | null
  readonly colsRef: React.Ref<HTMLDivElement>
  readonly onPickInfo: (level: InfoLevel) => void
}): React.ReactElement {
  return (
    <section
      className="pf-pane pf-board"
      id="pane-now"
      role="tabpanel"
      aria-labelledby="tab-now"
      hidden={!props.active}
    >
      {props.noNodes ? <p className="pf-innone">{NOT_ENABLED}</p> : (
        <React.Fragment>
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
                    aria-pressed={level === props.info}
                    onClick={() => props.onPickInfo(level)}
                  >
                    {INFO_LABELS[level]}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="pf-cols" id="cols" ref={props.colsRef}>
            {props.project === null ? null : <BoardColumns project={props.project} cap={props.cap} go={props.go} />}
          </div>
        </React.Fragment>
      )}
    </section>
  )
}

/**
 * The three board columns: running (gated ones on top), just completed, and entering next.
 */
function BoardColumns(props: { readonly project: ProjectReading; readonly cap: number; readonly go: CardGo | null }): React.ReactElement {
  const { columns } = props.project
  const at = props.project.at
  const first = gatesFirst(columns.shelved, 'shelved', props.go).concat(gatesFirst(columns.running, 'run', props.go))
  return (
    <React.Fragment>
      <Column items={first} cap={props.cap} go={props.go} at={at} />
      <Column items={gatesFirst(columns.completed, 'done', props.go)} cap={props.cap} go={props.go} at={at} />
      <Column items={gatesFirst(columns.ready, 'next', props.go)} cap={props.cap} go={props.go} at={at} />
    </React.Fragment>
  )
}

/** Waiters first: gated cells go to the front, the rest keep the record's order. Each card's destination is settled along the way. */
function gatesFirst(list: readonly NodeReading[], kind: CardKind, go: CardGo | null): readonly Paired[] {
  return list
    .map((node) => ({ node, kind, target: go === null ? null : go.targetOf(node) }))
    .slice()
    .sort((left, right) => (left.node.gate === null ? 1 : 0) - (right.node.gate === null ? 1 : 0))
}

/** One card together with its reading at this moment: `target` is the session a click goes to, `null` when there is nowhere to go. */
interface Paired {
  readonly node: NodeReading
  readonly kind: CardKind
  readonly target: string | null
}

export interface CardGo {
  targetOf(node: NodeReading): string | null
  open(target: string): void
}

/** A column of cards: a column without a single card prints nothing beneath it. */
function Column(props: { readonly items: readonly Paired[]; readonly cap: number; readonly go: CardGo | null; readonly at: Date }): React.ReactElement {
  return (
    <section className="pf-col">
      {props.items.slice(0, props.cap).map((item) => <Card key={`${item.kind}:${item.node.id}`} {...item} go={props.go} at={props.at} />)}
    </section>
  )
}

/**
 * One card.
 *
 * When the record carries this cell's session and that session is on this machine right now,
 * clicking it switches to that session: the card carries the two affordances (pointer cursor,
 * hover-and-hold raises the outline a step), and Enter / Space on the keyboard equal one click.
 *
 * When the record names no session, or that session is not on this machine, the cell has nowhere to
 * go here: the card still sits there, just without a clickable look. No explanation is printed on
 * screen — the card itself can say that its destination is gone.
 */
function Card(props: Paired & { readonly go: CardGo | null; readonly at: Date }): React.ReactElement {
  const { node, kind, target, go, at } = props
  const cls = kind === 'shelved' ? 'shelved' : kind === 'run' ? 'run' : kind === 'next' ? 'next' : 'done'
  const loud = node.gate !== null && node.state !== 'todo'
  /* The destination is prepared in two halves: when there is none, that `null` keeps the whole batch of attributes below from landing. */
  const jump = target === null || go === null ? null : { target, open: go.open }
  return (
    <article
      className={`pf-card is-${cls}${loud ? ' is-gate' : ''}${jump === null ? ' is-inert' : ''}`}
      data-id={node.id}
      {...(jump === null ? {} : {
        role: 'button',
        tabIndex: 0,
        /* The name carries the cell's identity: with a dozen cards on one screen, screen-reader
         * users cannot tell identical names apart; the identity is the 8-char handle from the
         * hover text, sourced from the same sentence as the line on the card. */
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
        <StateMark node={node} kind={kind} at={at} />
        {node.gate === null ? null : (
          <span className={`pf-gate${loud ? '' : ' is-quiet'}`}>{node.gate.word}</span>
        )}
        {kind === 'shelved'
          ? <span className={`pf-elapsed${node.parkedSince === null ? ' is-unknown' : ''}`}><span className="pf-num">{durationOf(node.parkedSince, at)}</span></span>
          : kind === 'run'
            ? <span className={`pf-elapsed${node.elapsedSeconds === null ? ' is-unknown' : ''}`}><span className="pf-num">{duration(node.elapsedSeconds)}</span></span>
            : kind === 'next'
              ? <DepsChip node={node} />
              : <span className="pf-card-time pf-num">{timeOf(node.completedAt, at)}</span>}
      </div>
    </article>
  )
}

function durationOf(moment: Date | null, at: Date): string {
  return moment === null ? '--' : elapsedSince(moment, at)
}
