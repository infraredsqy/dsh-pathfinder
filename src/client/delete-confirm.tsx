/**
 * Delete confirmation modal: the instruction's original words are shown verbatim, and a second
 * click is required to act. The shell decides whether to act; this only renders those two buttons.
 */
import * as React from 'react'
import type { InstructionReading } from '../model/index.ts'
import { ModalShell } from './widgets.tsx'

/** Delete one entry: verbatim quote, second click to act. */
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
