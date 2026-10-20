/**
 * The third pane of the main panel: the instruction book. A "record one" row (scope picker plus
 * verbatim text) plus a ledger grouped by scope.
 *
 * The write side lives in the shell: adding, archiving, and reviving all go up through the
 * callbacks here, and whether the write landed is said by the callback's return value; delete only
 * hands the entry back to the shell — the confirm modal belongs to the shell. This pane never
 * touches the gateway itself.
 */
import * as React from 'react'
import type { InstructionScope } from '../host/gateway.ts'
import type { CycleReading, InstructionReading, NodeReading, ProjectReading } from '../model/index.ts'
import { dayLabel, groupInstructions } from '../model/index.ts'
import { NOT_ENABLED } from './constants.ts'
import { timeOf } from './marks.tsx'

/** With archived entries collapsed, how many non-standing rows a group may show at most. */
const NOTES_ROWS = 5

/**
 * The full layout of the notes pane: the "record one" row plus the ledger.
 * @param props - Visibility, whether to collapse to one sentence, the reading at this moment with
 *   the record's lines, the settings value for "show archived too", and where the add, archive,
 *   revive, and delete actions go.
 */
export function NotesPane(props: {
  readonly active: boolean
  readonly noNodes: boolean
  readonly project: ProjectReading | null
  readonly cycles: readonly CycleReading[]
  readonly showArchived: boolean
  readonly onAdd: (text: string, scope: InstructionScope, cycle: string, node: string) => Promise<boolean>
  readonly onArchive: (id: string) => void
  readonly onRevive: (id: string) => void
  readonly onDelete: (instruction: InstructionReading) => void
}): React.ReactElement {
  return (
    <div
      className="pf-pane"
      id="pane-notes"
      role="tabpanel"
      aria-labelledby="tab-notes"
      data-fill=""
      hidden={!props.active}
    >
      {props.noNodes ? <p className="pf-innone">{NOT_ENABLED}</p> : (
        <React.Fragment>
          {props.project === null ? null : (
            <InstructionAdd
              cycles={props.cycles}
              inHand={props.project.columns.running[0] ?? null}
              onAdd={props.onAdd}
            />
          )}
          <div className="pf-scroll" id="notes-scroll" role="region" aria-label="用户指令" tabIndex={0}>
            {props.project === null ? null : (
              <InstructionBook
                project={props.project}
                showArchived={props.showArchived}
                onArchive={props.onArchive}
                onRevive={props.onRevive}
                onDelete={props.onDelete}
              />
            )}
          </div>
        </React.Fragment>
      )}
    </div>
  )
}

/** The three things the scope picker needs per entry: the scope word, which line, which cell. */
interface ScopeChoice {
  readonly value: string
  readonly label: string
  readonly scope: InstructionScope
  readonly cycle: string
  readonly node: string
}

/** The global entry: first on the scope table, the fallback when the previously picked line is gone. */
const GLOBAL_CHOICE: ScopeChoice = { value: 'global', label: '全局', scope: 'global', cycle: '', node: '' }

/**
 * Which entries the scope column lists: global, the record's lines, and the cell currently in hand.
 *
 * The blueprint's row lists the same three, only there the clickable running cell is always the top
 * one; in the real panel which cell is in hand is said by the record itself, and when none, the
 * entry is absent.
 */
function scopeChoices(cycles: readonly CycleReading[], inHand: NodeReading | null): readonly ScopeChoice[] {
  const out: ScopeChoice[] = [GLOBAL_CHOICE]
  for (const cycle of cycles) {
    out.push({ value: `cycle:${cycle.id}`, label: cycle.id, scope: 'cycle', cycle: cycle.id, node: '' })
  }
  if (inHand !== null) {
    const name = inHand.title ?? inHand.id
    const short = name.length > 12 ? `${name.slice(0, 12)}…` : name
    out.push({ value: `node:${inHand.id}`, label: `这一格 · ${short}`, scope: 'node', cycle: '', node: inHand.id })
  }
  return out
}

/**
 * The "record one" row: scope picker + verbatim text, standing at the top of the pane.
 *
 * The sentence is cleared from the box only once the write lands: if the tool refuses, the user's
 * own words stay in place, ready to be revised.
 */
function InstructionAdd(props: {
  readonly cycles: readonly CycleReading[]
  readonly inHand: NodeReading | null
  readonly onAdd: (text: string, scope: InstructionScope, cycle: string, node: string) => Promise<boolean>
}): React.ReactElement {
  const [text, setText] = React.useState('')
  const [picked, setPicked] = React.useState(GLOBAL_CHOICE.value)
  const box = React.useRef<HTMLInputElement | null>(null)
  const choices = scopeChoices(props.cycles, props.inHand)
  const chosen = choices.find((one) => one.value === picked) ?? GLOBAL_CHOICE

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const said = text.trim()
    if (said.length === 0) {
      box.current?.focus()
      return
    }
    void props.onAdd(said, chosen.scope, chosen.cycle, chosen.node).then((accepted) => {
      if (accepted) setText('')
    })
  }

  return (
    <form className="pf-add" id="add" onSubmit={submit}>
      <span className="pf-pick">
        <select
          aria-label="这句话管到哪儿"
          value={chosen.value}
          onChange={(event) => setPicked(event.target.value)}
        >
          {choices.map((one) => <option key={one.value} value={one.value}>{one.label}</option>)}
        </select>
      </span>
      <input
        ref={box}
        type="text"
        placeholder="原话照抄"
        aria-label="原话照抄"
        autoComplete="off"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="pf-btn">添加</button>
    </form>
  )
}

