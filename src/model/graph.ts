/**
 * 依赖那一份读数：谁挡着谁。
 *
 * 一格的层号取最长路：它站在它最深的前置右边一层。记录里点到一个已经不在册的依赖，这里跳过
 * 它，摆不出来的前置挡不住任何人；数据里绕成一个环，走回自己那一格时就停手。
 */
import type { DepsWord, GraphEdge, GraphReading, NodeReading } from './contract.ts'

/**
 * 读那一刻的依赖场。
 * @param nodes - 那一刻的节点读数，按记录里的顺序。
 * @returns 分层、边、以及最深的那一层。
 */
export function readGraph(nodes: readonly NodeReading[]): GraphReading {
  const depends = new Map<string, readonly string[]>()
  for (const node of nodes) depends.set(node.id, node.dependencies)

  const depth = new Map<string, number>()
  const walking = new Set<string>()

  const depthOf = (id: string): number => {
    const held = depth.get(id)
    if (held !== undefined) return held
    if (walking.has(id)) return 0
    walking.add(id)
    let deepest = 0
    for (const dependency of depends.get(id) ?? []) {
      if (!depends.has(dependency)) continue
      deepest = Math.max(deepest, depthOf(dependency) + 1)
    }
    walking.delete(id)
    depth.set(id, deepest)
    return deepest
  }

  let maxDepth = -1
  for (const node of nodes) maxDepth = Math.max(maxDepth, depthOf(node.id))

  const layers: NodeReading[][] = []
  for (let level = 0; level <= maxDepth; level += 1) layers.push([])
  for (const node of nodes) layers[depth.get(node.id) ?? 0]?.push(node)

  const edges: GraphEdge[] = []
  for (const node of nodes) {
    const to = node.id
    for (const from of node.dependencies) {
      if (!depends.has(from)) continue
      edges.push({ from, to, span: (depth.get(to) ?? 0) - (depth.get(from) ?? 0) })
    }
  }

  return { layers, maxDepth, edges }
}

/**
 * 一格在依赖场上该说哪一句话：可开工，或者还欠几件前置。
 *
 * 可开工只认读数自己那一个值——进行中的一格状态也是 `todo`、欠的前置也可能一件不剩，照
 * 别的字段拼就会把别人手里正做的那一格印成可开工。落定的、进行中的、放下的不欠这个问题，
 * 什么都不说。
 * @param node - 那一刻的一格读数。
 * @returns 那句话；这一格不欠这个问题就是 `null`。
 */
export function depsWord(node: NodeReading): DepsWord | null {
  if (node.ready) return { word: '可开工', ready: true, count: null }
  if (node.state !== 'todo' || node.running || node.openDependencies.length === 0) return null
  return { word: `前置节点 ${String(node.openDependencies.length)} 个`, ready: false, count: node.openDependencies.length }
}