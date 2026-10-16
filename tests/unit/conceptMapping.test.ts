import { describe, expect, it } from 'vitest'

import {
  ExtractionSchemaError,
  chunkLines,
  createConceptMap,
  mergeConcepts,
  normalizeTerm,
  renderLines,
  slugify,
  toMarkdown,
  toMermaid,
  toTree,
  validateExtraction,
  validateRelations,
  walkTree,
  type Concept,
  type ConceptMap,
  type RawConcept,
  type Relation,
} from '../../src/contexts/concept-mapping/domain'

const raw = (term: string, over: Partial<RawConcept> = {}): RawConcept => ({
  term,
  definition: `${term} def`,
  aliases: [],
  t: null,
  importance: 0.5,
  ...over,
})

const concept = (id: string, over: Partial<Concept> = {}): Concept => ({
  id,
  term: id[0]!.toUpperCase() + id.slice(1),
  definition: `${id} def`,
  aliases: [],
  t: null,
  importance: 0.5,
  ...over,
})

function map(concepts: Concept[], relations: Relation[] = [], over: Partial<ConceptMap> = {}): ConceptMap {
  return createConceptMap({
    videoId: 'dQw4w9WgXcQ',
    title: 'Calculus 1',
    lang: 'en',
    topic: 'Calculus',
    model: 'm',
    promptVersion: 'p',
    createdAt: '2026-10-16T00:00:00.000Z',
    timed: true,
    ...over,
    concepts,
    relations,
  })
}

describe('normalizeTerm / slugify', () => {
  it.each([
    ['The Derivatives', 'derivative'],
    ['  "Limit," ', 'limit'],
    ['partial derivatives', 'partial derivative'],
    ['Probabilities', 'probability'],
    ['processes', 'process'],
    ['analysis', 'analysis'],
    ['calculus', 'calculus'],
    ['class', 'class'],
    ['series', 'series'],
    ['statistics', 'statistics'],
    ['ПРОИЗВОДНАЯ', 'производная'],
  ])('%s → %s', (input, out) => expect(normalizeTerm(input)).toBe(out))

  it('slugify keeps Unicode letters and never returns empty', () => {
    expect(slugify('Chain Rule (calculus)')).toBe('chain-rule-calculus')
    expect(slugify('Производная функции')).toBe('производная-функции')
    expect(slugify('???')).toBe('concept')
  })
})

describe('validateExtraction', () => {
  it('drops bad items, clamps values, caps t at the video duration', () => {
    const out = validateExtraction(
      {
        topic: ' Calculus ',
        concepts: [
          { term: 'Limit', definition: 'x', aliases: ['lim', 5, ''], t: 4.7, importance: 3 },
          { term: '', definition: 'no term' },
          'junk',
          { term: 'Derivative', definition: 'y', aliases: 'nope', t: 99999, importance: 'high' },
          { term: 'Negative t', t: -3, importance: -1 },
        ],
      },
      { durationSec: 3600 },
    )
    expect(out.topic).toBe('Calculus')
    expect(out.concepts).toEqual([
      { term: 'Limit', definition: 'x', aliases: ['lim'], t: 4, importance: 1 },
      { term: 'Derivative', definition: 'y', aliases: [], t: 3600, importance: 0.5 },
      { term: 'Negative t', definition: '', aliases: [], t: null, importance: 0 },
    ])
  })

  it('throws only on a wholly wrong shape', () => {
    expect(() => validateExtraction(null)).toThrow(ExtractionSchemaError)
    expect(() => validateExtraction({ concepts: 'x' })).toThrow(ExtractionSchemaError)
    expect(validateExtraction({ concepts: [] }).concepts).toEqual([])
  })
})

