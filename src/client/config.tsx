/**
 * 主面板第六格：这个工作区自己的项目设置。四行，一行一个控件，行尾一枚小签说这个值住在哪一层。
 *
 * 读与写都走工具：有效值与「它来自哪一层」由工具印出来，写落在这个项目那一层。这一层不做第二套
 * 判断——一个值合不合法由工具说。页面上不摆乐观更新：控件印的永远是最近一次读回来的那份读数，
 * 改一下就写回、再读一遍，工具拒了的时候控件自己就回到原位。
 */
import * as React from 'react'
import type { ConfigEntry, ConfigKey, PathfinderConfigReading } from '../host/project-config.ts'
import {
  clampConfigWidth,
  CONFIG_ROWS,
  CONFIG_WIDTH,
  CONFIG_WIDTH_BIG,
  CONFIG_WIDTH_MAX,
  CONFIG_WIDTH_MIN,
  CONFIG_WIDTH_STEP,
  LAYER_WORDS,
  pickState,
  type ConfigRow,
} from './config-rows.ts'
import type { PanelPort } from './data.ts'

const READ_FAILED = '无法读取该工作区的项目设置。'

const WRITE_FAILED = '这次写入没有生效。'

/** 这个工作区里还没有节点那一份记录时，这一格摆的那一句——五个跟节点走的格子说的是同一句。 */
const NOT_ENABLED = '当前工作区尚未启用 Pathfinder。'

const SIDES: readonly (readonly [string, boolean])[] = [['开', true], ['关', false]]

/** 一行的读数走到哪一步了。 */
type Load =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ok'; readonly reading: PathfinderConfigReading }
  | { readonly phase: 'failed'; readonly message: string }

export interface ConfigPaneProps {
  readonly port: PanelPort
  /** 会话身份：工作区文件口子按它认路径。 */
  readonly sessionId: string
  /** 读、写哪个工作区：面板顶上挑中的那个根；空字符串＝这条会话自己那个。 */
  readonly workspaceRoot: string
  /** 这个工作区里还没有节点那一份记录：这一格收成一句话，那条读命令也不必起。 */
  readonly noNodes: boolean
  /** 这一格此刻露不露面：露面那一趟才去读。 */
  readonly active: boolean
  /** 面板底下那条提示行；`null` 是「上一句是我说的，收回去」。 */
  readonly onNote: (text: string | null) => void
}

