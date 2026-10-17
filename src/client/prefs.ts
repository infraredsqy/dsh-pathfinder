/**
 * 面板自己的偏好：住在浏览器本地，跟记录无关。
 *
 * 侧栏宽度、每列几张卡那一档、默认停在哪个看法——这三样是「重开面板后还在」的
 * 那一类值，记录里没有它们的位置。DSH 那边的真开关归另一格，这一格先把它们放在
 * 这里，键名与原型那两个（`frameWidth`、`showArchived`）保持同一套写法。
 *
 * 读一次坏一次都当作没记过：本地存储不可用（隐私模式、跨源限制）时面板照默认值
 * 站着，不因为一个偏好读不出来就空着。
 *
 * @module dsh-pathfinder/client/prefs
 */
import type { CyclePolicyKey } from '../host/gateway.ts'

/** 每列几张卡那一档。 */
export type InfoLevel = 'lean' | 'three' | 'full'

/** 六个看法的身份；键名与蓝本那两列（`tab-*` / `pane-*`）对得上。 */
export type ViewId = 'now' | 'detail' | 'notes' | 'wires' | 'issue' | 'config'

/** 面板自己记住的那几样。 */
export interface PanelPrefs {
  /** 明细左侧线路栏的宽度，像素。 */
  readonly sideWidth: number
  /** 当前那一格每列几张卡。 */
  readonly info: InfoLevel
  /** 面板露面时停在哪个看法。 */
  readonly tab: ViewId
}

/** 侧栏宽度的上下限，与蓝本同一档。 */
export const SIDE_MIN = 120
/** 见 {@link SIDE_MIN}。 */
export const SIDE_MAX = 320
/** 没拖过时的宽度。 */
export const SIDE_DEFAULT = 176

/** 没记过时的样子。 */
export const DEFAULT_PREFS: PanelPrefs = {
  sideWidth: SIDE_DEFAULT,
  info: 'three',
  tab: 'now',
}

/** 本地存储里的键。 */
const KEYS = {
  sideWidth: 'dsh-pathfinder.sideWidth',
  info: 'dsh-pathfinder.infoLevel',
  tab: 'dsh-pathfinder.defaultTab',
} as const

const INFO_LEVELS: readonly InfoLevel[] = ['lean', 'three', 'full']
const VIEW_IDS: readonly ViewId[] = ['now', 'detail', 'notes', 'wires', 'issue', 'config']

/** 读一条，读不出来给 `null`。 */
function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch (error) {
    return null
  }
}

/** 写一条，写不进去就悄悄算了——偏好丢一条不该把面板弄坏。 */
function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch (error) {
    /* 本地存储不可用：这一次的改动只活在这一屏上。 */
  }
}

/** 把宽度收进上下限。 */
export function clampSide(px: number): number {
  return Math.round(Math.max(SIDE_MIN, Math.min(SIDE_MAX, px)))
}

/**
 * 读出面板记住的那几样。
 * @returns 记过的那份，没记过的用默认值补齐。
 */
export function readPrefs(): PanelPrefs {
  const info = read(KEYS.info)
  const tab = read(KEYS.tab)
  const width = Number.parseInt(read(KEYS.sideWidth) ?? '', 10)
  return {
    sideWidth: Number.isNaN(width) ? SIDE_DEFAULT : clampSide(width),
    info: INFO_LEVELS.includes(info as InfoLevel) ? (info as InfoLevel) : DEFAULT_PREFS.info,
    tab: VIEW_IDS.includes(tab as ViewId) ? (tab as ViewId) : DEFAULT_PREFS.tab,
  }
}

/** 记住侧栏的宽度。 */
export function saveSideWidth(px: number): void {
  write(KEYS.sideWidth, String(clampSide(px)))
}

/** 记住每列几张卡那一档。 */
export function saveInfo(level: InfoLevel): void {
  write(KEYS.info, level)
}

/** 记住面板该停在哪个看法。 */
export function saveTab(tab: ViewId): void {
  write(KEYS.tab, tab)
}

/** 一条线自己的三个策略数，键与工具那边逐字相同。 */
export const POLICY_KEYS: readonly CyclePolicyKey[] = ['parallel', 'test_seconds_limit', 'issue_pool_weight_limit']