/**
 * 删除确认模态：指令的原话照抄摆出来，点第二下才动手。动不动手由外壳说，这里只出那两下。
 */
import * as React from 'react'
import type { InstructionReading } from '../model/index.ts'
import { ModalShell } from './widgets.tsx'

/** 删一条：原话照抄，点第二下才动手。 */
export function DeleteConfirm(props: {
  readonly instruction: InstructionReading
  readonly said: string
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): React.ReactElement {
  return (
    <ModalShell labelId="ins-del-name" name="删除这一条" onClose={props.onCancel}>
      <blockquote className="pf-del-said">{props.said}</blockquote>
      <div className="pf-del-warn">
        <p>{'此次删除将移除该指令的存在痕迹。'}</p>
      </div>
      <div className="pf-modal-acts">
        <button type="button" className="pf-btn" onClick={props.onCancel}>取消</button>
        <button type="button" className="pf-btn" onClick={props.onConfirm}>删除</button>
      </div>
    </ModalShell>
  )
}
