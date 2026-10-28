/**
 * Reading widgets shared by the detail rows, the instruction book, and the map's cards: a state mark
 * and a dependency line.
 *
 * These readings exist only once: the state mark on the map's cards and on detail rows is the same
 * one, and the dependency line wears the same face — each cell just passes its own cell and moment.
 * The words themselves (a gate's hint, a moment's day, a line's state) are spelled in `words.ts`.
 */
import * as React from 'react'
import type { NodeReading } from '../model/index.ts'
import { bucketOf, duration, readDeps } from '../model/index.ts'
import type { Translate } from './locale.ts'
import { useT } from './locale.ts'
import { depsSentence, gateTitle } from './words.ts'

/**
 * What the running ring says: how long this step has been open, or just "in hand" when the line
 * claimed a step that has not opened yet. One sentence, because the ring is one drawing — the
 * detail rows and the map's own card both stand it up.
 */
export function runningTitle(t: Translate, node: NodeReading): string {
  return node.elapsedSeconds === null ? t('state.running') : t('marks.running.elapsed', { elapsed: duration(node.elapsedSeconds) })
}

/**
 * State mark: the model's one bucket, drawn. A card that wants a person (a gate, or the shelved
 * verdict, which is its own gate) takes the pause mark; the line's hold takes the spinner; the
 * card's own state draws the rest. Nothing here judges the record again.
 */
export function StateMark(props: { readonly node: NodeReading; readonly at: Date }): React.ReactElement {
  /* The mark's hover text is the only thing it says, so the translator is taken here, where the word
   * is printed. */
  const t = useT()
  const { node } = props
  const bucket = bucketOf(node)
  if (bucket === 'gate' || bucket === 'shelved') {
    return (
      <span className="pf-state is-gate" title={gateTitle(t, node, props.at)}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M4.6 2.6v6.8M7.4 2.6v6.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </span>
    )
  }
  if (bucket === 'run') {
    return <span className="pf-state is-run" title={runningTitle(t, node)} />
  }
  if (bucket === 'todo') {
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

/**
 * The dependency line, wearing the same face in every view: ready to start, or N prerequisite nodes.
 *
 * Whether a cell owes an answer at all is the reading's decision (`readDeps`); how that answer is
 * worded is this panel's (`depsSentence`). The sentence arrives already split around its number, so
 * the number gets its own mark styling (monospace, brighter) without cutting a finished sentence in
 * two — a language is free to put the number first, and one of them does.
 */
export function DepsChip(props: { readonly node: NodeReading }): React.ReactElement | null {
  const t = useT()
  const deps = readDeps(props.node)
  if (deps === null) return null
  const said = depsSentence(t, deps)
  return (
    <span className={`pf-deps${deps.ready ? ' is-ready' : ''}`}>
      {said.head}
      {said.count === null ? null : <b className="pf-num">{String(said.count)}</b>}
      {said.tail}
    </span>
  )
}
