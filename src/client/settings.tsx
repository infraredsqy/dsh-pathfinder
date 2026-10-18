/**
 * 面板自己在 DSH 设置里的那一节：一条导航行，加上它打开的那一页。
 *
 * 这一节住在 DSH 自己的设置面板里，跟主面板不在一棵树上，所以它拿不到构建期收进
 * `.pf-page` 的那几张表——样式自己带一份，挂在文档头上一次，类名一律走 `pfset-` 这个
 * 前缀，颜色只走 DSH 的主题令牌，一眼看得出它不是外壳自己的东西，也不会撞上它。
 *
 * 那一页里只有四行，都是面板自己的显示偏好：默认信息量、默认标签页、指令里显示已归档
 * 的、问题池里显示未解决之外的。侧栏宽度在这里没有行——它是拖出来的一个值，值同样住
 * 这份文档，界面留在明细那道缝上。
 *
 * 这一页与面板读的是同一份设置表单（见 `registerSettingsSection`），所以翻一行，面板
 * 当场跟着变，不必刷新。
 *
 * @module dsh-pathfinder/client/settings
 */
import * as React from 'react'
import { INFO_LEVELS, PANEL_PREF_FIELDS, VIEW_IDS } from '../host/settings-fields.ts'
import { DEFAULT_SOURCE, INFO_LABELS, VIEW_LABELS } from './prefs.ts'
import type { PrefField, PrefsForm, PrefsSource, PrefsStore } from './prefs.ts'
import { serviceAt } from './data.ts'

/**
 * 这一节占的设置槽位：一条注册既是导航行，也是它打开的那一页。
 *
 * 用官方的 Plugins 那一组会撞上官方设置页自己的规矩（那一格写着已占），所以走具名的
 * `settings.section`。
 */
export const SECTION_SLOT = 'settings.section'

/**
 * 设置命名空间，也就是 `cordis.patch.yml` 里那条 `- insert:` 的 id。
 *
 * DSH 里「一个设置命名空间就是一条插件行」：宿主照那条 id 收命名空间，浏览器半身照它
 * 去要表单。这两处写的是同一个字，中间没有第二处校验——改这里的字，等于把这一页挪到
 * 一个没人服务的命名空间上。
 */
export const SETTINGS_NAMESPACE = 'pathfinder'

/** 导航那一行摆在设置里的位置。 */
export const SECTION_ORDER = 60

/** 导航行上的字。 */
export const SECTION_LABEL = '寻路面板'

/** 这份表在文档里的记号。 */
const STYLE_ID = 'dsh-pathfinder-settings-style'

/**
 * 这一节的样式。
 *
 * 行形态照蓝本那一页（名字 + 一句提示 + 右端控件），几何照 DSH 自己那份设置行：开关是
 * 36×20 的胶囊轨道，下拉取标准控件那一档。颜色一律只写 DSH 自己的别名令牌，兜底的字面
 * 颜色一个都不留——这一节只住在 DSH 自己的设置面板里，那儿的别名一定在。圆角与字体族那
 * 两条兜底留着，它们说的是几何，与令牌在不在无关。
 */
const CSS = `
.pfset-page{display:flex;flex-direction:column;padding:8px 0;max-width:760px;font-family:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.pfset-row{display:flex;align-items:center;gap:12px;min-height:32px;padding:10px 0}
.pfset-row + .pfset-row{border-top:0.5px solid var(--dsw-alias-border-l2)}
.pfset-text{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0}
.pfset-label{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.pfset-info{position:relative;flex:none;width:15px;height:15px;display:inline-flex;align-items:center;justify-content:center;padding:0;font-family:var(--ds-font-family-code,monospace);font-size:10px;line-height:1;color:var(--dsw-alias-label-caption);background:none;border:0.5px solid var(--dsw-alias-border-l3);border-radius:50%;corner-shape:round;cursor:help}
.pfset-info:hover,.pfset-info:focus{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-caption)}
.pfset-info::after{content:attr(data-tip);position:absolute;top:calc(100% + 8px);left:-4px;z-index:2;width:max-content;max-width:260px;padding:3px 7px;font-size:13px;line-height:1.5;color:var(--dsw-alias-toast-label);background:var(--dsw-alias-tooltip-bg);border:0;border-radius:var(--dsw-radius-sm,8px);opacity:0;visibility:hidden;transition:opacity 120ms ease}
.pfset-info:hover::after,.pfset-info:focus::after{opacity:1;visibility:visible}
.pfset-seg{flex:none;display:inline-flex;gap:2px;padding:2px;background:var(--dsw-alias-bg-layer-3);border-radius:var(--dsw-radius-md,10px)}
.pfset-segbtn{font:inherit;font-size:13px;line-height:18px;padding:5px 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}
.pfset-segbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pfset-segbtn[aria-pressed='true']{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pfset-select{flex:none;height:34px;padding:0 28px 0 12px;font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,10px);cursor:pointer}
.pfset-select option{background-color:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary)}
body[data-ds-dark-theme] .pfset-select{color-scheme:dark}
.pfset-switch{flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer;display:inline-flex}
.pfset-switch[aria-checked='true']{background:var(--dsw-alias-link)}
.pfset-swthumb{width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary);transition:transform 120ms ease}
.pfset-switch[aria-checked='true'] .pfset-swthumb{transform:translateX(16px)}
.pfset-msg{margin:0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
`