/** The instructions cell: the ledger grouped by scope. */
function InstructionBook(props: {
  readonly project: ProjectReading
  readonly showArchived: boolean
  readonly onArchive: (id: string) => void
  readonly onRevive: (id: string) => void
  readonly onDelete: (instruction: InstructionReading) => void
}): React.ReactElement {
  const { project } = props
  const [folded, setFolded] = React.useState<Readonly<Record<string, boolean>>>({})
  const [open, setOpen] = React.useState<Readonly<Record<string, boolean>>>({})

  /* Archived entries are collapsed by default: what still counts now is what a screen shows first.
   * Once the settings row is turned on, they return to their sections, the actions at the row's
   * right still usable. */
  const visible = props.showArchived
    ? project.instructions
    : project.instructions.filter((entry) => entry.standing)
  const groups = groupInstructions(project, visible)
  if (project.instructions.length === 0) {
    return <p className="pf-innone">这份记录里还没有指令。</p>
  }
  return (
    <React.Fragment>
      {groups.length === 0
        ? <p className="pf-innone">现在没有生效的指令。</p>
        : groups.map((group) => {
          const live = group.entries.filter((entry) => entry.inForce).length
          const isFolded = folded[group.key] === true
          const isOpen = open[group.key] === true
          const hidden = Math.max(0, group.entries.length - live - NOTES_ROWS)
          const shown = isOpen ? group.entries : group.entries.slice(0, live + NOTES_ROWS)
          return (
            <section className={`pf-sec${isFolded ? ' is-folded' : ''}`} key={group.key}>
              <button
                type="button"
                className="pf-rowhead"
                aria-expanded={!isFolded}
                onClick={() => setFolded((table) => ({ ...table, [group.key]: !isFolded }))}
              >
                <span className="pf-rowhead-key">{group.label}</span>
                <span className="pf-rowhead-figs">
                  <b className="pf-num">{live}</b>
                  {' 生效'}
                  <React.Fragment>{' · '}<b className="pf-num">{group.entries.length}</b>{' 条'}</React.Fragment>
                </span>
              </button>
              {shown.map((entry) => (
                <InstructionRow
                  key={entry.id}
                  entry={entry}
                  at={project.at}
                  onArchive={props.onArchive}
                  onRevive={props.onRevive}
                  onDelete={props.onDelete}
                />
              ))}
              {hidden > 0 && !isOpen
                ? (
                  <button type="button" className="pf-trim" onClick={() => setOpen((table) => ({ ...table, [group.key]: true }))}>
                    {`展开其余 ${String(hidden)} 条`}
                  </button>
                )
                : null}
              {hidden > 0 && isOpen
                ? (
                  <button type="button" className="pf-trim" onClick={() => setOpen((table) => ({ ...table, [group.key]: false }))}>
                    收起
                  </button>
                )
                : null}
            </section>
          )
        })}
    </React.Fragment>
  )
}

function InstructionRow(props: {
  readonly entry: InstructionReading
  readonly at: Date
  readonly onArchive: (id: string) => void
  readonly onRevive: (id: string) => void
  readonly onDelete: (instruction: InstructionReading) => void
}): React.ReactElement {
  const { entry, at } = props
  const moment = entry.inForce ? entry.saidAt : (entry.closedAt ?? entry.saidAt)
  const mark = entry.inForce ? '' : entry.standing ? '范围外' : '已归档'
  return (
    <article className={`pf-ins${entry.inForce ? '' : ' is-out'}`} title={entry.nodeId ?? ''}>
      <div className="pf-ins-text">{entry.text ?? ''}</div>
      <div className="pf-ins-read" title={`${entry.inForce ? '说于' : `${mark}于`} ${timeOf(moment, at)}`}>
        {mark.length === 0 ? null : <span className="pf-ins-mark">{mark}</span>}
        <span className="pf-num">{dayLabel(moment, at)}</span>
      </div>
      <span className="pf-ins-acts">
        {entry.standing
          ? <button type="button" className="pf-mini" title="收进归档：这一条不再生效，条目留在原处" onClick={() => props.onArchive(entry.id)}>归档</button>
          : <button type="button" className="pf-mini" title="让它重新生效" onClick={() => props.onRevive(entry.id)}>复原</button>}
        <button
          type="button"
          className="pf-mini"
          title="删掉：这一条连同正文一起从记录里拿走，放不回来"
          onClick={() => props.onDelete(entry)}
        >
          删除
        </button>
      </span>
      {entry.note === undefined ? null : (
        <div className="pf-ins-foot"><span className="pf-ins-note">{entry.note}</span></div>
      )}
    </article>
  )
}
