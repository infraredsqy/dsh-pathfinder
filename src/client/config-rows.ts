/**
 * The reading face of the settings view: how known keys are described (display name, caption,
 * control kind, a copy of the dropdown candidates); the rows themselves grow out of the
 * `pf config list` reading.
 *
 * No JSX and no DOM here, so it can be measured standalone where no browser is installed. The tool
 * is the single source of settings keys, so this file does not declare "which keys the tool has":
 * every key in the reading gets a row — registered keys are described per this table, unregistered
 * ones show the key name directly with a text box; keys absent from the reading get no row here —
 * nothing is drawn for what does not exist.
 */
import type { ConfigEntry, ConfigLayer } from '../host/project-config.ts'

export type ControlKind = 'pick' | 'num' | 'toggle' | 'text'

export interface ConfigRow {
  readonly key: string
  readonly name: string
  readonly caption: string
  readonly kind: ControlKind
  /** Only the dropdown kind has it: the words the tool accepts, in blueprint order. */
  readonly options?: readonly string[]
}

/**
 * How known keys are described, in the order readers meet them (blueprint order). The tool only
 * mentions its accepted values in the prose of `config --help`, with no machine-readable list, so
 * the candidates are copied here. When the tool side adds a word, the reading will carry an
 * off-table value; {@link pickState} then promotes it to an option on the spot instead of silently
 * falling to the first one.
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

/** The caption under unregistered keys: the key name is already in the name cell, so this only says who judges the value. */
const UNREGISTERED_CAPTION = '这一键还没有它的说法，值合不合法由工具判'

/**
 * Grow this view's rows out of a reading: only keys present in the reading get rows, none are added.
 *
 * Registered keys are laid out per {@link KNOWN_CONFIG_ROWS}, in its order too (the blueprint
 * order, the layout readers recognize — it does not wobble with the order the tool prints);
 * unregistered keys follow, in reading order, showing the key name directly with a text box — the
 * write side does not filter keys, and the tool judges whether a value is valid.
 * @param entries - The key to "value + layer" table read out of `pf config list`.
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
  /** The option that should be selected; an empty string when nothing matches (left blank). */
  readonly value: string
  /** The off-table entry: a value present in the reading but not in the table, promoted to an option; `null` when none. */
  readonly extra: string | null
}

/**
 * Which dropdown option to pick: when the reading has no value for the key, none is chosen (left
 * blank) rather than defaulting to the first option.
 *
 * A controlled select with a `value` matching no option falls back to the first one by the
 * browser's own hand — `worktree_mode` would land on `off` and `test_tier` on `full`, exactly the
 * two keys' factory default words, leaving the reader unable to tell "absent from the record" from
 * "the record says off / full". Nothing is drawn for what does not exist: this function blocks that
 * move up front, leaving the select blank when there is no value. When the value exists in the
 * reading but not in the candidate table (the tool side added a word), it is not hidden: it is
 * promoted to an option on the spot, keeping the view consistent with the record.
 */
export function pickState(entry: ConfigEntry | undefined, options: readonly string[]): PickState {
  const value = entry?.value ?? ''
  if (value.length === 0) return { value: '', extra: null }
  return options.includes(value) ? { value, extra: null } : { value, extra: value }
}

/** The three words for the layer tag at the end of a row. The default layer reads as "default": the factory copy nobody has changed. */
export const LAYER_WORDS: Readonly<Record<ConfigLayer, string>> = {
  default: '默认',
  project: '本项目',
  global: '全局',
}

/** That column's width bounds, default, and two step sizes, per the blueprint. */
export const CONFIG_WIDTH = 720
export const CONFIG_WIDTH_MIN = 480
export const CONFIG_WIDTH_MAX = 960
export const CONFIG_WIDTH_STEP = 24
export const CONFIG_WIDTH_BIG = 48

export function clampConfigWidth(px: number): number {
  return Math.round(Math.max(CONFIG_WIDTH_MIN, Math.min(CONFIG_WIDTH_MAX, px)))
}