/** 把这一节的表挂进文档一次。 */
export function ensureSettingsStyle(): void {
  try {
    if (document.getElementById(STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  } catch (error) {
    /* 一张挂不上的表也比不上一页本身。 */
  }
}

/** 这一页拿到的那几样。 */
export interface SettingsSectionProps {
  /** 面板读设置、写设置的那条口子；不给就按出厂那几条画。 */
  readonly source?: PrefsSource | undefined
}

/** 这一节表的正文，供自证夹具按同一份量。 */
export const SETTINGS_CSS: string = CSS

/** 一行：名字、一枚提示、右端那个控件。 */
function Row(props: {
  readonly label: string
  readonly tip: string | null
  readonly control: React.ReactNode
}): React.ReactElement {
  return (
    <div className="pfset-row">
      <div className="pfset-text">
        <span className="pfset-label">{props.label}</span>
        {props.tip === null
          ? null
          : (
            <button
              type="button"
              className="pfset-info"
              data-tip={props.tip}
              aria-label={`${props.label}这一行管什么`}
            >
              i
            </button>
          )}
      </div>
      {props.control}
    </div>
  )
}

/**
 * 设置里这一页。
 *
 * 读法只有一条：面板那条口子的读数。翻一行就往同一个控制器上写一条，回读也还是它，
 * 所以这一页与面板永远说的是同一件事。
 * @param props - 面板那条设置口子。
 * @returns 这一页。
 */
export function SettingsSection(props: SettingsSectionProps): React.ReactElement {
  ensureSettingsStyle()
  const source = props.source ?? DEFAULT_SOURCE
  const snapshot = React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const prefs = snapshot.prefs
  const failure = snapshot.failure ?? null
  const write = (field: PrefField, value: unknown): void => {
    void source.write(field, value)
  }

  return (
    <div className="pfset-page">
      <Row
        label="默认信息量"
        tip={null}
        control={(
          <div className="pfset-seg" role="group" aria-label="默认信息量">
            {INFO_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                className="pfset-segbtn"
                aria-pressed={level === prefs.info}
                onClick={() => write(PANEL_PREF_FIELDS.infoLevel, level)}
              >
                {INFO_LABELS[level]}
              </button>
            ))}
          </div>
        )}
      />
      <Row
        label="默认标签页"
        tip={null}
        control={(
          <select
            className="pfset-select"
            aria-label="默认标签页"
            value={prefs.tab}
            onChange={(event) => write(PANEL_PREF_FIELDS.defaultTab, event.target.value)}
          >
            {VIEW_IDS.map((id) => <option key={id} value={id}>{VIEW_LABELS[id]}</option>)}
          </select>
        )}
      />
      <Row
        label="指令里显示已归档的"
        tip="归档的条目默认收起来：一屏里先看见现在还算数的。打开这一行，它们回到各自的段里，右边多一枚复原。"
        control={(
          <button
            type="button"
            className="pfset-switch"
            role="switch"
            aria-checked={prefs.archived}
            aria-label="指令里显示已归档的"
            onClick={() => write(PANEL_PREF_FIELDS.showArchived, !prefs.archived)}
          >
            <span className="pfset-swthumb" />
          </button>
        )}
      />
      <Row
        label="问题池里显示未解决之外的"
        tip="问题池那一格默认只画未解决的。打开这一行，已承认 / 已驳回 / 已解决 才回到页面上，各自收在自己的段里。"
        control={(
          <button
            type="button"
            className="pfset-switch"
            role="switch"
            aria-checked={prefs.otherStates}
            aria-label="问题池里显示未解决之外的"
            onClick={() => write(PANEL_PREF_FIELDS.showOtherStates, !prefs.otherStates)}
          >
            <span className="pfset-swthumb" />
          </button>
        )}
      />
      {snapshot.status === 'unavailable'
        ? (
          <p className="pfset-msg">
            {`DSH 还没把 ${SETTINGS_NAMESPACE} 暴露成设置命名空间，这里的改动不会保存。`}
          </p>
        )
        : null}
      {/* 写回被拒时摆的就是这一行：`mutate` 只交回一个 `false`，面板那几处 `void …write(…)`
          把它丢掉，读者看到的就只剩控件弹回。这句话从那条口子的读数上来，设置页与面板共用，
          所以哪一处翻的行没落定，都在这里说得出为什么。 */}
      {failure === null
        ? null
        : <p className="pfset-msg" role="status">{failure}</p>}
    </div>
  )
}

