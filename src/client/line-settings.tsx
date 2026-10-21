/**
 * Line settings modal: a line's own three numbers, opened from the "Settings" control at the end
 * of the detail sidebar row.
 *
 * Writing lives in the shell: each number is handed back through `onWrite`; this modal never
 * touches the gateway itself.
 */
import * as React from 'react'
import type { CyclePolicyKey } from '../host/gateway.ts'
import type { CycleReading } from '../model/index.ts'
import { useT } from './locale.ts'
import type { WordKey } from './locales/index.ts'
import { CommitNumberInput, ModalShell } from './widgets.tsx'

/**
 * One row of the table below: which policy key, and the two dictionary keys saying what it is.
 *
 * A key, not a word: the modal is drawn in whichever language the reader is looking at, and both
 * cells ask the translator for the wording at draw time.
 */
interface PolicyRowDef {
  readonly key: CyclePolicyKey
  readonly nameKey: WordKey
  readonly noteKey: WordKey
}

/** A line's own three numbers, one per row; names and notes follow the blueprint. */
const POLICY_ROWS: readonly PolicyRowDef[] = [
  {
    key: 'parallel',
    nameKey: 'line.row.parallel.name',
    noteKey: 'line.row.parallel.note',
  },
  {
    key: 'test_seconds_limit',
    nameKey: 'line.row.test_seconds_limit.name',
    noteKey: 'line.row.test_seconds_limit.note',
  },
  {
    key: 'issue_pool_weight_limit',
    nameKey: 'line.row.issue_pool_weight_limit.name',
    noteKey: 'line.row.issue_pool_weight_limit.note',
  },
]

/** The line's own three numbers: one modal, opened from "Settings" at the end of the sidebar row. */
export function LineSettings(props: {
  readonly cycle: CycleReading | null
  readonly raw: { readonly policies?: Readonly<Record<string, unknown>> } | undefined
  readonly onClose: () => void
  readonly onWrite: (key: CyclePolicyKey, value: string) => void
}): React.ReactElement | null {
  const { cycle, raw } = props
  if (cycle === null) return null
  const policies = raw?.policies ?? {}
  return (
    <ModalShell labelId="line-modal-name" name={cycle.id} nameTitle={cycle.id} onClose={props.onClose}>
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
    </ModalShell>
  )
}

function PolicyRow(props: {
  readonly row: PolicyRowDef
  readonly value: unknown
  readonly onWrite: (value: string) => void
}): React.ReactElement {
  const t = useT()
  const { row } = props
  const current = typeof props.value === 'number' ? props.value : null
  const noteId = `note-${row.key}`
  const name = t(row.nameKey)
  return (
    <div className="pf-setrow">
      <div className="pf-settext">
        <div className="pf-setlabel">{name}</div>
        <div className="pf-setcaption" id={noteId}>{t(row.noteKey)}</div>
      </div>
      <CommitNumberInput
        held={current === null ? '' : String(current)}
        unset={current === null}
        label={name}
        describedBy={noteId}
        title={`${row.key} = ${current === null ? 'off' : String(current)} · pf cycle policy ${row.key}`}
        onCommit={(typed) => {
          /* The commit action: the box's text becomes a value; empty means "this line has no such
           * policy". Both blur and Enter count as a completed edit — if only blur counted, someone
           * typing and then tabbing to the next box would assume it was already saved. */
          props.onWrite(typed.length === 0 ? 'off' : typed)
        }}
      />
    </div>
  )
}
