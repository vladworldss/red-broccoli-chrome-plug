import { compareByTimeThenImportance, type Concept } from './Concept'
import type { ConceptMap } from './ConceptMap'

export type ConceptRef = { id: string; term: string }

export type TreeNode = {
  concept: Concept
  /** Prerequisites (`this requires X`), shown as annotations, not as tree edges. */
  requires: ConceptRef[]
  children: TreeNode[]
}

export type ConceptTree = { topic: string; roots: TreeNode[] }

/**
 * Projects the concept DAG onto a reading tree.
 *
 *  - Each concept gets at most ONE parent: among its `part-of` targets, the
 *    most important one (ties: earliest, then id) — "the strongest part-of".
 *  - Cycles (A part-of B part-of A — LLMs do produce these) are broken by
 *    detaching the most important concept on the cycle, which becomes a root.
 *  - `requires` edges never shape the tree; they ride along as annotations.
 *  - Siblings are ordered by first appearance in the video, then importance.
 *
 * Every concept appears exactly once.
 */
export function toTree(map: ConceptMap): ConceptTree {
  const byId = new Map(map.concepts.map((c) => [c.id, c]))

  const parentOf = new Map<string, string>()
  for (const c of map.concepts) {
    const candidates = map.relations
      .filter((r) => r.type === 'part-of' && r.from === c.id)
      .map((r) => byId.get(r.to))
      .filter((p): p is Concept => !!p)
      .sort(strongestFirst)
    if (candidates[0]) parentOf.set(c.id, candidates[0].id)
  }

  breakCycles(map.concepts, parentOf, byId)

  const requiresOf = new Map<string, ConceptRef[]>()
  for (const r of map.relations) {
    if (r.type !== 'requires') continue
    const target = byId.get(r.to)
    if (!target) continue
    const list = requiresOf.get(r.from) ?? []
    list.push({ id: target.id, term: target.term })
    requiresOf.set(r.from, list)
  }

  const nodes = new Map<string, TreeNode>()
  for (const c of map.concepts) {
    nodes.set(c.id, { concept: c, requires: requiresOf.get(c.id) ?? [], children: [] })
  }

  const roots: TreeNode[] = []
  for (const c of [...map.concepts].sort(compareByTimeThenImportance)) {
    const node = nodes.get(c.id)!
    const p = parentOf.get(c.id)
    const parent = p ? nodes.get(p) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  return { topic: map.topic || map.title, roots }
}

function strongestFirst(a: Concept, b: Concept): number {
  if (a.importance !== b.importance) return b.importance - a.importance
  return compareByTimeThenImportance(a, b)
}

function breakCycles(
  concepts: readonly Concept[],
  parentOf: Map<string, string>,
  byId: Map<string, Concept>,
): void {
  for (const start of concepts) {
    // Re-walk from the same start after each cut: there may be more cycles.
    for (;;) {
      const path: string[] = []
      const onPath = new Set<string>()
      let cur: string | undefined = start.id
      while (cur !== undefined && !onPath.has(cur)) {
        onPath.add(cur)
        path.push(cur)
        cur = parentOf.get(cur)
      }
      if (cur === undefined) break // reached a root: no cycle on this walk
      const cycle = path.slice(path.indexOf(cur))
      const victim = cycle.map((id) => byId.get(id)!).sort(strongestFirst)[0]!
      parentOf.delete(victim.id)
    }
  }
}

/** Depth-first flattening, handy for exporters and tests. */
export function walkTree(tree: ConceptTree, visit: (node: TreeNode, depth: number) => void): void {
  const go = (n: TreeNode, d: number) => {
    visit(n, d)
    for (const c of n.children) go(c, d + 1)
  }
  for (const r of tree.roots) go(r, 0)
}
