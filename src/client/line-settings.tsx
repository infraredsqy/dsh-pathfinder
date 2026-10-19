/**
 * 线路设置模态：一条线自己的三个数，从明细侧栏那一行行尾的「设置」打开。
 *
 * 写面在外壳：每个数落笔经 `onWrite` 递回去，这条模态自己不碰口子。
 */
import * as React from 'react'
import type { CyclePolicyKey } from '../host/gateway.ts'
import type { CycleReading } from '../model/index.ts'
import { CommitNumberInput, ModalShell } from './widgets.tsx'

/** 一条线自己那三个数，一个数一行；名字与那句话都照蓝本。 */
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

/** 这条线自己的三个数：一枚模态，从侧栏那一行行尾的「设置」打开。 */
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
          /* 落笔那一手：框里的字变成一个值，空的就是「这条线没立这一条」。失焦与回车上都算
           * 改完了——只认失焦的话，敲完字直接换一格看的人会以为已经写进去了。 */
          props.onWrite(typed.length === 0 ? 'off' : typed)
        }}
      />
    </div>
  )
}