/** 上下文那一侧用得上的那一手。 */
interface ClientContext {
  inject?: (names: readonly string[], callback: (owner: unknown) => void) => unknown
}

/** `slots` 那一侧用得上的两手。 */
interface SlotsService {
  inject?: (key: string, register: () => unknown) => unknown
  register?: (options: unknown, component: (props: SettingsSectionProps) => React.ReactElement) => unknown
}

/**
 * 把这一节接到设置上。
 *
 * 四件事按这个次序做，每一件都挡在自己的 try 里：
 * 1. 把面板那条口子接到 `configForms.get(SETTINGS_NAMESPACE)` 上——面板与设置页从此读
 *    同一份表单；交回的摘除器挂在一条 `effect` 上，重载时一并还回去。
 * 2. 往 `settings.section` 里注册一条：它既是导航行，也是那一页。
 * 3. 注册**幂等**：先撤掉上一次，且把异常收在自己手里。
 * 4. 上面两条各挂在一条 `effect` 上：`slots` 取不到时第 1 条照旧接得上、也照旧还得回去。
 *
 * 服务用动态的 `ctx.inject` 等（`ctx.get` 在这个部署里会摸空，而且悄无声息），取不到
 * `slots` / `configForms` 就安静地不做——这一层从不把插件的 `apply` 弄挂。
 *
 * 那一节**不**挂在 `configForms.whileServed` 那道闸门上：那道闸门在宿主没服务这个命名
 * 空间时把注册整个省掉，而省掉的时候哪儿都不报，设置里干脆没有这一页。一页站在这儿、
 * 自己说清它做不了什么，比一页悄悄不出现强。
 *
 * 注册这一下尤其不能重复：`slots.register` 碰到同一个 id 已经在册会抛，而那个抛落在槽位
 * 登记处的通知里——React 自己的订阅也在那条通知上，于是页面还在、控件还亮着，对鼠标与
 * 键盘却全死了。所以重入之前先 dispose 上一次，并且让异常停在这一层。
 * @param ctx - 浏览器半身那一个插件上下文。
 * @param store - 面板与设置页共读的那条设置口子。
 */
export function registerSettingsSection(ctx: unknown, store: PrefsStore): void {
  const holder = ctx as ClientContext | null | undefined
  if (holder === null || holder === undefined || typeof holder.inject !== 'function') return
  try {
    holder.inject(['slots', 'configForms'], (owner) => {
      try {
        const effect = (owner as { effect?: (run: () => () => void, name?: string) => unknown }).effect

        /* 把面板那条口子接到设置表单上，交回的摘除器挂在它自己那条 `effect` 上：设置表单
         * 归 ui-settings 的服务，它比这条插件活得久，接上去的每一个订阅者都得还回去——不然
         * 每次重载都在它上面多留一个，指着一个再没人读的口子。 */
        const attachForm = (): (() => void) => {
          const forms = serviceAt(owner, 'configForms')
          const getForm = forms?.get
          if (typeof getForm !== 'function') return () => undefined
          try {
            return store.attach((getForm as (namespace: string) => PrefsForm).call(forms, SETTINGS_NAMESPACE))
          } catch (error) {
            report('设置表单没接上，面板按出厂那几条画', error)
            return () => undefined
          }
        }
        if (typeof effect === 'function') effect.call(owner, attachForm, 'dsh-pathfinder: settings form')
        else attachForm()

        const slots = serviceAt(owner, 'slots') as SlotsService | undefined
        if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

        let registration: unknown = null
        const contribute = (): void => {
          if (registration !== null) return
          try {
            registration = slots.inject?.(SECTION_SLOT, () => slots.register?.({
              name: SECTION_SLOT,
              id: SETTINGS_NAMESPACE,
              order: SECTION_ORDER,
              label: () => SECTION_LABEL,
              /* 读数在槽位真的渲染时才绑：这一层不替它先读一遍。 */
              inject: () => ({ source: store }),
            }, SettingsSection))
          } catch (error) {
            registration = null
            report('设置那一页没注册上', error)
          }
        }
        const withdraw = (): void => {
          if (registration === null) return
          const dispose = registration
          registration = null
          try {
            if (typeof dispose === 'function') dispose()
          } catch (error) {
            report('设置那一页没撤下来', error)
          }
        }
        const serve = (): (() => void) => {
          contribute()
          return withdraw
        }
        if (typeof effect === 'function') effect.call(owner, serve, 'dsh-pathfinder: settings page')
        else serve()
      } catch (error) {
        report('设置那一页没接上', error)
      }
    })
  } catch (error) {
    report('设置那一页没接上', error)
  }
}

/** 一条警告；设置这一节出了岔子不该静悄悄。 */
function report(what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  // eslint-disable-next-line no-console -- 这一节没接上必须留下一条可查的痕迹
  console.warn(`dsh-pathfinder: ${what}：${message}`)
}