/**
 * 主面板第一格：看板。三列卡——进行中（等待处理的排上头）、刚完成、即将进线——加一排
 * 「每列几张卡」的分段钮。
 *
 * 读数与那一刻从这里进来，卡的去处（`go`）由外壳备好；一列摆几张由外壳量好了递进来（`cap`），
 * 这一格自己不算读数、也不量地界。
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
 * 看板那一格的整格版面：栏头、分段钮与三列。
 * @param props - 露不露面、这一格收不收成一句话、那一刻的读数、每列几张卡与它的档、
 *   卡的去处、三列那一排的挂点（外壳量铺满时往这看），以及分段钮那一下的去处。
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
 * 三列看板：进行中（等待处理的排在上头）、刚完成、即将进线。
 * @param props - 那一刻的读数、每列几张卡，以及卡上那一下的去处。
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

export interface CardGo {
  targetOf(node: NodeReading): string | null
  open(target: string): void
}

/** 一列卡片：一张卡都没有的列，底下什么也不印。 */
function Column(props: { readonly items: readonly Paired[]; readonly cap: number; readonly go: CardGo | null; readonly at: Date }): React.ReactElement {
  return (
    <section className="pf-col">
      {props.items.slice(0, props.cap).map((item) => <Card key={`${item.kind}:${item.node.id}`} {...item} go={props.go} at={props.at} />)}
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
function Card(props: Paired & { readonly go: CardGo | null; readonly at: Date }): React.ReactElement {
  const { node, kind, target, go, at } = props
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
