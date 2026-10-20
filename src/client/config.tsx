/**
 * The sixth pane of the main panel: this workspace's own project settings. One key per row, one
 * control per row, with a small tag at the row's end saying which layer the value lives on.
 *
 * Both reading and writing go through the tool: which keys exist, the valid values, and "which
 * layer a value comes from" are all printed by the tool; row order follows the reading, and writes
 * land on this project's layer. This layer makes no second set of judgments — the tool says whether
 * keys and values are valid. No optimistic updates on the page: controls always show the most
 * recently read-back reading; a change is written, then read again, and when the tool refuses, the
 * control returns to its place on its own.
 */
import * as React from 'react'
import type { ConfigEntry, PathfinderConfigReading } from '../host/project-config.ts'
import {
  clampConfigWidth,
  CONFIG_WIDTH,
  CONFIG_WIDTH_BIG,
  CONFIG_WIDTH_MAX,
  CONFIG_WIDTH_MIN,
  CONFIG_WIDTH_STEP,
  configRowsOf,
  LAYER_WORDS,
  pickState,
  type ConfigRow,
} from './config-rows.ts'
import { NOT_ENABLED } from './constants.ts'
import type { PanelPort } from './data.ts'
import { CommitNumberInput, Grip } from './widgets.tsx'

const READ_FAILED = '无法读取该工作区的项目设置。'

const WRITE_FAILED = '这次写入没有生效。'

const SIDES: readonly (readonly [string, boolean])[] = [['开', true], ['关', false]]

type Load =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ok'; readonly reading: PathfinderConfigReading }
  | { readonly phase: 'failed'; readonly message: string }

export interface ConfigPaneProps {
  readonly port: PanelPort
  /** Session identity: the workspace file gateway resolves paths by it. */
  readonly sessionId: string
  /** Which workspace to read and write: the root picked at the top of the panel; an empty string means this session's own. */
  readonly workspaceRoot: string
  /** This workspace has no node record yet: the pane collapses to one sentence and the read command is not even started. */
  readonly noNodes: boolean
  /** Whether this pane is visible right now: the read happens only on the pass it becomes visible. */
  readonly active: boolean
  /** The note line at the bottom of the panel; `null` means "the last sentence was mine, take it back". */
  readonly onNote: (text: string | null) => void
}

