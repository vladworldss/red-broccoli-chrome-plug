import {
  compareByTimeThenImportance,
  normalizeTerm,
  slugify,
  type Concept,
  type RawConcept,
} from './Concept'

/**
 * Merges concepts proposed across chunks (or repeated within one) into one
 * entry per idea. Two raw concepts are the same idea when any of their
 * normalized terms/aliases coincide — transitively, via union-find, so
 * "f'(x)" ↔ "derivative" ↔ "derivatives" all collapse together.
 *
 * The merged concept takes its term and definition from the most important
 * member (ties: earliest seen), the EARLIEST timestamp of any member, the
 * highest importance, and the union of every other spelling as aliases.
 */
export function mergeConcepts(raws: readonly RawConcept[]): Concept[] {
  const parent = raws.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!
      i = parent[i]!
    }
    return i
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }

  const owner = new Map<string, number>()
  raws.forEach((r, i) => {
    for (const key of keysOf(r)) {
      const prev = owner.get(key)
      if (prev === undefined) owner.set(key, i)
      else union(prev, i)
    }
  })

  const groups = new Map<number, number[]>()
  raws.forEach((_, i) => {
    const root = find(i)
    const g = groups.get(root)
    if (g) g.push(i)
    else groups.set(root, [i])
  })

  const usedIds = new Set<string>()
  const merged: Concept[] = []
  for (const members of groups.values()) {
    const items = members.map((i) => raws[i]!)
    const lead = items.reduce((best, r) => (r.importance > best.importance ? r : best))
    const leadKey = normalizeTerm(lead.term)

    const aliases: string[] = []
    const aliasKeys = new Set<string>([leadKey])
    for (const r of items) {
      for (const a of [r.term, ...r.aliases]) {
        const k = normalizeTerm(a)
        if (!k || aliasKeys.has(k)) continue
        aliasKeys.add(k)
        aliases.push(a)
      }
    }

    const times = items.map((r) => r.t).filter((t): t is number => t !== null)
    const definition =
      lead.definition || items.map((r) => r.definition).find((d) => d.length > 0) || ''

    merged.push({
      id: uniqueId(slugify(lead.term), usedIds),
      term: lead.term,
      definition,
      aliases,
      t: times.length ? Math.min(...times) : null,
      importance: Math.max(...items.map((r) => r.importance)),
    })
  }

  return merged.sort(compareByTimeThenImportance)
}

function keysOf(r: RawConcept): string[] {
  return [r.term, ...r.aliases].map(normalizeTerm).filter((k) => k.length > 0)
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`
  used.add(id)
  return id
}
