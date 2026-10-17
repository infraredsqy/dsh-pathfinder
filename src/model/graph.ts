/**
 * 依赖那一份读数：谁挡着谁。
 *
 * 一格的层号取**最长路**：它站在它最深的前置右边一层。算这个数只需要记录里的依赖，
 * 不需要版面——所以层与边是记录的性质，画的时候才轮到摆在哪儿。
 *
 * 记录里点到一个已经不在册的依赖，这里跳过它：摆不出来的前置挡不住任何人。数据里要是
 * 绕成一个环，走回自己那一格时就停手——一个环不该把读数绕死。
 *
 * @module dsh-pathfinder/model/graph
 */
import type { GraphEdge, GraphReading, NodeReading } from './contract.ts'

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