describe('validateRelations', () => {
  const concepts = [concept('limit', { aliases: ['lim'] }), concept('derivative', { aliases: ["f'(x)"] })]

  it('resolves terms through normalization and aliases; drops junk', () => {
    expect(
      validateRelations(
        {
          relations: [
            { from: 'Derivatives', type: 'requires', to: 'lim' },
            { from: "f'(x)", type: 'requires', to: 'Limit' }, // duplicate after resolution
            { from: 'derivative', type: 'part_of', to: 'limit' }, // variant spelling of part-of
            { from: 'limit', type: 'requires', to: 'limit' }, // self-loop
            { from: 'unknown', type: 'requires', to: 'limit' },
            { from: 'limit', type: 'likes', to: 'derivative' },
          ],
        },
        concepts,
      ),
    ).toEqual([
      { from: 'derivative', to: 'limit', type: 'requires' },
      { from: 'derivative', to: 'limit', type: 'part-of' },
    ])
  })

  it('throws on a missing relations array', () => {
    expect(() => validateRelations({}, concepts)).toThrow(ExtractionSchemaError)
  })
})

describe('mergeConcepts', () => {
  it('merges spelling variants and aliases transitively', () => {
    const merged = mergeConcepts([
      raw('Derivative', { t: 734, importance: 0.9, aliases: ["f'(x)"] }),
      raw('derivatives', { t: 700, importance: 0.4 }),
      raw("f'(x)", { aliases: ['dy/dx'], t: 900, importance: 0.3 }),
      raw('Limit', { t: 4 }),
    ])
    expect(merged).toHaveLength(2)
    const d = merged.find((c) => c.id === 'derivative')!
    expect(d.term).toBe('Derivative') // from the most important member
    expect(d.definition).toBe('Derivative def')
    expect(d.t).toBe(700) // earliest of any member
    expect(d.importance).toBe(0.9)
    expect(d.aliases).toEqual(["f'(x)", 'dy/dx'])
    expect(merged[0]!.id).toBe('limit') // sorted by time
  })

  it('distinct concepts with the same slug get unique ids', () => {
    const merged = mergeConcepts([raw('C++'), raw('C#')])
    expect(new Set(merged.map((c) => c.id)).size).toBe(2)
  })

  it('falls back to any non-empty definition', () => {
    const [c] = mergeConcepts([raw('X', { definition: '', importance: 1 }), raw('x', { definition: 'from other' })])
    expect(c!.definition).toBe('from other')
  })
})

describe('createConceptMap invariants', () => {
  it('drops dangling, self and duplicate edges and duplicate ids', () => {
    const m = map(
      [concept('a'), concept('b'), concept('a', { term: 'dup' })],
      [
        { from: 'a', to: 'b', type: 'part-of' },
        { from: 'a', to: 'b', type: 'part-of' },
        { from: 'a', to: 'a', type: 'requires' },
        { from: 'a', to: 'zzz', type: 'requires' },
      ],
    )
    expect(m.concepts.map((c) => c.term)).toEqual(['A', 'B'])
    expect(m.relations).toEqual([{ from: 'a', to: 'b', type: 'part-of' }])
  })

  it('an untimed map carries no timestamps', () => {
    const m = map([concept('a', { t: 10 })], [], { timed: false })
    expect(m.concepts[0]!.t).toBeNull()
  })
})

