/**
 * 记录里的字段：原样读出来，再按「读到哪一刻」切。
 *
 * 时刻是记录里原样的那串文本，这里一个都不换算、不改写；读不出来（没写、或者不是一刻）就
 * 是**没有那一刻**，给 `null`。没有那一刻的地方不留 0，也不补一个默认值。
 *
 * @module dsh-pathfinder/model/fields
 */

/** 记录里那个字段真写了一串字时给出来；别的写法都当作没写。 */
export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 把记录里的时刻读成一个时刻。
 * @param raw - 记录里那串文本，原样。
 * @returns 读得出来就是那一刻；没写或读不出来就是 `null`。
 */
export function toMoment(raw: unknown): Date | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? null : new Date(ms)
}

/**
 * 那一刻到了没。
 * @param moment - 记录里那一刻；没有就是 `false`。
 * @param at - 读到哪一刻。
 */
export function happenedAt(moment: Date | null, at: Date): boolean {
  return moment !== null && moment.getTime() <= at.getTime()
}

/**
 * 按那一刻切一下：那一刻已经到了就是它，还没到就当作**没有那一刻**。
 *
 * 同一个字段写在记录里，说的可能是读到的那一刻还没发生的事。那时候读数里不该出现一个还
 * 没发生的时刻。
 * @param moment - 记录里那一刻。
 * @param at - 读到哪一刻。
 */
export function cutAt(moment: Date | null, at: Date): Date | null {
  return happenedAt(moment, at) ? moment : null
}

/**
 * 那一刻这个词写下来了没：记最后改动时刻的那种字段用得上。
 *
 * 记录自己的词是它自己写的，写在哪一刻只有它自己的最后改动时刻能说。没记这个时刻就当它
 * 早就写下来了；缺一个字段不能把记录自己说的话丢掉。
 * @param moment - 记录里那个最后改动时刻。
 * @param at - 读到哪一刻。
 */
export function writtenBy(moment: Date | null, at: Date): boolean {
  return moment === null || moment.getTime() <= at.getTime()
}

/**
 * 两个时刻之间过了多少秒。
 * @returns 两端有一个没有那一刻就是 `null`：没有那一刻，就没有时长。
 */
export function secondsBetween(from: Date | null, to: Date | null): number | null {
  if (from === null || to === null) return null
  return Math.round((to.getTime() - from.getTime()) / 1000)
}