export function ConfigPane(props: ConfigPaneProps): React.ReactElement {
  const { port, sessionId, workspaceRoot, noNodes, active } = props
  const [load, setLoad] = React.useState<Load>({ phase: 'loading' })
  const [tick, setTick] = React.useState(0)
  const [width, setWidth] = React.useState(CONFIG_WIDTH)
  /* Who left the last sentence on the note line: a failed read's sentence is retracted by the next
     successful read; a failed write's by the next successful write. A sentence left by other parts
     of the panel is not touched by this pane. */
  const said = React.useRef<'read' | 'write' | null>(null)
  const speak = React.useRef(props.onNote)
  React.useEffect(() => { speak.current = props.onNote }, [props.onNote])
  const note = React.useCallback((text: string | null): void => {
    speak.current(text)
  }, [])

  /* Read only while this pane is actually visible: one read costs a tool command, and panes nobody
   * is looking at need not spend it.
   *
   * A successful read retracts only the previous failed-read sentence; the failed-write sentence is
   * the write's own business — otherwise every refused write would be wiped away on the spot by the
   * re-read that follows, and the reader would see nothing. */
  React.useEffect(() => {
    if (noNodes || !active || sessionId.length === 0) return undefined
    let live = true
    port.readConfig(sessionId, workspaceRoot).then(
      (reading) => {
        if (!live) return
        setLoad({ phase: 'ok', reading })
        if (reading.ok) {
          if (said.current === 'read') {
            said.current = null
            note(null)
          }
        } else {
          said.current = 'read'
          note(reading.text.length > 0 ? reading.text : READ_FAILED)
        }
      },
      (error: unknown) => {
        if (!live) return
        setLoad({ phase: 'failed', message: messageOf(error) })
      },
    )
    return () => { live = false }
  }, [noNodes, active, sessionId, workspaceRoot, port, tick, note])

  /* One write: the tool's word is final, then read again — what controls show always follows the
     re-read copy. No key filtering: unregistered keys are passed through as well, and when the
     tool does not recognize one, its message lands verbatim on the note line. */
  const send = React.useCallback((key: string, next: string): void => {
    const after = (): void => { setTick((round) => round + 1) }
    port.setConfig(sessionId, workspaceRoot, key, next).then(
      (outcome) => {
        said.current = outcome.ok ? null : 'write'
        note(outcome.ok ? null : (outcome.text.length > 0 ? outcome.text : WRITE_FAILED))
        after()
      },
      (error: unknown) => {
        said.current = 'write'
        note(messageOf(error))
        after()
      },
    )
  }, [port, sessionId, workspaceRoot, note])

  const reading = load.phase === 'ok' ? load.reading : null

  return (
    <div
      className="pf-pane"
      id="pane-config"
      role="tabpanel"
      aria-labelledby="tab-config"
      aria-label="设置"
      data-fill=""
      hidden={!active}
    >
      {noNodes ? <p className="pf-innone">{NOT_ENABLED}</p> : (
      <div className="pf-configwrap" style={{ ['--pf-config-w' as string]: `${String(width)}px` }}>
        <ConfigGrip side="left" value={width} onChange={setWidth} />
        <div className="pf-scroll" role="region" aria-label="设置" tabIndex={0}>
          {reading === null ? null : (
            <div className="pf-config">
              {configRowsOf(reading.entries).map((row) => (
                <Row
                  key={row.key}
                  row={row}
                  entry={reading.entries[row.key]}
                  revision={tick}
                  onWrite={(next) => send(row.key, next)}
                />
              ))}
            </div>
          )}
        </div>
        <ConfigGrip side="right" value={width} onChange={setWidth} />
      </div>
      )}
    </div>
  )
}

function Row(props: {
  readonly row: ConfigRow
  readonly entry: ConfigEntry | undefined
  readonly revision: number
  readonly onWrite: (value: string) => void
}): React.ReactElement {
  const { row, entry } = props
  const noteId = `cfg-note-${row.key}`
  return (
    <div className="pf-setrow" data-key={row.key}>
      <div className="pf-settext">
        <div className="pf-setlabel">{row.name}</div>
        <div className="pf-setcaption" id={noteId}>{row.caption}</div>
      </div>
      {row.kind === 'pick'
        ? <Pick row={row} entry={entry} noteId={noteId} onWrite={props.onWrite} />
        : row.kind === 'num'
          ? <NumberBox row={row} entry={entry} noteId={noteId} revision={props.revision} onWrite={props.onWrite} />
          : row.kind === 'toggle'
            ? <Toggle row={row} entry={entry} noteId={noteId} onWrite={props.onWrite} />
            : <TextBox row={row} entry={entry} noteId={noteId} revision={props.revision} onWrite={props.onWrite} />}
      {entry === undefined || entry.layer === null
        ? null
        : <span className="pf-tag pf-vlayer" data-layer={entry.layer}>{LAYER_WORDS[entry.layer]}</span>}
    </div>
  )
}