describe('toTree', () => {
  it('hangs concepts under their strongest part-of parent; requires become annotations', () => {
    const m = map(
      [
        concept('calculus', { importance: 1, t: 0 }),
        concept('algebra', { importance: 0.3, t: 1 }),
        concept('limit', { t: 4, importance: 0.8 }),
        concept('derivative', { t: 734, importance: 0.9 }),
        concept('chain', { t: 900 }),
      ],
      [
        { from: 'limit', to: 'calculus', type: 'part-of' },
        { from: 'derivative', to: 'algebra', type: 'part-of' },
        { from: 'derivative', to: 'calculus', type: 'part-of' }, // stronger parent wins
        { from: 'chain', to: 'derivative', type: 'part-of' },
        { from: 'derivative', to: 'limit', type: 'requires' },
      ],
    )
    const tree = toTree(m)
    expect(tree.topic).toBe('Calculus')
    expect(tree.roots.map((r) => r.concept.id)).toEqual(['calculus', 'algebra'])
    const calc = tree.roots[0]!
    expect(calc.children.map((c) => c.concept.id)).toEqual(['limit', 'derivative']) // by time
    const deriv = calc.children[1]!
    expect(deriv.requires).toEqual([{ id: 'limit', term: 'Limit' }])
    expect(deriv.children.map((c) => c.concept.id)).toEqual(['chain'])
  })

  it('breaks part-of cycles; every concept appears exactly once', () => {
    const m = map(
      [concept('a', { importance: 0.9 }), concept('b', { importance: 0.5 }), concept('c', { importance: 0.4 })],
      [
        { from: 'a', to: 'b', type: 'part-of' },
        { from: 'b', to: 'c', type: 'part-of' },
        { from: 'c', to: 'a', type: 'part-of' },
      ],
    )
    const tree = toTree(m)
    const seen: string[] = []
    walkTree(tree, (n) => seen.push(n.concept.id))
    expect(seen.sort()).toEqual(['a', 'b', 'c'])
    // The most important concept on the cycle is detached and becomes the root.
    expect(tree.roots.map((r) => r.concept.id)).toEqual(['a'])
  })

  it('no relations → flat list ordered by time', () => {
    const tree = toTree(map([concept('b', { t: 20 }), concept('a', { t: 10 }), concept('c')]))
    expect(tree.roots.map((r) => r.concept.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('exporters', () => {
  const m = map(
    [concept('calculus', { t: 0, importance: 1 }), concept('derivative', { term: 'Derivative [d/dx]', t: 734 }), concept('limit', { t: null })],
    [
      { from: 'derivative', to: 'calculus', type: 'part-of' },
      { from: 'derivative', to: 'limit', type: 'requires' },
    ],
  )
  const tree = toTree(m)

  it('Markdown: nested bullets, linked timestamps, escaped markup, requires', () => {
    const md = toMarkdown(m, tree, { linkFor: (t) => `https://y/${t}` })
    expect(md).toBe(
      [
        '# Calculus',
        '',
        '_Source: Calculus 1_',
        '',
        '- **Calculus** [0:00](https://y/0) — calculus def',
        '  - **Derivative \\[d/dx\\]** [12:14](https://y/734) — derivative def _(requires: Limit)_',
        '- **Limit** — limit def',
        '',
      ].join('\n'),
    )
  })

  it('Mermaid: positional ids, quoted labels, both edge kinds', () => {
    const mm = toMermaid(map([concept('a', { term: 'Say "hi"' }), concept('b')], [
      { from: 'a', to: 'b', type: 'part-of' },
      { from: 'b', to: 'a', type: 'requires' },
    ]))
    expect(mm).toBe(['graph TD', '  n0["Say #quot;hi#quot;"]', '  n1["B"]', '  n1 --> n0', '  n1 -.->|requires| n0', ''].join('\n'))
  })
})

describe('chunkLines / renderLines', () => {
  const lines = Array.from({ length: 10 }, (_, i) => ({ start: i * 10, text: 'x'.repeat(20) }))

  it('renders bracketed seconds only when timed', () => {
    expect(renderLines([{ start: 734.6, text: 'hi' }], true)).toBe('[734] hi')
    expect(renderLines([{ start: 734.6, text: 'hi' }], false)).toBe('hi')
  })

  it('respects the budget without splitting or dropping lines', () => {
    const chunks = chunkLines(lines, 100, true)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.flat()).toEqual(lines)
    for (const c of chunks) expect(renderLines(c, true).length).toBeLessThanOrEqual(100)
  })

  it('an oversized single line still gets its own chunk', () => {
    expect(chunkLines([{ start: 0, text: 'y'.repeat(500) }], 100, false)).toHaveLength(1)
  })
})
