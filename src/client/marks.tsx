/**
 * 看板、明细、指令簿三格共用的读法小构件：一枚状态标、一句闸的提示、一个时刻的印法。
 *
 * 这些读法只此一份：卡上与明细行上的状态标是同一枚，闸的提示与时刻的印法也同一套——
 * 各格只递自己那一格与那一刻。
 */
import * as React from 'react'
import type { DetailGroupKey, NodeReading } from '../model/index.ts'
import { clock, dayLabel, duration } from '../model/index.ts'

/** 一列卡的身份：状态标按它画。 */
export type CardKind = 'shelved' | 'run' | 'next' | 'done'

/** 读数里那一刻到 moment 的样子；没有那一刻就是 `--`。 */
export function timeOf(moment: Date | null, at: Date): string {
  return moment === null ? '--' : `${dayLabel(moment, at)} ${clock(moment)}`
}

/** 那一格的闸：哪一个词、哪一刻。 */
export function gateTitle(node: NodeReading, at: Date): string {
  if (node.gate === null) return ''
  return node.gate.since === null ? node.gate.word : `${node.gate.word} · ${timeOf(node.gate.since, at)}`
}

/** 状态标：有闸的格一律是那枚暂停，其余按它在哪一列画。 */
export function StateMark(props: { readonly node: NodeReading; readonly kind: CardKind | DetailGroupKey; readonly at: Date }): React.ReactElement {
  const { node } = props
  const loud = node.gate !== null && node.state !== 'todo'
  if (loud) {
    return (
      <span className="pf-state is-gate" title={gateTitle(node, props.at)}>
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
