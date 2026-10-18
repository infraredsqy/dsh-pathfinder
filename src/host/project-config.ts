/**
 * 这个工作区的项目设置：工具那一条命令印出来的四行，读成一份读数。
 *
 * 值住三层——出厂默认、全局 `~/.pf/config.json`、项目 `<项目>/.pf/config.json`，越靠后越赢。
 * 有效值与「它来自哪一层」这两件事只有工具知道：全局那一层住在家目录里，工作区文件口子看不
 * 进去；`worktree_mode` 的出厂默认还要问一句这个项目是不是 git 检出。所以这一份不做第二套
 * 判断，只把 `pf config list` 印出来的每一行读开。
 *
 * 那一行长这样（`key` 左对齐补到最长的键，等号两边各一个空格，括号是全角的）：
 *
 * ```
 * max_agents    = 1（项目 .pf/config.json）
 * ```
 *
 * 括号里那串字是**给**人读的层名，工具那一侧由 `LAYER_LABELS` 一处写全。这里按它的头两个字
 * 认层（`出厂默认` / `项目 …` / `全局 …`），不认得的层名留着那一行、只是不给层签：读不懂的
 * 层名硬按一个层报出去，等于替工具编了一个它没说的读数。
 *
 * 这一份不认键表：工具印什么就收什么（键名由它自己那一份 `CONFIG_SPEC` 定）。要写的那几个
 * 键另有一张表（{@link CONFIG_KEYS}），写在这里是给写面当闸用。
 *
 * @module dsh-pathfinder/host/project-config
 */

/**
 * 设置的键，与工具那一侧 `CONFIG_SPEC` 的键逐字相同。
 *
 * 写面按这张表放行：不认得的键不往命令行上递。这张表**不管取值**——一个值合不合法由工具
 * 自己判（它那一份 `parse_value` 是唯一的判据），这里不抄第二份，抄了就会跟它漂移。
 */
export const CONFIG_KEYS = ['max_agents', 'test_tier', 'worktree_mode', 'issue_repair'] as const

/** 这张表里的一个键。 */
export type ConfigKey = (typeof CONFIG_KEYS)[number]

/** 一个值实际住在哪一层。 */
export type ConfigLayer = 'default' | 'project' | 'global'

/** 一层覆盖在工具印的那一行里长什么样：按头两个字认。 */
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
  /** 工具印的有效值，原样那串字。 */
  readonly value: string
  /** 这个值住哪一层；层名读不懂时是 `null`。 */
  readonly layer: ConfigLayer | null
}

/**
 * 一份项目设置的读数。
 *
 * `ok` 说的是**工具这一趟成了没有**（命令没起来、退出码非 0）；读面自己取不到数时另有一层
 * 失败（那一层由调用方按抛处置）。工具没成时 `entries` 是空的，面板照「记录里没有」画。
 */
export interface PathfinderConfigReading {
  /** 命令跑在哪个根上——这个项目的根，也是设置落在哪一份记录里的那个根。 */
  readonly project: string
  /** 工具这一趟成了没有。 */
  readonly ok: boolean
  /** 工具原话；没成时就是它给的那个理由。 */
  readonly text: string
  /** 印出来的每一行，键就是设置键。没印出来的键不在这里。 */
  readonly entries: Readonly<Record<string, ConfigEntry>>
}

/**
 * 层名读成一层。
 * @param word - 括号里那串字。
 * @returns 那一层；读不懂给 `null`。
 */
function layerOf(word: string): ConfigLayer | null {
  const head = LAYER_HEADS.find(([, text]) => word === text || word.startsWith(text))
  return head === undefined ? null : head[0]
}

/**
 * 把 `pf config list` 印出来的那几行读成一份表。
 *
 * 认不出的行跳过（工具另会往那一路印 `Warning:` 之类的话，它们不是设置行）；一行里的值空着
 * 也跳过：没有值的设置不是一条读数。
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