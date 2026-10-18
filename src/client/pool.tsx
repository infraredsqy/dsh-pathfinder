/**
 * 问题那一格：一份登记簿怎么读——左边是清单、右边是一案，中间那道缝读者可以挪。
 *
 * 一页只回答一个问题：还欠着什么。所以它开在「未解决」上，「完整」把另外三个状态放回来。重量条
 * 是这份重量画出来的样子，判成 `external` 的那几条不占格——它们不压这条线，与读数层的加权和同一
 * 个口径。记录里没有重量表或者没有那条策略线，这一条就不画，不拿 0 顶上。
 */
import * as React from 'react'
import type { IssueGroupReading, IssueReading, PoolReading, ProjectReading } from '../model/index.ts'

/** 一个重量单位占几像素，以及两个单位之间那道缝。 */
const SLOT = 6
const SLOTS = 2

/** 两半各自的宽度下限：一行是三列夹一句话，一案是一段话。 */
const POOL_MIN = 320
const CASE_MIN = 360
/** 键盘挪那道缝时一步走多远。 */
const BAR_STEP = 16

const STATE_WORD: Readonly<Record<string, string>> = {
  open: '未解决',
  acknowledged: '已承认',
  rejected: '已驳回',
  resolved: '已解决',
}

function sevClass(severity: string | undefined): string {
  return `is-${severity ?? 'P3'}`
}

/** 记录里那三个不欠着的状态，一条一句：「完整」那枚钮与那枚合计章说的是同一件事。 */
function otherStatesWord(pool: PoolReading): string {
  return (['acknowledged', 'rejected', 'resolved'] as const)
    .map((key) => `${STATE_WORD[key] ?? key} ${String(pool.census[key])}`)
    .join(' · ')
}

/**
 * 问题那一格。
 * @param props - 那一刻的项目读数、这一格此刻读的是哪一档、以及换那一档那一手。
 */
