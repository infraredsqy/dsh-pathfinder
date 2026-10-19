/**
 * 一格的名字与把手：面板的卡与行、依赖那一格的记号与卡，吃的是同一副读数、印的是同一副名字。
 */
import type { NodeReading } from '../model/index.ts'

/** 身份的短写：八字。 */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** 一格的标题：记录里那段标题；记录里没写标题的格才轮到身份的短写。 */
export function nodeName(node: NodeReading): string {
  return node.title ?? shortId(node.id)
}

/** 一格的悬停：全名，后面跟一段八字把手；名字本身就是那八个字时不重复一遍。 */
export function nodeHover(node: NodeReading): string {
  const short = shortId(node.id)
  return node.title === undefined || node.title === short ? nodeName(node) : `${node.title} · ${short}`
}
