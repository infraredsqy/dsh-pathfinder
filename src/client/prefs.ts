/**
 * 面板自己的偏好：一份设置文档，与面板读的那几个值之间的那一层。
 *
 * 面板记着的那几样都住在 Host 的设置文档里（那份 schema 在 `src/host/config.ts`）。这一份把那
 * 一节读成面板要的几个值，把一次改动写成设置服务认的那一个原子动作；读一次坏一次都当作没记过，
 * 面板照出厂那几条站着。
 */
import {
  INFO_LEVELS,
  PANEL_PREF_DEFAULTS,
  PANEL_PREF_FIELDS,
  SIDE_DEFAULT,
  SIDE_MAX,
  SIDE_MIN,
  VIEW_IDS,
} from '../host/settings-fields.ts'
import type { InfoLevel, ViewId } from '../host/settings-fields.ts'

export type { InfoLevel, ViewId }
export { INFO_LEVELS, PANEL_PREF_DEFAULTS, PANEL_PREF_FIELDS, SIDE_DEFAULT, SIDE_MAX, SIDE_MIN, VIEW_IDS }

/** 面板要写回哪一个字段；名字就是设置文档里那几个键。 */
export type PrefField = (typeof PANEL_PREF_FIELDS)[keyof typeof PANEL_PREF_FIELDS]

/** 三档信息量各自印什么字：设置页那一行与面板上那一排钮说的是同一件事。 */
export const INFO_LABELS: Readonly<Record<InfoLevel, string>> = {
  lean: '精简',
  three: '展开',
  full: '铺满',
}

/** 六个看法各自印什么字：标签那一排与设置页那个下拉说的是同一件事。 */
export const VIEW_LABELS: Readonly<Record<ViewId, string>> = {
  now: '当前',
  detail: '明细',
  notes: '指令',
  wires: '依赖',
  issue: '问题',
  config: '设置',
}

export interface PanelPrefs {
  /** 明细左侧线路栏的宽度，像素。 */
  readonly sideWidth: number
  /** 每列几张卡。 */
  readonly info: InfoLevel
  /** 面板露面时停在哪个看法。 */
  readonly tab: ViewId
  /** 指令那一格要不要把已归档的条目放回各自的段里。 */
  readonly archived: boolean
  /** 问题那一格要不要把已经处置过的那三个状态也放回页面上。 */
  readonly otherStates: boolean
}

export const DEFAULT_PREFS: PanelPrefs = {
  sideWidth: PANEL_PREF_DEFAULTS.sideWidth,
  info: 'three',
  tab: 'now',
  archived: false,
  otherStates: false,
}

export function clampSide(px: number): number {
  return Math.round(Math.max(SIDE_MIN, Math.min(SIDE_MAX, px)))
}

/** 面板自己的旧键：存量的浏览器里可能还留着，接上设置表单那一刻扫掉它们。 */
export const LEGACY_PREF_KEYS: readonly string[] = [
  'dsh-pathfinder.sideWidth',
  'dsh-pathfinder.infoLevel',
  'dsh-pathfinder.defaultTab',
  'dsh-pathfinder.showOtherStates',
]

/** 本地存储那一手：这一层只用到删，读与写一条都不用。 */
export interface PrefStorage {
  removeItem(key: string): unknown
}

/**
 * 把旧版那几个键从本地存储里扫掉。只删不读：里面存的什么都不作数，值一律从设置文档来。
 *
 * 本地存储不可用（这个环境里没有它、被策略挡住、`removeItem` 自己抛）时安静算了：偏好清理不该
 * 把面板弄坏。
 * @param storage - 本地存储；不给就问当前环境的 `localStorage`。
 */
export function dropLegacyPrefs(storage?: PrefStorage | null): number {
  let held = storage
  if (held === undefined) {
    try {
      held = (globalThis as { localStorage?: PrefStorage | null }).localStorage ?? null
    } catch (error) {
      held = null
    }
  }
  if (held === null || held === undefined || typeof held.removeItem !== 'function') return 0
  let dropped = 0
  for (const key of LEGACY_PREF_KEYS) {
    try {
      held.removeItem(key)
      dropped += 1
    } catch (error) {
      /* 这一个删不掉就算了，别让它带倒其余的。 */
    }
  }
  return dropped
}