export function IssuePool(props: {
  readonly project: ProjectReading
  readonly showOtherStates: boolean
  readonly onShowOtherStates: (on: boolean) => void
}): React.ReactElement {
  const { pool } = props.project
  const [picked, setPicked] = React.useState<string | null>(null)
  const [folds, setFolds] = React.useState<Readonly<Record<string, boolean>>>({})
  const splitRef = React.useRef<HTMLDivElement | null>(null)
  const gutterRef = React.useRef<HTMLDivElement | null>(null)
  const [left, setLeft] = React.useState<number | null>(null)
  const held = React.useRef<{ readonly at: number; readonly from: number } | null>(null)
  const [bar, setBar] = React.useState({ min: POOL_MIN, max: POOL_MIN, now: POOL_MIN })
  /* 拖动那道缝的当口：这个状态挂在这一格自己身上（不是页面根），样式表那三条跟着它走。 */
  const [dragging, setDragging] = React.useState(false)

  const openGroup = pool.groups.find((group) => group.key === 'open')
  const closedGroups = pool.groups.filter((group) => group.key !== 'open')
  /* 一露面就得是某一案：先看未解决，一个都没有的时候（记录里全结掉了）才看放下的那几堆。 */
  const fallback = openGroup?.entries[0]
    ?? (props.showOtherStates
      ? closedGroups.find((group) => group.key === 'acknowledged')?.entries[0]
        ?? closedGroups.find((group) => group.key === 'resolved')?.entries[0]
        ?? closedGroups.find((group) => group.key === 'rejected')?.entries[0]
      : undefined)
  const selected = pool.rows.find((row) => row.id === picked
    && (row.status === 'open' || props.showOtherStates)) ?? fallback ?? null

  /* 那两半谁占多少地方：读者挪之前按样式表自己那一份，挪过之后就固定在挪到的位置上。 */
  const barAt = React.useCallback(() => {
    const split = splitRef.current
    const gutter = gutterRef.current
    if (split === null || gutter === null) return { now: POOL_MIN, max: POOL_MIN }
    const box = split.getBoundingClientRect()
    const handle = gutter.getBoundingClientRect()
    return {
      now: Math.round(handle.left - box.left),
      max: Math.max(POOL_MIN, Math.round(box.width - handle.width - CASE_MIN)),
    }
  }, [])

  const paintBar = React.useCallback(() => {
    const at = barAt()
    setBar({ min: POOL_MIN, max: at.max, now: left === null ? at.now : left })
  }, [barAt, left])

  /* 那一排数只在量得出来的时候报得准：窗口换了大小、这一格刚露面，都重量一次。挪过的
     那道缝要是被窗口挤出了范围，就把它收回来。 */
  React.useEffect(() => {
    const onResize = (): void => {
      const at = barAt()
      if (left !== null && at.now > at.max) setLeft(at.max)
      else paintBar()
    }
    paintBar()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [paintBar, barAt, left])

  const moveBar = (to: number): void => {
    const at = barAt()
    setLeft(Math.max(POOL_MIN, Math.min(Math.round(to), at.max)))
  }

  /* 方向键挪到下一行；挑中的那一行就是右半边那一条。 */
  const select = (id: string): void => {
    setPicked(id)
  }

  const onRegisterKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const rows = [...(event.currentTarget.querySelectorAll('button.pf-row[data-issue]'))] as HTMLElement[]
    if (rows.length === 0) return
    const at = rows.indexOf(event.target as HTMLElement)
    let next: HTMLElement | undefined
    if (event.key === 'ArrowDown') next = rows[at + 1] ?? rows[0]
    else if (event.key === 'ArrowUp') next = rows[at - 1] ?? rows[rows.length - 1]
    else if (event.key === 'Home') next = rows[0]
    else if (event.key === 'End') next = rows[rows.length - 1]
    if (next === undefined) return
    event.preventDefault()
    next.focus()
    const id = next.getAttribute('data-issue')
    if (id !== null) setPicked(id)
  }

  const foldOf = (group: IssueGroupReading): boolean => (
    folds[group.key] ?? (selected !== null && selected.status === group.key)
  )

  const splitStyle = left === null ? undefined : ({ ['--pf-left' as string]: `${String(left)}px` } as React.CSSProperties)

  return (
    <div className={`pf-page${dragging ? ' is-dragging' : ''}`}>
      <section className="pf-band">
        <div className="pf-seg" role="group" aria-label="问题池的详略">
          <button
            type="button"
            className="pf-segbtn"
            aria-pressed={!props.showOtherStates}
            title={`${STATE_WORD.open ?? ''} ${String(pool.census.open)} 条`}
            onClick={() => props.onShowOtherStates(false)}
          >
            精简
          </button>
          <button
            type="button"
            className="pf-segbtn"
            aria-pressed={props.showOtherStates}
            title={otherStatesWord(pool)}
            onClick={() => props.onShowOtherStates(true)}
          >
            完整
          </button>
        </div>
        {pool.weights === null || pool.line === null ? null : <Gauge pool={pool} />}
        <div className="pf-count">
          {pool.census.open > 0
            ? <Pill cls="is-open" n={pool.census.open} label={STATE_WORD.open ?? ''} />
            : null}
          {props.showOtherStates
            ? (
              <React.Fragment>
                {pool.census.acknowledged > 0 ? <Pill cls="is-acknowledged" n={pool.census.acknowledged} label={STATE_WORD.acknowledged ?? ''} /> : null}
                {pool.census.rejected > 0 ? <Pill cls="is-rejected" n={pool.census.rejected} label={STATE_WORD.rejected ?? ''} /> : null}
                {pool.census.resolved > 0 ? <Pill cls="is-resolved" n={pool.census.resolved} label={STATE_WORD.resolved ?? ''} /> : null}
              </React.Fragment>
            )
            : (pool.census.acknowledged + pool.census.rejected + pool.census.resolved > 0
              ? <Pill cls="" n={pool.census.acknowledged + pool.census.rejected + pool.census.resolved} label={otherStatesWord(pool)} />
              : null)}
        </div>
      </section>

      <div className="pf-split" id="split" style={splitStyle} ref={splitRef}>
        <div
          className="pf-register"
          id="register"
          role="region"
          aria-label="问题池"
          tabIndex={0}
          onKeyDown={onRegisterKey}
        >
          {pool.groups.map((group) => {
            if (group.key !== 'open' && !props.showOtherStates) return null
            if (group.key === 'open') {
              return (
                <React.Fragment key={group.key}>
                  <RegisterHead group={group} />
                  {group.entries.map((entry) => (
                    <RegisterRow
                      key={entry.id}
                      issue={entry}
                      current={entry.id === selected?.id}
                      onPick={select}
                    />
                  ))}
                </React.Fragment>
              )
            }
            const open = foldOf(group)
            return (
              <React.Fragment key={group.key}>
                <RegisterHead group={group} />
                {open ? group.entries.map((entry) => (
                  <RegisterRow
                    key={entry.id}
                    issue={entry}
                    current={entry.id === selected?.id}
                    onPick={select}
                  />
                )) : null}
                <div className="pf-row">
                  <span className="pf-lead" />
                  <button
                    type="button"
                    className="pf-fold"
                    aria-expanded={open}
                    onClick={() => setFolds((table) => ({ ...table, [group.key]: !open }))}
                  >
                    {open ? '收起' : `展开其余 ${String(group.count)} 条`}
                  </button>
                  <span className="pf-mod" />
                </div>
              </React.Fragment>
            )
          })}
        </div>

        <div
          className="pf-gutter"
          id="gutter"
          role="separator"
          aria-orientation="vertical"
          aria-label="问题池与一案的宽度"
          aria-valuemin={bar.min}
          aria-valuemax={bar.max}
          aria-valuenow={bar.now}
          tabIndex={0}
          ref={gutterRef}
          onPointerDown={(event) => {
            held.current = { at: event.clientX, from: barAt().now }
            event.currentTarget.setPointerCapture(event.pointerId)
            event.preventDefault()
            setDragging(true)
          }}
          onPointerMove={(event) => {
            if (held.current === null) return
            moveBar(held.current.from + event.clientX - held.current.at)
          }}
          onPointerUp={(event) => {
            held.current = null
            setDragging(false)
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
          }}
          onPointerCancel={() => { held.current = null; setDragging(false) }}
          onKeyDown={(event) => {
            const at = barAt()
            if (event.key === 'Home') moveBar(POOL_MIN)
            else if (event.key === 'End') moveBar(at.max)
            else if (event.key === 'ArrowLeft') moveBar(at.now - BAR_STEP)
            else if (event.key === 'ArrowRight') moveBar(at.now + BAR_STEP)
            else return
            event.preventDefault()
          }}
        />

        <aside className="pf-case" id="case" role="region" aria-label="一案" tabIndex={0}>
          {selected === null ? null : <CaseFile issue={selected} />}
        </aside>
      </div>
    </div>
  )
}