/** The dropdown: when the reading has no value for the key, no option is selected (left blank) rather than picking the first. */
function Pick(props: {
  readonly row: ConfigRow
  readonly entry: ConfigEntry | undefined
  readonly noteId: string
  readonly onWrite: (value: string) => void
}): React.ReactElement {
  const pick = pickState(props.entry, props.row.options ?? [])
  return (
    <span className="pf-pick">
      <select
        aria-label={props.row.name}
        aria-describedby={props.noteId}
        value={pick.value}
        onChange={(event) => props.onWrite(event.target.value)}
      >
        {/* No value: leave an empty slot for it to land on, so the browser does not pick the first option; this option is not offered for picking. */}
        {pick.value === '' ? <option value="" hidden /> : null}
        {(props.row.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
        {/* A value in the reading but not in the candidate table: laid out as its own option, keeping the view consistent with the record. */}
        {pick.extra === null ? null : <option value={pick.extra}>{pick.extra}</option>}
      </select>
    </span>
  )
}

/**
 * The number control: writes only on commit (Enter or blur); keystrokes in between live only in the box.
 *
 * `revision` flips on every write, and on each flip the box swaps to the re-read copy — a refused
 * number does not squat in the box.
 */
function NumberBox(props: {
  readonly row: ConfigRow
  readonly entry: ConfigEntry | undefined
  readonly noteId: string
  readonly revision: number
  readonly onWrite: (value: string) => void
}): React.ReactElement {
  const held = props.entry?.value ?? ''
  return (
    <CommitNumberInput
      held={held}
      unset={props.entry === undefined}
      label={props.row.name}
      describedBy={props.noteId}
      revision={props.revision}
      onCommit={(typed) => {
        if (typed.length === 0 || typed === held) return
        props.onWrite(typed)
      }}
    />
  )
}

/**
 * The text control (for unregistered keys): writes only on commit (Enter or blur), keystrokes in
 * between live only in the box — the same rules as the number control. It yields only when a
 * reading arrives, so a refused word does not squat in the box. Every key that can reach this row
 * exists in the reading, so the box starts out holding the reading's value.
 */
function TextBox(props: {
  readonly row: ConfigRow
  readonly entry: ConfigEntry | undefined
  readonly noteId: string
  readonly revision: number
  readonly onWrite: (value: string) => void
}): React.ReactElement {
  const held = props.entry?.value ?? ''
  const [text, setText] = React.useState(held)
  React.useEffect(() => { setText(held) }, [held, props.revision])
  const commit = (): void => {
    const typed = text.trim()
    if (typed.length === 0 || typed === held) return
    props.onWrite(typed)
  }
  return (
    <input
      className="pf-numin"
      type="text"
      spellCheck={false}
      aria-label={props.row.name}
      aria-describedby={props.noteId}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        commit()
      }}
    />
  )
}

/** The on / off control: two buttons, the pressed one being the current value; neither lights when the record does not carry the key. */
function Toggle(props: {
  readonly row: ConfigRow
  readonly entry: ConfigEntry | undefined
  readonly noteId: string
  readonly onWrite: (value: string) => void
}): React.ReactElement {
  const on = props.entry === undefined ? null : props.entry.value === 'on'
  return (
    <div className="pf-seg" role="group" aria-label={props.row.name}>
      {SIDES.map(([word, flag]) => (
        <button
          key={word}
          type="button"
          className="pf-segbtn"
          aria-pressed={on === flag}
          aria-describedby={props.noteId}
          onClick={() => props.onWrite(flag ? 'on' : 'off')}
        >
          {word}
        </button>
      ))}
    </div>
  )
}

/**
 * The pair of column-edge grips: drag, keyboard, and double-click all live on the shared Grip; this
 * only states how the pair is measured — one edge moving Δ changes the width by 2Δ with the center
 * fixed, and the pointer stays grabbed on the column edge. The left grip's `out` is -1: the arrow
 * keys move that side's edge.
 */
function ConfigGrip(props: {
  readonly side: 'left' | 'right'
  readonly value: number
  readonly onChange: (px: number) => void
}): React.ReactElement {
  const { side, value, onChange } = props
  const out = side === 'left' ? -1 : 1
  return (
    <Grip
      label="调整设置那一列的宽度"
      value={value}
      min={CONFIG_WIDTH_MIN}
      max={CONFIG_WIDTH_MAX}
      clamp={clampConfigWidth}
      dragGain={out * 2}
      keyGain={out}
      step={CONFIG_WIDTH_STEP}
      bigStep={CONFIG_WIDTH_BIG}
      onChange={onChange}
      resetTo={CONFIG_WIDTH}
      attributes={{ 'data-side': side, 'data-width': String(value) }}
    />
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}