/**
 * 把设置文档的这一节读成面板要的那几个值。
 *
 * 一个字段读不懂就它自己退到出厂那一份，别的照读：设置文档是别处写进去的，里面可能留着旧版本
 * 写下的词，也可能什么都没有。
 * @param section - 那一节，形状不保证。
 */
export function prefsFromSection(section: unknown): PanelPrefs {
  const held = (typeof section === 'object' && section !== null ? section : {}) as Readonly<Record<string, unknown>>
  const width = held[PANEL_PREF_FIELDS.sideWidth]
  const info = held[PANEL_PREF_FIELDS.infoLevel]
  const tab = held[PANEL_PREF_FIELDS.defaultTab]
  return {
    sideWidth: typeof width === 'number' && Number.isFinite(width) ? clampSide(width) : DEFAULT_PREFS.sideWidth,
    info: INFO_LEVELS.includes(info as InfoLevel) ? (info as InfoLevel) : DEFAULT_PREFS.info,
    tab: VIEW_IDS.includes(tab as ViewId) ? (tab as ViewId) : DEFAULT_PREFS.tab,
    archived: held[PANEL_PREF_FIELDS.showArchived] === true,
    otherStates: held[PANEL_PREF_FIELDS.showOtherStates] === true,
  }
}

/** 设置服务认的那一个原子动作：顶层路径上的一次 `set`。 */
export interface PrefsWriteOp {
  readonly op: 'set'
  readonly path: readonly string[]
  readonly value: unknown
}

/**
 * 一次改动写成设置服务认的那一个原子动作。
 *
 * 路径只有一段，因为这一节里五个字段都摆在最外面——设置服务照路径判断这个字段认不认，多一段少
 * 一段都落不到地方。
 */
export function prefsWriteOp(field: PrefField, value: unknown): PrefsWriteOp {
  return { op: 'set', path: [field], value }
}

/** 一份设置文档里这一节的读数；设置表单那一侧交出来的就是这一副脸。 */
export interface PrefsFormSnapshot {
  /** `loading` / `ready` / `unavailable`，设置表单自己那几个词。 */
  readonly status?: string | undefined
  readonly value?: unknown
  /** 命名空间的修订号：写回时带上它做凭据。 */
  readonly revision?: number | undefined
  readonly writable?: boolean | undefined
}

export interface PrefsForm {
  getSnapshot(): PrefsFormSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly PrefsWriteOp[], revision?: number): Promise<boolean>
}

/**
 * 面板读到的那一份读数。
 *
 * `prefs` 只在值真的动了的时候换一个新的对象：`useSyncExternalStore` 拿它比前后两次，每次读都
 * 新造一个的话，面板会一直重画。
 */
export interface PrefsSnapshot {
  readonly prefs: PanelPrefs
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly revision: number | undefined
  readonly writable: boolean
  /**
   * 上一笔写回没能落定时给人看的一句话；写完一笔、或换掉那份表单之后回到 `null`。
   *
   * 设置表单被拒时只交回一个 `false`，理由吞在它自己那里——面板那几处 `void store.write(…)` 又
   * 把这个 `false` 丢掉，读者的观感是控件静默弹回。这一格就是那条不许静默的路。
   */
  readonly failure: string | null
}

export interface PrefsSource {
  subscribe(listener: () => void): () => void
  getSnapshot(): PrefsSnapshot
  /** 把一条改动递出去；这条口子上没有设置服务时给 `false`，不抛。 */
  write(field: PrefField, value: unknown): Promise<boolean>
}

/** 设置服务接进来之后挂得上：面板从第一帧起就有一条口子可读。 */
export interface PrefsStore extends PrefsSource {
  /** 接上（或换掉）那一份设置表单；`null` 表示这一份先收掉。 */
  attach(form: PrefsForm | null): () => void
}

const UNAVAILABLE: PrefsSnapshot = Object.freeze({
  prefs: DEFAULT_PREFS,
  status: 'unavailable',
  revision: undefined,
  writable: false,
  failure: null,
})

/** 两笔都作了废时摆出来的那一句话。 */
const WRITE_FAILED = '保存失败：设置服务没有接受这次改动。'