/** 重量条：一个单位一格，填到还欠着的那几条，框就是那条策略线。 */
function Gauge(props: { readonly pool: PoolReading }): React.ReactElement {
  const { pool } = props
  const line = pool.line ?? 0
  const units = Math.max(line, pool.weight ?? 0)
  const blocks: { readonly severity: string | undefined; readonly carried: boolean; readonly title: string }[] = []
  for (const issue of pool.standing) {
    /* 判成 `external` 的那几条不占这根条上的一格：与读数层的加权和同一个口径，它们还在
       登记簿上，只是不压这条线。 */
    if (issue.decision === 'external') continue
    for (let at = 0; at < issue.weight && blocks.length < units; at += 1) {
      blocks.push({
        severity: issue.severity,
        carried: issue.status === 'acknowledged',
        title: `${issue.severity ?? ''} · 权重 ${String(issue.weight)} · ${issue.title ?? ''}`,
      })
    }
  }
  const [filled, setFilled] = React.useState(false)
  /* 池子填进自己那一份重量里，而不是一露面就是满的：这一趟重读留下的那道错开，说的就是
     「同一份池子又被数了一遍」。 */
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => setFilled(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <div className="pf-gauge" id="gauge" role="group" aria-label="问题池重量与策略线">
      <div
        className="pf-scale"
        id="scale"
        style={{ gap: `${String(SLOTS)}px`, gridTemplateColumns: `repeat(${String(units)}, ${String(SLOT)}px)` }}
      >
        {blocks.map((block, at) => (
          <i
            className={`pf-block ${sevClass(block.severity)}${block.carried ? ' is-carried' : ''}${filled && !block.carried ? ' is-fill' : ''}`}
            key={`b${String(at)}`}
            title={block.title}
            style={{ transitionDelay: `${String(Math.min(at, 24) * 6)}ms` }}
          />
        ))}
        {Array.from({ length: Math.max(0, units - blocks.length) }, (_, at) => (
          <i className="pf-block" key={`e${String(at)}`} />
        ))}
      </div>
      <i
        className="pf-line"
        style={{ left: `${String(line * (SLOT + SLOTS) - SLOTS)}px` }}
        title={`策略线：issue_pool_weight_limit = ${String(line)}`}
      />
    </div>
  )
}