export function ConfigPane(props: ConfigPaneProps): React.ReactElement {
  const { port, sessionId, workspaceRoot, noNodes, active } = props
  const [load, setLoad] = React.useState<Load>({ phase: 'loading' })
  const [tick, setTick] = React.useState(0)
  const [width, setWidth] = React.useState(CONFIG_WIDTH)
  /* 提示行上最后那一句是谁留下的：读失败留下的那一声由下一次读顺了收回，写失败留下的那一声
     由下一笔写成收回；面板别处留下的那一句，这一格谁也不去动。 */
  const said = React.useRef<'read' | 'write' | null>(null)
  const speak = React.useRef(props.onNote)
  React.useEffect(() => { speak.current = props.onNote }, [props.onNote])
  const note = React.useCallback((text: string | null): void => {
    speak.current(text)
  }, [])

  /* 只在这一格真露面的时候读：读一次要起一条工具命令，没人看的那几格不必花这一下。
   *
   * 读顺了只收上一句读失败留下的那一声；写失败那一句归写那一趟管，不然每写一次被拒，跟着来的
   * 那次重读会把它当场抹掉，读者什么也看不到。 */
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

  /* 写一下：工具说什么就是什么，写完再读一遍——控件印的永远跟着重读回来那一份走。 */
  const send = React.useCallback((key: ConfigKey, next: string): void => {
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
              {CONFIG_ROWS.map((row) => (
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
          : <Toggle row={row} entry={entry} noteId={noteId} onWrite={props.onWrite} />}
      {entry === undefined || entry.layer === null
        ? null
        : <span className="pf-tag pf-vlayer" data-layer={entry.layer}>{LAYER_WORDS[entry.layer]}</span>}
    </div>
  )
}

/** 下拉那一枚：读数里没有这个键的值时一枚都不选中（留空），不去挑第一档。 */
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
        {/* 没有值：留一个空档给它落，别让浏览器去挑第一档；这一枚不在下拉里供人挑。 */}
        {pick.value === '' ? <option value="" hidden /> : null}
        {(props.row.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
        {/* 读数里有、候选表里没有的值：照它自己摆一档，读数与记录一致。 */}
        {pick.extra === null ? null : <option value={pick.extra}>{pick.extra}</option>}
      </select>
    </span>
  )
}

/**
 * 数字那一枚：改完才写（回车或失焦），中间敲的字只活在这个框里。
 *
 * 敲一半的数不是一个值，所以它不往记录上去；`revision` 每写一次就翻一格，翻的时候把框里那一份
 * 草稿丢掉，换成重读回来那一份。
 */
function NumberBox(props: {
  readonly row: ConfigRow
  readonly entry: ConfigEntry | undefined
  readonly noteId: string
  readonly revision: number
  readonly onWrite: (value: string) => void
}): React.ReactElement {
  const [draft, setDraft] = React.useState<string | null>(null)
  const held = props.entry?.value ?? ''
  React.useEffect(() => { setDraft(null) }, [held, props.revision])
  const commit = (): void => {
    const typed = (draft ?? '').trim()
    setDraft(null)
    /* 空着的时候没有数可写，留住记录里那一个；没改过的那一个也不必再写一遍。 */
    if (typed.length === 0 || typed === held) return
    props.onWrite(typed)
  }
  return (
    <input
      className={`pf-numin${props.entry === undefined ? ' is-unset' : ''}`}
      type="number"
      min={1}
      aria-label={props.row.name}
      aria-describedby={props.noteId}
      placeholder={props.entry === undefined ? '未设置' : ''}
      value={draft ?? held}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        commit()
      }}
    />
  )
}

/** 开 / 关那一枚：两枚钮，按下的那一枚是此刻的值；记录里没写这一个键时两枚都不亮。 */
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
 * 列缘那一对把手。
 *
 * 量法照蓝本那一枚共用构件：单侧挪 Δ、宽窄变 2Δ、中心不动，所以指针一直抓在列缘上；双击回默认，
 * 左右方向键走一步，按住 shift 走大步。左边那一枚的 `out` 是 -1：方向键挪的是这一侧的缘。
 */
function ConfigGrip(props: {
  readonly side: 'left' | 'right'
  readonly value: number
  readonly onChange: (px: number) => void
}): React.ReactElement {
  const { side, value, onChange } = props
  const out = side === 'left' ? -1 : 1
  const from = React.useRef(0)
  const base = React.useRef(value)
  return (
    <div
      className="pf-grip"
      data-side={side}
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      aria-label="调整设置那一列的宽度"
      data-width={value}
      aria-valuenow={value}
      aria-valuemin={CONFIG_WIDTH_MIN}
      aria-valuemax={CONFIG_WIDTH_MAX}
      onPointerDown={(event) => {
        from.current = event.clientX
        base.current = value
        /* 合成事件里没有真的 pointer，抓不住也不算错：那一下本来就没在拖。 */
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch (error) {
          from.current = event.clientX
        }
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        const moved = clampConfigWidth(base.current + out * (event.clientX - from.current) * 2)
        if (moved !== value) onChange(moved)
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onDoubleClick={() => onChange(CONFIG_WIDTH)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        const step = (event.shiftKey ? CONFIG_WIDTH_BIG : CONFIG_WIDTH_STEP) * (event.key === 'ArrowRight' ? 1 : -1)
        onChange(clampConfigWidth(value + out * step))
        event.preventDefault()
      }}
    />
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}