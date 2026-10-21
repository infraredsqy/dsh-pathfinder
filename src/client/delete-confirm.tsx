/**
 * Delete confirmation modal: the instruction's original words are shown verbatim, and a second
 * click is required to act. The shell decides whether to act; this only renders those two buttons.
 */
import * as React from 'react'
import type { InstructionReading } from '../model/index.ts'
import { useT } from './locale.ts'
import { ModalShell } from './widgets.tsx'

/** Delete one entry: verbatim quote, second click to act. */
export function DeleteConfirm(props: {
  readonly instruction: InstructionReading
  readonly said: string
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): React.ReactElement {
  const t = useT()
  return (
    <ModalShell labelId="ins-del-name" name={t('notes.delete.name')} onClose={props.onCancel}>
      <blockquote className="pf-del-said">{props.said}</blockquote>
      <div className="pf-del-warn">
        <p>{t('notes.delete.warning')}</p>
      </div>
      <div className="pf-modal-acts">
        <button type="button" className="pf-btn" onClick={props.onCancel}>{t('common.cancel')}</button>
        <button type="button" className="pf-btn" onClick={props.onConfirm}>{t('common.delete')}</button>
      </div>
    </ModalShell>
  )
}
