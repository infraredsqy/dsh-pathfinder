/**
 * client 各格共用的那几枚构件：一道可挪的缝、一枚计数小签、一枚模态外壳、一只提交式数字框。
 *
 * 每一枚只长一份：拖缝的量法三处各有各的，可拖、可键盘、可双击回默认那一套行为只有一种写法；
 * 模态的遮罩、Escape 与聚焦同出一处，各格只交出自己的正文。
 */
import * as React from 'react'

/**
 * 一道可挪的缝：指针拖动、键盘步进、双击回默认与 aria 值都在这一份里，三处（明细侧栏、
 * 设置那一列、问题池那道缝）只交出自己的量法与边界。
 *
 * 量法收在两个增益与一把尺子里：指针挪一个像素值变多少（`dragGain`）、方向键走一步值变多少
 * （`keyGain`，带符号——挪的是哪一侧的缘由它说），算出来的数再过调用方那把 `clamp` 落到边界上。
 * 键盘是 ArrowLeft / ArrowRight 一步、按住 shift 走大步，Home / End 顶到两头。
 */
export function Grip(props: {
  readonly label: string
  readonly value: number
  /** aria 上报的两头；键盘 Home / End 也落在这里。 */
  readonly min: number
  readonly max: number
  /** 边界：算出来的值落到哪——四舍五入与上下限都在这一手里。 */
  readonly clamp: (px: number) => number
  readonly step: number
  /** 指针挪一个像素、值变多少；默认 1。设置列那一对是 ±2：单侧挪 Δ、宽窄变 2Δ、中心不动。 */
  readonly dragGain?: number
  /** 方向键走一步、值变多少；默认 1。 */
  readonly keyGain?: number
  /** 按住 shift 走的大步；不给就是两步。 */
  readonly bigStep?: number
  readonly onChange: (px: number) => void
  /** 松手与双击那一下的落定；不给就只改不落。 */
  readonly onCommit?: (px: number) => void
  /** 双击回到的那一个值；不给就没有双击这一手。 */
  readonly resetTo?: number
  /** 拖动那口气的记号；问题池拿它给整页挂 is-dragging。 */
  readonly onDragging?: (dragging: boolean) => void
  readonly className?: string
  readonly id?: string
  readonly gripRef?: React.Ref<HTMLDivElement>
  /** 各处自己的记号：设置列的 data-side / data-width 走这里。 */
  readonly attributes?: Readonly<Record<string, string>>
}): React.ReactElement {
  const { value, clamp, onChange } = props
  const from = React.useRef(0)
  const base = React.useRef(value)
  return (
    <div
      className={props.className ?? 'pf-grip'}
      id={props.id}
      ref={props.gripRef}
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      aria-label={props.label}
      aria-valuenow={value}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      {...props.attributes}
      onPointerDown={(event) => {
        from.current = event.clientX
        base.current = value
        /* 合成事件里没有真的 pointer，抓不住也不算错：那一下本来就没在拖。 */
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch (error) {
          from.current = event.clientX
        }
        props.onDragging?.(true)
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        const moved = clamp(base.current + (props.dragGain ?? 1) * (event.clientX - from.current))
        if (moved !== value) onChange(moved)
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        props.onDragging?.(false)
        props.onCommit?.(value)
      }}
      onPointerCancel={() => props.onDragging?.(false)}
      onDoubleClick={() => {
        if (props.resetTo === undefined) return
        onChange(props.resetTo)
        props.onCommit?.(props.resetTo)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Home') {
          event.preventDefault()
          onChange(clamp(props.min))
          return
        }
        if (event.key === 'End') {
          event.preventDefault()
          onChange(clamp(props.max))
          return
        }
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const pace = event.shiftKey ? (props.bigStep ?? props.step * 2) : props.step
        const toward = event.key === 'ArrowRight' ? 1 : -1
        onChange(clamp(value + (props.keyGain ?? 1) * pace * toward))
      }}
    />
  )
}

/** 一枚计数小签：哪个状态几条。没有状态的合算那一枚，身上不挂空状态类。 */
export function Pill(props: { readonly cls: string; readonly n: number; readonly label: string }): React.ReactElement {
  return (
    <span className="pf-pill" title={props.label}>
      <i className={`pf-cell${props.cls.length === 0 ? '' : ` ${props.cls}`}`} />
      <b className="pf-num">{`× ${String(props.n)}`}</b>
    </span>
  )
}

/**
 * 一枚模态外壳：遮罩点一下收掉、Escape 收掉、挂载那一拍把焦点交给外壳。
 *
 * 监听的依赖收敛到 `onClose` 那一个值，不再整包 props 每渲染重挂一遍。
 */
export function ModalShell(props: {
  /** 标题那一行的 id：对话框靠它报自己的名字。 */
  readonly labelId: string
  /** 标题那一行的字。 */
  readonly name: string
  /** 名字悬停时摆的那一句；不给就不挂悬停。 */
  readonly nameTitle?: string
  readonly onClose: () => void
  readonly children: React.ReactNode
}): React.ReactElement {
  const { onClose } = props
  const panel = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    panel.current?.focus()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="pf-modal" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="pf-modal-panel" role="dialog" aria-modal="true" aria-labelledby={props.labelId} ref={panel} tabIndex={-1}>
        <div className="pf-modal-head">
          <span className="pf-modal-name" id={props.labelId} title={props.nameTitle}>{props.name}</span>
          <button type="button" className="pf-mini" onClick={onClose}>关闭</button>
        </div>
        {props.children}
      </div>
    </div>
  )
}

/**
 * 一只提交式数字框：type=number、失焦与回车都算改完，敲下的字活在框里，读数来了才让位。
 *
 * 框里那份字跨得过提交：失焦与回车常常接踵而至（提交那一拍焦点挪走是常事），把没被读数接过的
 * 字当空交出去，写面就会拿「没立过」顶替刚立的那一笔。读数里那个值变了（写完再读回来、或从
 * 别处改了），框里才换成读数那一份。提交规则由调用方给：这里只把修剪过的字交出去，写不写、
 * 写什么由它说。
 */
export function CommitNumberInput(props: {
  /** 读数里那个值印出来的样子；框里那份字以它起头，也回到它。 */
  readonly held: string
  /** 读数里没有这个值：框上挂 is-unset，占位摆「未设置」。 */
  readonly unset: boolean
  readonly label: string
  readonly describedBy: string
  /** 读数的记号：它一翻，框里那份字就换成读数那一份。不给就只跟着 held 走。 */
  readonly revision?: number
  readonly title?: string
  readonly onCommit: (text: string) => void
}): React.ReactElement {
  const [text, setText] = React.useState(props.held)
  React.useEffect(() => { setText(props.held) }, [props.held, props.revision])
  const commit = (): void => {
    props.onCommit(text.trim())
  }
  return (
    <input
      className={`pf-numin${props.unset ? ' is-unset' : ''}`}
      type="number"
      min={1}
      aria-label={props.label}
      aria-describedby={props.describedBy}
      placeholder={props.unset ? '未设置' : ''}
      value={text}
      title={props.title}
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
