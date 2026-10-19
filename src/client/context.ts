/**
 * 三个入口（插件入口、设置那一节、调度中心那两处）共用的装配件：DSH 插件上下文上这一层摸得到
 * 的那几手、装配出岔子时那一声警告，以及「等服务到场再挂」的那一套样板。
 *
 * 服务都用动态的 `ctx.inject([...])` 等：槽位由别人在运行时声明，往还没声明的槽里注册会在加载
 * 时直接抛。取不到就安静地不做——这一层从不把插件的 `apply` 弄挂，wire 里抛的每一手都挡在
 * 自己那一层，只留一条可查的痕迹。
 */

/** 插件上下文上这一层用得到的那几手。 */
export interface ClientContext {
  inject?: (names: readonly string[], callback: (owner: unknown) => void) => unknown
}

/** 槽位服务：往别人声明的槽里注册的那条口子。 */
export interface SlotsService {
  inject?: (key: string, register: () => unknown) => unknown
  register?: (options: unknown, component: unknown) => unknown
}

/** 带卸载通知的上下文：真 Cordis 的上下文都带 `effect`，替身上下文没有。 */
export interface EffectOwner {
  effect?: (run: () => () => void, name?: string) => unknown
}

/** 一条警告；装配出了岔子不该静悄悄。 */
export function report(what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  // eslint-disable-next-line no-console -- 装配失败必须留下一条可查的痕迹
  console.warn(`dsh-pathfinder: ${what}：${message}`)
}

/**
 * 等那几个名字到场，再把到手的东西交给 wire。
 *
 * `what` 是这一路装配说自己的名字：wire 里抛的、`inject` 本身抛的，都用它留那一声警告。
 * @param ctx - 浏览器半身那一个插件上下文。
 * @param names - 要等的服务名。
 * @param what - 出岔子时警告里那一句话。
 * @param wire - 服务到场后怎么接；抛了不外泄。
 */
export function injectAt(ctx: unknown, names: readonly string[], what: string, wire: (owner: unknown) => void): void {
  const holder = ctx as ClientContext | null | undefined
  if (holder === null || holder === undefined || typeof holder.inject !== 'function') return
  try {
    holder.inject(names, (owner) => {
      try {
        wire(owner)
      } catch (error) {
        report(what, error)
      }
    })
  } catch (error) {
    report(what, error)
  }
}

/**
 * 同一条注册挂到 owner 自己那条 `effect` 上：有就挂（清理随卸载跑），没有就当场跑——
 * 没有 `effect` 的上下文没人替它管卸载，那一手也无处可交。
 */
export function serveOn(owner: unknown, serve: () => () => void, name: string): void {
  const effect = (owner as EffectOwner).effect
  if (typeof effect === 'function') effect.call(owner, serve, name)
  else serve()
}
