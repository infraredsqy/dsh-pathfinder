/**
 * A cell's name and handle: the panel's cards and rows and the dependency cell's marks and cards
 * consume the same reading and print the same names.
 */
import type { NodeReading } from '../model/index.ts'

/** Short form of the identity: first 8 chars. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** A cell's title: the record's title; the short id only for cells whose record has no title. */
export function nodeName(node: NodeReading): string {
  return node.title ?? shortId(node.id)
}

/** A cell's hover text: full name followed by the 8-char handle; skipped when the name is that handle. */
export function nodeHover(node: NodeReading): string {
  const short = shortId(node.id)
  return node.title === undefined || node.title === short ? nodeName(node) : `${node.title} · ${short}`
}
