/**
 * Defensive parsing of LLM output. The response schema makes Gemini return the
 * right SHAPE, but values still need guarding: empty terms, importance outside
 * 0..1, timestamps past the end of the video, relations naming terms that were
 * never extracted. Bad items are dropped; only a wholly wrong shape throws.
 */
import { normalizeTerm, type Concept, type RawConcept, type Relation, type RelationType } from './Concept'
import { isField, type Field } from './ConceptMap'

export class ExtractionSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtractionSchemaError'
  }
}

export type Extraction = { topic: string; field: Field | null; concepts: RawConcept[] }

export function validateExtraction(raw: unknown, opts: { durationSec?: number } = {}): Extraction {
  if (!isRecord(raw)) throw new ExtractionSchemaError('LLM response is not a JSON object')
  if (!Array.isArray(raw.concepts)) throw new ExtractionSchemaError('LLM response has no "concepts" array')

  const max = opts.durationSec && opts.durationSec > 0 ? opts.durationSec : Number.POSITIVE_INFINITY
  const concepts: RawConcept[] = []
  for (const item of raw.concepts) {
    if (!isRecord(item)) continue
    const term = cleanText(item.term)
    if (!term || term.length > 120) continue
    const t = typeof item.t === 'number' && Number.isFinite(item.t) && item.t >= 0 ? Math.min(item.t, max) : null
    concepts.push({
      term,
      definition: cleanText(item.definition),
      aliases: Array.isArray(item.aliases)
        ? item.aliases.map(cleanText).filter((a) => a && a.length <= 120)
        : [],
      t: t === null ? null : Math.floor(t),
      importance: clamp01(item.importance),
      summary: capped(cleanText(item.summary), MAX_SUMMARY),
      refTitle: capped(cleanText(item.refTitle), MAX_REF_TITLE),
    })
  }
  const field = typeof raw.field === 'string' ? raw.field.trim().toLowerCase() : ''
  return {
    topic: cleanText(raw.topic),
    // A field outside the list still says "some subject": fall back to the generic links.
    field: field ? (isField(field) ? field : 'other') : null,
    concepts,
  }
}

const MAX_SUMMARY = 400
const MAX_REF_TITLE = 100

/** Cuts at the last word boundary and marks the cut, so a runaway answer stays readable. */
function capped(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`
}

/**
 * Resolves the LLM's term-named edges to concept ids. Terms are matched through
 * the same normalization (and aliases) used for merging, so "Limits" finds the
 * concept "limit". Unresolvable, self-referencing and duplicate edges are dropped.
 */
export function validateRelations(raw: unknown, concepts: readonly Concept[]): Relation[] {
  if (!isRecord(raw)) throw new ExtractionSchemaError('LLM response is not a JSON object')
  if (!Array.isArray(raw.relations)) throw new ExtractionSchemaError('LLM response has no "relations" array')

  const index = new Map<string, string>()
  for (const c of concepts) {
    for (const key of [c.term, ...c.aliases].map(normalizeTerm)) {
      if (key && !index.has(key)) index.set(key, c.id)
    }
  }

  const seen = new Set<string>()
  const out: Relation[] = []
  for (const item of raw.relations) {
    if (!isRecord(item)) continue
    const type = relationType(item.type)
    const from = index.get(normalizeTerm(cleanText(item.from)))
    const to = index.get(normalizeTerm(cleanText(item.to)))
    if (!type || !from || !to || from === to) continue
    const key = `${from}|${type}|${to}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ from, to, type })
  }
  return out
}

function relationType(v: unknown): RelationType | null {
  if (typeof v !== 'string') return null
  const s = v.toLowerCase().replace(/[\s_]+/g, '-')
  if (s === 'requires' || s === 'require' || s === 'prerequisite') return 'requires'
  if (s === 'part-of' || s === 'partof' || s === 'is-a' || s === 'isa' || s === 'subtopic-of') return 'part-of'
  return null
}

function cleanText(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
}

function clamp01(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return 0.5
  return Math.max(0, Math.min(1, n))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
