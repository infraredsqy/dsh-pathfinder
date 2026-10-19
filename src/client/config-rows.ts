/**
 * 设置那一格的读数面：已知的键怎么描（中文名、那一句话、控件形态、下拉的候选值抄本），
 * 行本身从 `pf config list` 的读数长出来。
 *
 * 这一份里没有 JSX 也没有 DOM，所以能在不装浏览器的地方单独量。工具是设置键的唯一出处，
 * 这里不声明「工具有哪些键」：读数里出现的键都有行——登记过的照这份表描，没登记的照键名
 * 直显、给一枚文本框；读数里没有的键这里也不摆行，没有的东西不画。
 */
import type { ConfigEntry, ConfigLayer } from '../host/project-config.ts'

export type ControlKind = 'pick' | 'num' | 'toggle' | 'text'

export interface ConfigRow {
  readonly key: string
  readonly name: string
  readonly caption: string
  readonly kind: ControlKind
  /** 只有下拉那一档有：工具认得的那几个词，次序照蓝本。 */
  readonly options?: readonly string[]
}

/**
 * 已知的键怎么描，次序就是读者遇到它们的次序（照蓝本）。工具只在 `config --help` 的散文里说
 * 它认得哪些值，没有机器可读的清单，所以候选值在这里留一份抄本；工具那侧加了词时读数里会
 * 出现表外的值，那一枚由 {@link pickState} 就地补成一档，不静默落第一档。
 */
export const KNOWN_CONFIG_ROWS: Readonly<Record<string, ConfigRow>> = {
  worktree_mode: {
    key: 'worktree_mode',
    name: 'worktree 档',
    caption: '一格的活要不要开在自己的 worktree 里跑',
    kind: 'pick',
    options: ['off', 'fork', 'reuse'],
  },
  test_tier: {
    key: 'test_tier',
    name: '测试档',
    caption: 'full 跑整套测试套件，minimal 只跑项目自己的几条检查',
    kind: 'pick',
    options: ['full', 'minimal'],
  },
  max_agents: {
    key: 'max_agents',
    name: '并行 subagent 上限',
    caption: '一个 session 同时在飞的 subagent 数量上限',
    kind: 'num',
  },
  issue_repair: {
    key: 'issue_repair',
    name: 'issue 开关',
    caption: '问题池越线时自动加入解决问题的节点；关了就不自动加',
    kind: 'toggle',
  },
}

/** 没登记的键底下那一句：它叫什么键名已经摆在名字那一格了，这里只说值由谁判。 */
const UNREGISTERED_CAPTION = '这一键还没有它的说法，值合不合法由工具判'

/**
 * 从一份读数长出这一格的行：读数里有的键才有行，一行都不添。
 *
 * 登记过的键照 {@link KNOWN_CONFIG_ROWS} 摆，次序也照它（蓝本那份次序，读者认得的那一版
 * 版面不跟着工具印的次序晃）；没登记的键跟在后面，次序照读数，照键名直显、给一枚文本框——
 * 写面不拦键，值合不合法由工具判。
 * @param entries - `pf config list` 读出来的键到「值 + 层」的表。
 * @returns 面板该摆的那些行：已知的在前照表序，没登记的在后照读数序。
 */
export function configRowsOf(entries: Readonly<Record<string, ConfigEntry>>): readonly ConfigRow[] {
  const rows: ConfigRow[] = []
  for (const known of Object.values(KNOWN_CONFIG_ROWS)) {
    if (entries[known.key] !== undefined) rows.push(known)
  }
  for (const key of Object.keys(entries)) {
    if (KNOWN_CONFIG_ROWS[key] === undefined) rows.push({ key, name: key, caption: UNREGISTERED_CAPTION, kind: 'text' })
  }
  return rows
}

export interface PickState {
  /** 它该选中的那一档；没有一档可选时是空串（留空）。 */
  readonly value: string
  /** 候选表外的那一枚：读数里有、表里没有的值补成一档摆出来；没有就是 `null`。 */
  readonly extra: string | null
}

/**
 * 下拉选哪一档：读数里没有这个键的值时一档都不落（留空），不去摆第一档。
 *
 * 受控 select 在 `value` 对不上任何一枚 option 时由浏览器自己回落选第一枚——`worktree_mode` 就
 * 落成 `off`、`test_tier` 落成 `full`，正好是两个键的出厂默认词，读者分不出「记录里没有」与
 * 「记录里就是 off / full」。没有的东西不画：这里把那一手挡在前面，没有值就留空。值在读数里、
 * 只是不在候选表里（工具那一侧加了词）时不藏它，把它自己补成一档摆出来，读数与记录一致。
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

export function clampConfigWidth(px: number): number {
  return Math.round(Math.max(CONFIG_WIDTH_MIN, Math.min(CONFIG_WIDTH_MAX, px)))
}