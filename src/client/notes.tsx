/**
 * 主面板第三格：指令簿。「记下一条」那一行（范围点名＋原话照抄）加按范围分组的登记簿。
 *
 * 写面在外壳：添一条、归档、复原都经这里的回调递上去，写成没有由回调的回值说；删除只把那一条
 * 递回外壳——确认模态归外壳摆。这一格自己不碰口子。
 */
import * as React from 'react'
import type { InstructionScope } from '../host/gateway.ts'
import type { CycleReading, InstructionReading, NodeReading, ProjectReading } from '../model/index.ts'
import { dayLabel, groupInstructions } from '../model/index.ts'
import { NOT_ENABLED } from './constants.ts'
import { timeOf } from './marks.tsx'

/** 收起归档时，一组里最多露几行不算数的。 */
const NOTES_ROWS = 5

/**
 * 指令簿那一格的整格版面：「记下一条」那一行加登记簿。
 * @param props - 露不露面、这一格收不收成一句话、那一刻的读数与记录里那几条线、设置里
 *   「已归档也摆出来」那一个值，以及添、归档、复原、删除四下的去处。
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

/** 范围那一枚挑出来的三样：范围词、绑哪条线、绑哪一格。 */
interface ScopeChoice {
  readonly value: string
  readonly label: string
  readonly scope: InstructionScope
  readonly cycle: string
  readonly node: string
}

/** 全局那一项：范围表上的头一项，挑过的那条线不在了就退到它。 */
const GLOBAL_CHOICE: ScopeChoice = { value: 'global', label: '全局', scope: 'global', cycle: '', node: '' }

/**
 * 范围那一列摆哪几项：全局、记录里那几条线、此刻在手里的那一格。
 *
 * 蓝本那一行也只摆这三样，只是它每回只点得到最上面那个在跑着的格；真面板里在手里的是哪
 * 一格由记录自己说，没有就是没有这一项。
 * @param cycles - 那一刻记录里那几条线。
 * @param inHand - 此刻在手里的那一格；没有就只留前两样。
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
 * 「记下一条」那一行：范围点名 + 原话照抄，站在这一格的最上头。
 *
 * 写成了才把那句话从框里收走：工具拒了的话，用户自己那句原话还留在原处等着改。
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

/** 指令那一格：按范围分组的登记簿。 */
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

  /* 已归档的条目默认收起来：一屏里先看见现在还算数的。设置里那一行打开之后，它们回到各自的段
   * 里，行右边那枚动作照旧可用。 */
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
