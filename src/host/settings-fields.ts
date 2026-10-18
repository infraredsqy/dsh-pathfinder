/**
 * 面板自己的偏好在设置文档里那一节的字段面：字段名、出厂默认、以及几个取值集合。
 *
 * 这一份两边都读（宿主照它建 `Config`，浏览器照它读写设置文档），所以出厂默认只写这一遍。
 * 命名空间由 profile 那一行决定，不在这里。
 */

/** 每列几张卡那一档。 */
export type InfoLevel = 'lean' | 'three' | 'full'

/** 六个看法的身份；键名与蓝本那两列（`tab-*` / `pane-*`）对得上。 */
export type ViewId = 'now' | 'detail' | 'notes' | 'wires' | 'issue' | 'config'

/**
 * 这一节里那几个字段的名字：宿主 schema 的键、写回时 `set` 那一条的路径、以及浏览器半身
 * 读回来时认的键，三处是同一个字，所以它只写在这一份里。
 */
export const PANEL_PREF_FIELDS = {
  sideWidth: 'sideWidth',
  infoLevel: 'infoLevel',
  defaultTab: 'defaultTab',
  showArchived: 'showArchived',
  showOtherStates: 'showOtherStates',
} as const

/** 明细左侧线路栏宽度的下限，与蓝本同一档。 */
export const SIDE_MIN = 120

export const SIDE_MAX = 320

/** 没拖过时的宽度。 */
export const SIDE_DEFAULT = 176

/** 三档信息量，次序就是设置页那一行钮的次序。 */
export const INFO_LEVELS: readonly InfoLevel[] = ['lean', 'three', 'full']

/** 六个看法，次序就是标签那一排的次序。 */
export const VIEW_IDS: readonly ViewId[] = ['now', 'detail', 'notes', 'wires', 'issue', 'config']

/**
 * 没记过时的样子。
 *
 * 侧栏宽度在设置页里没有对应的行——它是拖出来的一个值，蓝本那一页也没有这一行——但值
 * 同样住这份文档，所以它照旧在这里给一个出厂默认。
 */
export const PANEL_PREF_DEFAULTS = {
  sideWidth: SIDE_DEFAULT,
  infoLevel: 'three',
  defaultTab: 'now',
  showArchived: false,
  showOtherStates: false,
} as const