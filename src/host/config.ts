/**
 * 这一行插件行自己的设置 schema。
 *
 * schemastery 由宿主提供，取法走动态 import：本机没摆那份包时整个模块照样装得上，
 * 只是 DSH 不会把这一行暴露成设置命名空间，读面与面板都在。
 */
import type { Schema, Schemastery } from '@deepseek-ai/schemastery'
import {
  INFO_LEVELS,
  PANEL_PREF_DEFAULTS,
  PANEL_PREF_FIELDS,
  SIDE_MAX,
  SIDE_MIN,
  VIEW_IDS,
} from './settings-fields.ts'

/** 宿主提供的那份 schemastery；本机没摆它时是 `null`。 */
const schemastery: Schemastery | null = await import('@deepseek-ai/schemastery').then(
  (module) => module.default,
  () => null,
)

/**
 * 照那一份字段表建出这一行的设置 schema。拆成一个函数是为了能单独量：真正跑起来时进来的
 * 就是宿主提供的那份 schemastery。
 *
 * 每个字段都标 volatile：设置服务只投影 volatile 字段，一个都没有的条目在设置里干脆
 * 看不见，而多标一个不犯错。老副本（3.18.1 那一档）没有 `.volatile()`，在它上面调用会把
 * 模块的求值过程整个打断、连读面一起带走，所以先探一次——探不到就把字段原样交出去，
 * 代价只是设置页里看不见。
 * @param z - 一份 schemastery。
 * @returns 对象节点，字段名与出厂默认都来自 `settings-fields.ts` 那一份表。
 */
export function buildConfig(z: Schemastery): Schema<Record<string, unknown>> {
  const canMark = typeof z.boolean().volatile === 'function'
  const live = <T extends Schema>(field: T): T => (canMark ? (field.volatile() as T) : field)
  return z.object({
    [PANEL_PREF_FIELDS.sideWidth]: live(
      z.number().min(SIDE_MIN).max(SIDE_MAX).default(PANEL_PREF_DEFAULTS.sideWidth),
    ),
    [PANEL_PREF_FIELDS.infoLevel]: live(
      z.union(INFO_LEVELS).default(PANEL_PREF_DEFAULTS.infoLevel),
    ),
    [PANEL_PREF_FIELDS.defaultTab]: live(
      z.union(VIEW_IDS).default(PANEL_PREF_DEFAULTS.defaultTab),
    ),
    [PANEL_PREF_FIELDS.showArchived]: live(
      z.boolean().default(PANEL_PREF_DEFAULTS.showArchived),
    ),
    [PANEL_PREF_FIELDS.showOtherStates]: live(
      z.boolean().default(PANEL_PREF_DEFAULTS.showOtherStates),
    ),
  })
}

/**
 * 这一行的设置 schema：字段名与出厂默认都从 {@link PANEL_PREF_FIELDS} /
 * {@link PANEL_PREF_DEFAULTS} 来，所以设置页里的行、写回时的路径、面板读回来的键处处
 * 对得上。
 *
 * 宿主没摆 schemastery 时它是 `undefined`——DSH 照这一条认出「没有表单」，这一行也就不
 * 占设置里的位置。
 */
export const Config: Schema<Record<string, unknown>> | undefined = schemastery === null
  ? undefined
  : buildConfig(schemastery)