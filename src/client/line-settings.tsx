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
import { CommitNumberInput, ModalShell } from './widgets.tsx'

/** A line's own three numbers, one per row; names and notes follow the blueprint. */
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
    note: '问题池里不同等级的问题，按记录里写明的重量表折算出的总和上限阈值；超过该阈值会自动加入解决问题的节点。',
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
  readonly row: { readonly key: CyclePolicyKey; readonly name: string; readonly note: string }
  readonly value: unknown
  readonly onWrite: (value: string) => void
}): React.ReactElement {
  const { row } = props
  const current = typeof props.value === 'number' ? props.value : null
  const noteId = `note-${row.key}`
  return (
    <div className="pf-setrow">
      <div className="pf-settext">
        <div className="pf-setlabel">{row.name}</div>
        <div className="pf-setcaption" id={noteId}>{row.note}</div>
      </div>
      <CommitNumberInput
        held={current === null ? '' : String(current)}
        unset={current === null}
        label={row.name}
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
