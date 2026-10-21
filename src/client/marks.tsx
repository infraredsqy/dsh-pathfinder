/**
 * Reading widgets shared by the board, detail, and instruction-book cells: a state mark, a gate
 * hint, and a moment formatter.
 *
 * These readings exist only once: the state mark on cards and detail rows is the same one, and the
 * gate hint and time formatting are the same set — each cell just passes its own cell and moment.
 */
import * as React from 'react'
import type { DetailGroupKey, NodeReading } from '../model/index.ts'
import { clock, dayParts, duration } from '../model/index.ts'
import type { Translate } from './locale.ts'
import { useT } from './locale.ts'
import { dayLabel, gateWord } from './words.ts'

/** A card column's identity: the state mark is drawn by it. */
export type CardKind = 'shelved' | 'run' | 'next' | 'done'

/** The reading's moment rendered via moment; `--` when there is no moment. */
export function timeOf(t: Translate, moment: Date | null, at: Date): string {
  return moment === null ? '--' : `${dayLabel(t, dayParts(moment, at))} ${clock(moment)}`
}

/** The cell's gate: which word, since when. */
export function gateTitle(t: Translate, node: NodeReading, at: Date): string {
  if (node.gate === null) return ''
  const word = gateWord(t, node.gate)
  return node.gate.since === null ? word : `${word} · ${timeOf(t, node.gate.since, at)}`
}

/** State mark: gated cells always show the pause mark, the rest is drawn by column. */
export function StateMark(props: { readonly node: NodeReading; readonly kind: CardKind | DetailGroupKey; readonly at: Date }): React.ReactElement {
  /* The mark's hover text is the only thing it says, so the translator is taken here, where the word
   * is printed. */
  const t = useT()
  const { node } = props
  const loud = node.gate !== null && node.state !== 'todo'
  if (loud) {
    return (
      <span className="pf-state is-gate" title={gateTitle(t, node, props.at)}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M4.6 2.6v6.8M7.4 2.6v6.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </span>
    )
  }
  if (props.kind === 'run') {
    return <span className="pf-state is-run" title={node.elapsedSeconds === null ? t('state.running') : t('marks.running.elapsed', { elapsed: duration(node.elapsedSeconds) })} />
  }
  if (props.kind === 'next' || props.kind === 'wait' || props.kind === 'ready') {
    return <span className="pf-state is-next" title={t('state.next')} />
  }
  return (
    <span className="pf-state is-done" title={t('state.done')}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <path d="M2.5 6.5l2.4 2.4 4.6-5.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}
