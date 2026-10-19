/**
 * 这个工作区的项目设置：工具那一条命令印出来的四行，读成一份读数。
 *
 * 有效值与「它来自哪一层」只有工具知道（全局那一层住在家目录里，工作区文件口子看不进去），
 * 所以这一份只把 `pf config list` 印出来的每一行读开，不做第二套判断。
 */

/**
 * 设置的键，与工具那一侧 `CONFIG_SPEC` 的键逐字相同。
 *
 * 写面按这张表放行：不认得的键不往命令行上递。这张表不管取值，一个值合不合法由工具自己判
 * （它那一份 `parse_value` 是唯一的判据），这里不抄第二份，抄了就会跟它漂移。
 */
export const CONFIG_KEYS = ['max_agents', 'test_tier', 'worktree_mode', 'issue_repair'] as const

export type ConfigKey = (typeof CONFIG_KEYS)[number]

/** 一个值实际住在哪一层。 */
export type ConfigLayer = 'default' | 'project' | 'global'

/** 一层覆盖在工具印的那一行里长什么样：按头两个字认；读不懂的层名不给层签，不替工具编一个它没说的读数。 */
const LAYER_HEADS: readonly (readonly [ConfigLayer, string])[] = [
  ['default', '出厂默认'],
  ['project', '项目 '],
  ['global', '全局 '],
]

/**
 * 那一行。键名是字母数字下划线，值在等号与全角括号之间，层名在括号里、自己不含括号。
 *
 * 值那一格用非贪婪：`worktree_mode = off` 这种值里没有空格，但真出现带空格的值时，尾巴上
 * 那个「空格 + 全角括号」才是分隔，贪婪那一版会把值一路吃到最后一个括号之前。
 */
const CONFIG_LINE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*（([^（）]*)）\s*$/u

/** 一行读出来的东西。 */
export interface ConfigEntry {
  /** 工具印的有效值。 */
  readonly value: string
  /** 这个值住哪一层；层名读不懂时是 `null`。 */
  readonly layer: ConfigLayer | null
}

/**
 * 一份项目设置的读数。
 *
 * `ok` 说的是工具这一趟成了没有（命令没起来、退出码非 0）；读面自己取不到数时另有一层
 * 失败（那一层由调用方按抛处置）。工具没成时 `entries` 是空的，面板照「记录里没有」画。
 */
export interface PathfinderConfigReading {
  /** 这次读的绝对工作区根，与四份记录那份读数同一个名字；设置落在它那份记录里。 */
  readonly workspaceRoot: string
  readonly ok: boolean
  /** 工具原话；没成时就是它给的那个理由。 */
  readonly text: string
  /** 印出来的每一行，键就是设置键。没印出来的键不在这里。 */
  readonly entries: Readonly<Record<string, ConfigEntry>>
}

/** 层名读成一层；读不懂给 `null`。 */
function layerOf(word: string): ConfigLayer | null {
  const head = LAYER_HEADS.find(([, text]) => word === text || word.startsWith(text))
  return head === undefined ? null : head[0]
}

/**
 * 把 `pf config list` 印出来的那几行读成一份表。认不出的行跳过（工具另会往那一路印
 * `Warning:` 之类的话，那是别的输出）；一行里的值空着也跳过：值空着就给不出读数。
 * @param text - 命令交回来的正文。
 * @returns 键到「值 + 它住哪一层」的表；一行都认不出时是空的。
 */
export function parseConfigList(text: string): Record<string, ConfigEntry> {
  const out: Record<string, ConfigEntry> = {}
  for (const line of text.split(/\r?\n/u)) {
    const matched = CONFIG_LINE.exec(line)
    if (matched === null) continue
    const [, key, value, layer] = matched
    if (key === undefined || value === undefined || layer === undefined) continue
    if (value.length === 0) continue
    out[key] = { value, layer: layerOf(layer) }
  }
  return out
}