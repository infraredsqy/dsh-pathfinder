/**
 * 设置那一格的读数面：摆哪四行、行尾那三个词、那一列的宽窄。
 *
 * 画它们的那一半住在 `config.tsx`。分出来是因为这一份里没有 JSX 也没有 DOM——四行与三个词
 * 是这一格与工具、与读者之间的约定（摆错一行就有一行写不进记录，写错一个词读者就读不出值住
 * 在哪一层），值得在不装浏览器的地方单独量。
 *
 * @module dsh-pathfinder/client/config-rows
 */
import type { ConfigEntry, ConfigKey, ConfigLayer } from '../host/project-config.ts'

/** 一行用哪枚控件。 */
export type ControlKind = 'pick' | 'num' | 'toggle'

/** 一行：设置键、名字、一句说清它管什么的话、控件种类，下拉那一档还带着候选值。 */
export interface ConfigRow {
  readonly key: ConfigKey
  readonly name: string
  readonly caption: string
  readonly kind: ControlKind
  /** 只有下拉那一档有：工具认得的那几个词，次序照蓝本。 */
  readonly options?: readonly string[]
}

/** 四行，次序就是读者遇到它们的次序——与蓝本那一份逐字相同。 */
export const CONFIG_ROWS: readonly ConfigRow[] = [
  {
    key: 'worktree_mode',
    name: 'worktree 档',
    caption: '一格的活要不要开在自己的 worktree 里跑',
    kind: 'pick',
    options: ['off', 'fork', 'reuse'],
  },
  {
    key: 'test_tier',
    name: '测试档',
    caption: 'full 跑整套测试套件，minimal 只跑项目自己的几条检查',
    kind: 'pick',
    options: ['full', 'minimal'],
  },
  {
    key: 'max_agents',
    name: '并行 subagent 上限',
    caption: '一个 session 同时在飞的 subagent 数量上限',
    kind: 'num',
  },
  {
    key: 'issue_repair',
    name: 'issue 开关',
    caption: '问题池越线时自动加入解决问题的节点；关了就不自动加',
    kind: 'toggle',
  },
]

/** 下拉此刻摆什么。 */
export interface PickState {
  /** 它该选中的那一档；没有一档可选时是空串（留空）。 */
  readonly value: string
  /** 候选表外的那一枚：读数里有、表里没有的值补成一档摆出来；没有就是 `null`。 */
  readonly extra: string | null
}

/**
 * 下拉选哪一档：读数里没有这个键的值时**一档都不落**（留空），不去摆第一档。
 *
 * 受控 select 在 `value` 对不上任何一枚 option 时由浏览器自己回落选第一枚——
 * `worktree_mode` 就落成 `off`、`test_tier` 落成 `full`，正好是两个键的出厂默认词，读者分不出
 * 「记录里没有」与「记录里就是 off / full」。没有的东西不画：这里把那一手挡在前面，没有值就留空。
 * 值在读数里、只是不在候选表里（工具那一侧加了词）时不藏它——把它自己补成一档摆出来，读数与
 * 记录一致。候选表本身不动。
 * @param entry - 这一行的读数；这个键没印出来时是 `undefined`。
 * @param options - 这一行的候选值，工具认得的那几个词。
 * @returns 下拉该有的值，以及要补进候选表的那一枚。
 */
export function pickState(entry: ConfigEntry | undefined, options: readonly string[]): PickState {
  const value = entry?.value ?? ''
  if (value.length === 0) return { value: '', extra: null }
  return options.includes(value) ? { value, extra: null } : { value, extra: value }
}

/** 行尾那枚层签的三个词。默认那一档读作「默认」：出厂那一份谁都没改过。 */
export const LAYER_WORDS: Readonly<Record<ConfigLayer, string>> = {
  default: '默认',
  project: '本项目',
  global: '全局',
}

/** 那一列宽窄的上下限、默认值与两种步子，照蓝本。 */
export const CONFIG_WIDTH = 720
export const CONFIG_WIDTH_MIN = 480
export const CONFIG_WIDTH_MAX = 960
export const CONFIG_WIDTH_STEP = 24
export const CONFIG_WIDTH_BIG = 48

/** 把宽度收进上下限。 */
export function clampConfigWidth(px: number): number {
  return Math.round(Math.max(CONFIG_WIDTH_MIN, Math.min(CONFIG_WIDTH_MAX, px)))
}