/** 登记簿的一堆：几条在旁边的数里，多重在那根条上。 */
function RegisterHead(props: { readonly group: IssueGroupReading }): React.ReactElement {
  return (
    <div className="pf-head">
      <span className="pf-lead" />
      <span className="pf-head-label">{props.group.label}</span>
    </div>
  )
}

function RegisterRow(props: {
  readonly issue: IssueReading
  readonly current: boolean
  readonly onPick: (id: string) => void
}): React.ReactElement {
  const { issue } = props
  return (
    <button
      type="button"
      className={`pf-row is-${issue.status}`}
      data-issue={issue.id}
      aria-current={props.current}
      onClick={() => props.onPick(issue.id)}
    >
      <span className="pf-lead">
        <i className={`pf-cell is-${issue.status}`} />
        {issue.severity === undefined
          ? null
          : <span className={`pf-sev ${sevClass(issue.severity)}`} title={`${issue.severity} · 权重 ${String(issue.weight)}`}>{issue.severity}</span>}
      </span>
      <span className="pf-title" title={issue.title ?? ''}>{issue.title ?? ''}</span>
      {issue.module === undefined ? null : <span className="pf-mod" title={issue.module}>{issue.module}</span>}
    </button>
  )
}

function CaseFile(props: { readonly issue: IssueReading }): React.ReactElement {
  const { issue } = props
  return (
    <React.Fragment>
      <div className="pf-case-head">
        {issue.severity === undefined
          ? null
          : <span className={`pf-sev ${sevClass(issue.severity)}`} title={`${issue.severity} · 权重 ${String(issue.weight)}`}>{issue.severity}</span>}
        <h2 className="pf-case-title">{issue.title ?? ''}</h2>
      </div>
      <span className="pf-case-id" title={issue.id}>{issue.id}</span>
      {issue.description === undefined ? null : <CaseSection label="现象" body={prose(issue.description)} />}
      {issue.suggestion === undefined ? null : <CaseSection label="修法" body={prose(issue.suggestion)} />}
      {issue.files.length === 0 ? null : (
        <section className="pf-case-sec">
          <h3 className="pf-case-label">位置</h3>
          <ul className="pf-places">
            {issue.files.map((file) => <li className="pf-code" key={file} title={file}>{file}</li>)}
          </ul>
        </section>
      )}
      {issue.planPath === undefined ? null : <CaseSection label="方案" body={issue.planPath} />}
    </React.Fragment>
  )
}

/** 一案里的一段：只有记录里真写着的那几段才站上版面。 */
function CaseSection(props: { readonly label: string; readonly body: React.ReactNode }): React.ReactElement {
  return (
    <section className="pf-case-sec">
      <h3 className="pf-case-label">{props.label}</h3>
      <p className="pf-case-body">{props.body}</p>
    </section>
  )
}

/** 记录自己那句话里那两处记号：`**重点**` 与 `` `代码` ``；别的字一个都不动。 */
function prose(said: string): React.ReactNode {
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/gu
  const out: React.ReactNode[] = []
  let at = 0
  let found = pattern.exec(said)
  while (found !== null) {
    if (found.index > at) out.push(...proseLines(said.slice(at, found.index)))
    out.push(found[1] === undefined
      ? <code className="pf-inline-code" key={`c${String(at)}`}>{found[2]}</code>
      : <strong key={`s${String(at)}`}>{found[1]}</strong>)
    at = found.index + found[0].length
    found = pattern.exec(said)
  }
  if (at < said.length) out.push(...proseLines(said.slice(at)))
  return out
}

/** 一句话里的换行画成换行：记录里那几个字段是几行，这里就是几行。 */
function proseLines(said: string): React.ReactNode[] {
  return said.split('\n').flatMap((line, at) => (at === 0 ? [line] : [<br key={`n${String(at)}`} />, line]))
}

function Pill(props: { readonly cls: string; readonly n: number; readonly label: string }): React.ReactElement {
  return (
    <span className="pf-pill" title={props.label}>
      <i className={`pf-cell${props.cls.length === 0 ? '' : ` ${props.cls}`}`} />
      <b className="pf-num">{`× ${String(props.n)}`}</b>
    </span>
  )
}