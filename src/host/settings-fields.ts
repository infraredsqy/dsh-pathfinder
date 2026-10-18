/**
 * 面板自己的偏好在设置文档里那一节的字段面：字段名、出厂默认、以及几个取值集合。
 *
 * 这一份两边都读。宿主半身照它建 `Config`（DSH 里一条插件行就是一个设置命名空间，
 * schema 的字段就是设置页里的行），浏览器半身照它把一份设置文档读回面板要的那几个值、
 * 也照它把一次改动写成设置服务认的那一个动作。放在宿主这一侧是因为**设置文档是宿主
 * 声明的**：浏览器半身只是它现成的一个读者。
 *
 * 出厂默认在这里只写一遍：schema 拿它当 `.default()`，浏览器那侧拿它当「设置服务还没
 * 接上时那一份」。两处各写一份的话，设置到齐前后的那两帧读数会不一样。
 *
 * 命名空间不在这里：它由 profile 那一行决定，见 `cordis.patch.yml` 那条 `- insert:`。
 *
 * @module dsh-pathfinder/host/settings-fields
 */

/** 每列几张卡那一档。 */
export type InfoLevel = 'lean' | 'three' | 'full'

/** 六个看法的身份；键名与蓝本那两列（`tab-*` / `pane-*`）对得上。 */
export type ViewId = 'now' | 'detail' | 'notes' | 'wires' | 'issue' | 'config'

/**
 * 这一节里那几个字段的名字。
 *
 * 宿主 schema 的键、写回时 `set` 那一条的路径、以及浏览器半身读回来时认的键，三处
 * 是同一个字——所以它只写在这一份里。
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

/** 见 {@link SIDE_MIN}。 */
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