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
  rowWords,
  type ConfigRow,
} from './config-rows.ts'
import { NOT_ENABLED_WORD } from './constants.ts'
import type { PanelPort } from './data.ts'
import type { Failure } from './failure.ts'
import { failureOf } from './failure.ts'
import { useT } from './locale.ts'
import type { WordKey } from './locales/index.ts'
import { CommitNumberInput, Grip } from './widgets.tsx'

/** The two words of the on / off control, as keys; the pressed one states the value the tool holds. */
const SIDES: readonly (readonly [WordKey, boolean])[] = [['config.toggle.on', true], ['config.toggle.off', false]]

type Load =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ok'; readonly reading: PathfinderConfigReading }
  | { readonly phase: 'failed'; readonly failure: Failure }

/**
 * What this pane can leave on the note line under the panel.
 *
 * The shell owns that line and the words on it, so this pane hands over what it has and lets the
 * shell say it: the tool's own words, carried out verbatim when it spoke while succeeding, or a
 * refusal — a code, because which language the reader looks at is not known here. Mirrors the
 * shell's own note type.
 */
type Note =
  | { readonly kind: 'said'; readonly text: string }
  | { readonly kind: 'failure'; readonly failure: Failure }

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
  /** The note line at the bottom of the panel: what this pane has to say, or `null` to take back the last note it left. */
  readonly onNote: (note: Note | null) => void
}

export function ConfigPane(props: ConfigPaneProps): React.ReactElement {
  const { port, sessionId, workspaceRoot, noNodes, active } = props
  /* Every word this pane prints comes from here; the translator reads the active language at call
   * time, so a redraw after a language switch says the new one. */
  const t = useT()
  const [load, setLoad] = React.useState<Load>({ phase: 'loading' })
  const [tick, setTick] = React.useState(0)
  const [width, setWidth] = React.useState(CONFIG_WIDTH)
  /* Who left the last note on the note line: a failed read's note is retracted by the next
     successful read; a failed write's by the next successful write. A note left by other parts
     of the panel is not touched by this pane. */
  const said = React.useRef<'read' | 'write' | null>(null)
  const speak = React.useRef(props.onNote)
  React.useEffect(() => { speak.current = props.onNote }, [props.onNote])
  const note = React.useCallback((next: Note | null): void => {
    speak.current(next)
  }, [])

  /* Read only while this pane is actually visible: one read costs a tool command, and panes nobody
   * is looking at need not spend it.
   *
   * A successful read retracts only the previous failed-read note; the failed-write note is the
   * write's own business — otherwise every refused write would be wiped away on the spot by the
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
          /* The tool's run failed: why is a code, spelled by the shell when the note line is drawn.
           * A refusal carrying nothing at all still reads as "the settings could not be read". */
          note({ kind: 'failure', failure: reading.refusal ?? { code: 'config-unreadable' } })
        }
      },
      (error: unknown) => {
        if (!live) return
        setLoad({ phase: 'failed', failure: failureOf(error) })
      },
    )
    return () => { live = false }
  }, [noNodes, active, sessionId, workspaceRoot, port, tick, note])

  /* One write: the tool's word is final, then read again — what controls show always follows the
     re-read copy. No key filtering: unregistered keys are passed through as well, and when the
     tool does not recognize one, its refusal lands on the note line. */
  const send = React.useCallback((key: string, next: string): void => {
    const after = (): void => { setTick((round) => round + 1) }
    port.setConfig(sessionId, workspaceRoot, key, next).then(
      (outcome) => {
        said.current = outcome.ok ? null : 'write'
        /* Success carries the tool's own words when it said any; a refusal carries a code, which the
         * shell spells — not here, where the reader's language is unknown. */
        note(outcome.ok
          ? (outcome.text.length > 0 ? { kind: 'said', text: outcome.text } : null)
          : { kind: 'failure', failure: { code: outcome.code, ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}) } })
        after()
      },
      (error: unknown) => {
        said.current = 'write'
        note({ kind: 'failure', failure: failureOf(error) })
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
      aria-label={t('common.settings')}
      data-fill=""
      hidden={!active}
    >
      {noNodes ? <p className="pf-innone">{t(NOT_ENABLED_WORD)}</p> : (
      <div className="pf-configwrap" style={{ ['--pf-config-w' as string]: `${String(width)}px` }}>
        <ConfigGrip side="left" value={width} onChange={setWidth} />
        <div className="pf-scroll" role="region" aria-label={t('common.settings')} tabIndex={0}>
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
  const t = useT()
  const { row, entry } = props
  const noteId = `cfg-note-${row.key}`
  const words = rowWords(t, row)
  return (
    <div className="pf-setrow" data-key={row.key}>
      <div className="pf-settext">
        <div className="pf-setlabel">{words.name}</div>
        <div className="pf-setcaption" id={noteId}>{words.caption}</div>
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
        : <span className="pf-tag pf-vlayer" data-layer={entry.layer}>{t(LAYER_WORDS[entry.layer])}</span>}
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
  const t = useT()
  const pick = pickState(props.entry, props.row.options ?? [])
  return (
    <span className="pf-pick">
      <select
        aria-label={rowWords(t, props.row).name}
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
  const t = useT()
  const held = props.entry?.value ?? ''
  return (
    <CommitNumberInput
      held={held}
      unset={props.entry === undefined}
      label={rowWords(t, props.row).name}
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
  const t = useT()
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
      aria-label={rowWords(t, props.row).name}
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
  const t = useT()
  const on = props.entry === undefined ? null : props.entry.value === 'on'
  return (
    <div className="pf-seg" role="group" aria-label={rowWords(t, props.row).name}>
      {SIDES.map(([word, flag]) => (
        <button
          key={word}
          type="button"
          className="pf-segbtn"
          aria-pressed={on === flag}
          aria-describedby={props.noteId}
          onClick={() => props.onWrite(flag ? 'on' : 'off')}
        >
          {t(word)}
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
  const t = useT()
  const { side, value, onChange } = props
  const out = side === 'left' ? -1 : 1
  return (
    <Grip
      label={t('config.grip.aria')}
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