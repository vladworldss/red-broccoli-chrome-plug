/**
 * Core vocabulary of the concept-mapping context.
 *
 * A concept map is a DAG, not a tree: a concept can be part of one topic and
 * require several others. The reading tree (see tree.ts) is a projection of it.
 */

export type Concept = {
  /** Stable within one map; derived from the canonical term. */
  id: string
  term: string
  definition: string
  aliases: string[]
  /** Seconds from the start of the video where it is first explained; null if unknown. */
  t: number | null
  /** 0..1 — 1 is central to the lecture. */
  importance: number
  /**
   * 1–3 plain-language sentences: what it is and why it matters, as the
   * lecture explains it. Absent on maps built before prompt p2.
   */
  summary?: string
  /** Exact English Wikipedia article title, for reading links. Absent before p2. */
  refTitle?: string
}

/**
 * Edge direction is always "from depends on to":
 *  - `A part-of B`  → B is the broader topic; A sits under B in the tree.
 *  - `A requires B` → learn B before A (B is a prerequisite).
 */
export type RelationType = 'requires' | 'part-of'

export type Relation = { from: string; to: string; type: RelationType }

/** One line of transcript text as the pipeline sees it. */
export type TranscriptLine = { start: number; text: string }

/** A concept exactly as the LLM proposed it, after defensive validation. */
export type RawConcept = {
  term: string
  definition: string
  aliases: string[]
  t: number | null
  importance: number
  /** Empty when the model gave none. */
  summary: string
  refTitle: string
}

/**
 * Canonical comparison key for a term. Case, Unicode form, surrounding
 * punctuation, English articles and a trailing plural "s" are ignored, so
 * "The Derivatives" and "derivative" collide. Deliberately conservative:
 * no stemming beyond that (and none for non-English text), because a wrong
 * merge loses a concept while a missed merge only shows a near-duplicate.
 */
export function normalizeTerm(term: string): string {
  let s = term.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  s = s.replace(/^[\s"'`«»“”‘’()[\]{}.,;:!?-]+|[\s"'`«»“”‘’()[\]{}.,;:!?-]+$/g, '')
  s = s.replace(/^(?:the|a|an)\s+/, '')
  return singularizeLastWord(s)
}

const NOT_PLURAL = new Set(['series', 'species', 'physics', 'mathematics', 'statistics', 'economics', 'news'])

/**
 * English-only, last word only ("partial derivatives" → "partial derivative").
 * Keeps "analysis", "calculus", "class", "series"; "processes" → "process",
 * "probabilities" → "probability".
 */
function singularizeLastWord(s: string): string {
  const m = /^(.*?)([a-z]+)$/.exec(s)
  if (!m) return s
  const head = m[1] ?? ''
  const w = m[2] ?? ''
  if (w.length <= 3 || NOT_PLURAL.has(w)) return s
  if (/(?:ss|us|is)$/.test(w)) return s
  if (/(?:sses|xes|ches|shes|zzes)$/.test(w)) return head + w.slice(0, -2)
  if (/[^aeiou]ies$/.test(w)) return head + w.slice(0, -3) + 'y'
  if (w.endsWith('s')) return head + w.slice(0, -1)
  return s
}

/** URL/DOM-safe id from a term; Unicode letters survive ("производная"). */
export function slugify(term: string): string {
  const s = normalizeTerm(term)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'concept'
}

/** Order used everywhere a list of concepts is shown: by time, then weight. */
export function compareByTimeThenImportance(a: Concept, b: Concept): number {
  const ta = a.t ?? Number.POSITIVE_INFINITY
  const tb = b.t ?? Number.POSITIVE_INFINITY
  if (ta !== tb) return ta - tb
  if (a.importance !== b.importance) return b.importance - a.importance
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