/** 两条读数说的是不是同一件事：值逐项比，别的照原样。 */
function sameSnapshot(left: PrefsSnapshot, right: PrefsSnapshot): boolean {
  return left.status === right.status
    && left.revision === right.revision
    && left.writable === right.writable
    && left.failure === right.failure
    && samePrefs(left.prefs, right.prefs)
}

/** 面板读的那几个值说的是不是同一件事：逐项比，不认对象身份。 */
function samePrefs(left: PanelPrefs, right: PanelPrefs): boolean {
  return left.sideWidth === right.sideWidth
    && left.info === right.info
    && left.tab === right.tab
    && left.archived === right.archived
    && left.otherStates === right.otherStates
}

/**
 * 那条口子本身。
 *
 * 它先站着（出厂那几条），等设置服务到了再挂上去：这样面板不必等谁准备好才开始画，而设置一到，
 * 订阅者当场收到一条新读数。
 */
export function createPrefsSource(): PrefsStore {
  const listeners = new Set<() => void>()
  let form: PrefsForm | null = null
  let off: (() => void) | null = null
  let snapshot: PrefsSnapshot = UNAVAILABLE

  const announce = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        /* 一个订阅者出了岔子，别把其余的也带下水。 */
      }
    }
  }

  /** 换掉「上一笔没落定」那一句话；写成功、换表单、摘表单都会把它收回去。 */
  const setFailure = (message: string | null): void => {
    if (snapshot.failure === message) return
    snapshot = { ...snapshot, failure: message }
    announce()
  }

  /** 把表单那一刻的读数折成这一条口子的读数，值没动就不惊动订阅者。 */
  const derive = (): void => {
    let next = UNAVAILABLE
    if (form !== null) {
      try {
        const held = form.getSnapshot()
        next = {
          prefs: prefsFromSection(held.value),
          status: held.status === 'ready' ? 'ready' : held.status === 'loading' ? 'loading' : 'unavailable',
          revision: typeof held.revision === 'number' ? held.revision : undefined,
          writable: held.writable === true,
          /* 这一趟折的是那份文档本身，上一笔没落定那句话留着，直到有一笔真的写成。 */
          failure: snapshot.failure,
        }
      } catch (error) {
        next = UNAVAILABLE
      }
    }
    if (sameSnapshot(snapshot, next)) return
    snapshot = next
    announce()
  }

  const detach = (): void => {
    const held = off
    off = null
    form = null
    if (held === null) return
    try {
      held()
    } catch (error) {
      /* 摘不掉就算了，读数已经交回出厂那一份。 */
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    attach(next) {
      detach()
      if (next === null) {
        derive()
        return () => undefined
      }
      form = next
      dropLegacyPrefs()
      try {
        off = next.subscribe(derive)
      } catch (error) {
        off = null
      }
      derive()
      return () => {
        if (form === next) detach()
      }
    },
    write(field, value) {
      const held = form
      if (held === null) return Promise.resolve(false)
      const ops = [prefsWriteOp(field, value)]
      /** 这一笔的最后结局：落定了就把那句话收回去，两笔都不作数就把它摆出来。 */
      const settle = (accepted: boolean): boolean => {
        setFailure(accepted ? null : WRITE_FAILED)
        return accepted
      }
      /** 被拒之后的那一次：把修订号围栏摘掉，让控制器自己取当下最新那一个。 */
      const again = (): Promise<boolean> => {
        try {
          return Promise.resolve(held.mutate(ops)).then(
            (accepted) => settle(accepted === true),
            () => settle(false),
          )
        } catch (error) {
          return Promise.resolve(settle(false))
        }
      }
      try {
        /* 头一次带上读到的修订号。同一趟往返里的第二笔读到的还是上一笔落定前的号码，宿主照那道
         * 围栏把这一笔拒掉，于是摘掉围栏再走一次；这一趟仍不作数时 `settle` 会把话摆到读数里。 */
        return Promise.resolve(held.mutate(ops, snapshot.revision)).then(
          (accepted) => (accepted === true ? settle(true) : again()),
          () => again(),
        )
      } catch (error) {
        return again()
      }
    },
  }
}

/** 设置服务一直没到场时面板读的那一份：出厂那几条，写回一律不作数。 */
export const DEFAULT_SOURCE: PrefsSource = createPrefsSource()