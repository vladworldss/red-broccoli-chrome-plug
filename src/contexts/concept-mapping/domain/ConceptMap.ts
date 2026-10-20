import type { Concept, Relation } from './Concept'

/**
 * The finished, cacheable result for one video. Immutable once created: a
 * rebuild produces a new map rather than editing this one, which is what makes
 * "same video + same prompt version + same model → same map" hold.
 */
export type ConceptMap = {
  videoId: string
  title: string
  /** Transcript language the map was built from. */
  lang: string
  topic: string
  model: string
  promptVersion: string
  createdAt: string
  /** False when built from an untimed paste: no concept has a seek target. */
  timed: boolean
  /** Subject area, picks the reading sources. Absent on maps built before p2. */
  field?: Field
  /**
   * The "Map language" setting the map was built with ("auto" = the lecture's
   * own). Tells which language the terms are in. Absent before 0.5.0.
   */
  outputLanguage?: string
  concepts: Concept[]
  relations: Relation[]
}

/** Subject areas the extraction prompt classifies a lecture into. */
export const FIELDS = ['math', 'cs', 'physics', 'chemistry', 'biology', 'economics', 'other'] as const
export type Field = (typeof FIELDS)[number]

export function isField(v: unknown): v is Field {
  return typeof v === 'string' && (FIELDS as readonly string[]).includes(v)
}

export type CreateConceptMapInput = Omit<ConceptMap, 'concepts' | 'relations'> & {
  concepts: readonly Concept[]
  relations: readonly Relation[]
}

/**
 * The single place a ConceptMap is constructed, so its invariants hold
 * everywhere: concept ids are unique, every relation points at existing
 * concepts, no self-edges, no duplicate edges, and untimed maps carry no `t`.
 */
export function createConceptMap(input: CreateConceptMapInput): ConceptMap {
  const concepts: Concept[] = []
  const ids = new Set<string>()
  for (const c of input.concepts) {
    if (ids.has(c.id)) continue
    ids.add(c.id)
    concepts.push(input.timed ? { ...c } : { ...c, t: null })
  }

  const seen = new Set<string>()
  const relations: Relation[] = []
  for (const r of input.relations) {
    if (r.from === r.to || !ids.has(r.from) || !ids.has(r.to)) continue
    const key = `${r.from}|${r.type}|${r.to}`
    if (seen.has(key)) continue
    seen.add(key)
    relations.push({ ...r })
  }

  return { ...input, concepts, relations }
}
