import { describe, expect, it, vi } from 'vitest'

import {
  ChromeConceptMapCache,
  NoConceptsError,
  PROMPT_VERSION,
  buildConceptMap,
  isOutdatedMap,
  loadCachedConceptMap,
  loadFallbackConceptMap,
  toMarkdown,
  toTree,
  type BuildConceptMapInput,
  type BuildProgress,
} from '../../src/contexts/concept-mapping'
import {
  AllProvidersFailedError,
  FallbackLlm,
  LlmError,
  type LlmPort,
  type LlmRequest,
  type ProviderHealth,
} from '../../src/contexts/llm-gateway'
import { manualTranscript, transcriptToLines } from '../../src/contexts/video-capture'
import { fakeChromeStorage } from '../unit/helpers/fakeChromeStorage'

const VID = 'dQw4w9WgXcQ'

const EXTRACTION = {
  topic: 'Calculus',
  concepts: [
    { term: 'Calculus', definition: 'Study of change.', aliases: [], t: 0, importance: 1 },
    { term: 'Limit', definition: 'Value approached.', aliases: ['lim'], t: 10, importance: 0.8 },
    { term: 'Derivatives', definition: 'Rate of change.', aliases: ["f'(x)"], t: 20, importance: 0.9 },
  ],
}
const RELATIONS = {
  relations: [
    { from: 'Limit', type: 'part-of', to: 'Calculus' },
    { from: 'derivative', type: 'part-of', to: 'Calculus' },
    { from: "f'(x)", type: 'requires', to: 'lim' },
  ],
}

/** Fake LLM that answers by schema: extraction vs relations. */
function fakeLlm(over: { extraction?: unknown; relations?: unknown | Error } = {}) {
  const requests: LlmRequest[] = []
  const llm: LlmPort = {
    modelId: 'fake-model',
    maxInputChars: 120_000,
    generateJson: vi.fn(async (req: LlmRequest) => {
      requests.push(req)
      if (req.schema.properties?.concepts) return over.extraction ?? EXTRACTION
      const r = over.relations ?? RELATIONS
      if (r instanceof Error) throw r
      return r
    }),
  }
  return { llm, requests }
}

function input(over: Partial<BuildConceptMapInput> = {}): BuildConceptMapInput {
  const t = manualTranscript(VID, '0:00\nCalculus is the study of change.\n0:10\nA limit…\n0:20\nThe derivative…')!
  return {
    videoId: VID,
    title: 'Calculus 1',
    lang: 'en',
    durationSec: 600,
    lines: transcriptToLines(t),
    timed: t.timed,
    outputLanguage: 'auto',
    ...over,
  }
}

describe('buildConceptMap flow (transcript → map → cache → export)', () => {
  it('p2: plain summary, Wikipedia title, subject and map language reach the saved map', async () => {
    const { llm } = fakeLlm({
      extraction: {
        topic: 'Calculus',
        field: 'math',
        concepts: [
          {
            term: 'Derivative',
            definition: 'Rate of change',
            aliases: [],
            t: 20,
            importance: 1,
            summary: 'How fast something changes right now, like a speedometer.',
            refTitle: 'Derivative',
          },
          { term: 'Limit', definition: 'Approach value', aliases: [], t: 10, importance: 0.8, summary: '', refTitle: '' },
        ],
      },
    })
    const { map } = await buildConceptMap(input({ outputLanguage: 'Russian' }), { llm })
    expect(map.promptVersion).toBe(PROMPT_VERSION)
    expect(map.field).toBe('math')
    expect(map.outputLanguage).toBe('Russian')
    const d = map.concepts.find((c) => c.term === 'Derivative')!
    expect(d).toMatchObject({ summary: 'How fast something changes right now, like a speedometer.', refTitle: 'Derivative' })
    // Empty strings from the model are not stored as fields.
    const l = map.concepts.find((c) => c.term === 'Limit')!
    expect('summary' in l).toBe(false)
    expect('refTitle' in l).toBe(false)
  })

  it('extracts, merges, relates and produces a readable tree', async () => {
    const { llm, requests } = fakeLlm()
    const progress = vi.fn()
    const { map, fromCache } = await buildConceptMap(input(), { llm, onProgress: progress, clock: () => 'NOW' })

    expect(fromCache).toBe(false)
    expect(map).toMatchObject({ videoId: VID, topic: 'Calculus', model: 'fake-model', promptVersion: PROMPT_VERSION, createdAt: 'NOW' })
    expect(map.concepts.map((c) => c.id)).toEqual(['calculus', 'limit', 'derivative'])
    expect(map.relations).toEqual([
      { from: 'limit', to: 'calculus', type: 'part-of' },
      { from: 'derivative', to: 'calculus', type: 'part-of' },
      { from: 'derivative', to: 'limit', type: 'requires' },
    ])
    expect(progress.mock.calls.map((c) => c[0])).toEqual([{ step: 'extract', current: 1, total: 1 }, { step: 'relate' }])

    // The transcript reaches the model with bracketed seconds for `t`.
    expect(requests[0]!.prompt).toContain('[10] A limit…')
    expect(requests[0]!.prompt).toContain('Lecture title: Calculus 1')

    const md = toMarkdown(map, toTree(map))
    expect(md).toContain('- **Calculus** [0:00]')
    expect(md).toContain('  - **Derivatives** [0:20] — Rate of change. _(requires: Limit)_')
  })

  it('caches per prompt version (any model); a second build is free; force re-runs the LLM', async () => {
    const storage = fakeChromeStorage()
    const cache = new ChromeConceptMapCache(storage)
    const { llm } = fakeLlm()

    await buildConceptMap(input(), { llm, cache })
    expect(llm.generateJson).toHaveBeenCalledTimes(2)

    const again = await buildConceptMap(input(), { llm, cache })
    expect(again.fromCache).toBe(true)
    expect(llm.generateJson).toHaveBeenCalledTimes(2)

    await buildConceptMap(input({ force: true }), { llm, cache })
    expect(llm.generateJson).toHaveBeenCalledTimes(4)

    // The panel's open-a-video path finds it without knowing language or model:
    // a map built by any provider of the chain is a valid current map.
    expect(await loadCachedConceptMap(VID, { cache })).not.toBeNull()
    const other = await buildConceptMap(input(), { llm: { ...fakeLlm().llm, modelId: 'another-model' }, cache })
    expect(other.fromCache).toBe(true)
  })

  it('a failed rebuild leaves the previous map in the cache for the fallback', async () => {
    const cache = new ChromeConceptMapCache(fakeChromeStorage())
    const { map: first } = await buildConceptMap(input(), { llm: fakeLlm().llm, cache })

    const failing: LlmPort = {
      modelId: 'fake-model',
      maxInputChars: 120_000,
      generateJson: vi.fn(async () => {
        throw new LlmError('rate-limit', '429')
      }),
    }
    await expect(buildConceptMap(input({ force: true }), { llm: failing, cache })).rejects.toMatchObject({
      kind: 'rate-limit',
    })
    expect(await loadFallbackConceptMap(VID, { cache })).toEqual(first)
  })

  it('fallback prefers the current prompt version, else any older map, flagged as outdated', async () => {
    const cache = new ChromeConceptMapCache(fakeChromeStorage())
    expect(await loadFallbackConceptMap(VID, { cache })).toBeNull()

    const { map } = await buildConceptMap(input(), { llm: fakeLlm().llm, clock: () => '2026-10-16T09:00:00Z' })
    await cache.put({ ...map, promptVersion: 'p0', model: 'old-model' })
    const older = await loadFallbackConceptMap(VID, { cache })
    expect(older?.promptVersion).toBe('p0')
    expect(isOutdatedMap(older!)).toBe(true)

    await buildConceptMap(input(), { llm: fakeLlm().llm, cache, clock: () => '2026-10-16T08:00:00Z' })
    const current = await loadFallbackConceptMap(VID, { cache })
    expect(current?.promptVersion).toBe(PROMPT_VERSION) // current version wins even though it is older in time
    expect(isOutdatedMap(current!)).toBe(false)
  })

  it('fallback chain: Gemini out of daily quota → Mistral builds; map names Mistral; next build hits cache', async () => {
    const cache = new ChromeConceptMapCache(fakeChromeStorage())
    const health: ProviderHealth = new Map()
    const gemini: LlmPort = {
      modelId: 'gemini:gemini-flash-latest',
      maxInputChars: 120_000,
      generateJson: vi.fn(async () => {
        throw new LlmError('daily-quota', 'quota', { provider: 'Gemini' })
      }),
    }
    const mistral = { ...fakeLlm().llm, modelId: 'mistral:mistral-small-latest' }
    const events: string[] = []
    const chain = () =>
      new FallbackLlm(
        [
          { id: 'gemini', label: 'Gemini', llm: gemini, resetsAtPacificMidnight: true },
          { id: 'mistral', label: 'Mistral', llm: mistral },
        ],
        { health, onFallback: (e) => events.push(`${e.from}->${e.to}:${e.error.kind}`) },
      )

    const { map } = await buildConceptMap(input(), { llm: chain(), cache })
    expect(map.model).toBe('mistral:mistral-small-latest')
    expect(events).toEqual(['Gemini->Mistral:daily-quota'])
    // Gemini is cooling down now: the relate call went straight to Mistral.
    expect(gemini.generateJson).toHaveBeenCalledTimes(1)

    const again = await buildConceptMap(input(), { llm: chain(), cache })
    expect(again.fromCache).toBe(true)
  })

  it('falling back to a smaller-budget provider re-splits the current chunk', async () => {
    // ~9k chars: one chunk for the big provider, far over the small one's budget
    // even with the prompt-header allowance.
    const lines = Array.from({ length: 200 }, (_, i) => ({ start: i * 20, text: `sentence ${i} about derivatives and limits` }))
    const small = fakeLlm()
    const smallLlm = { ...small.llm, modelId: 'groq:gpt-oss', maxInputChars: 600 }
    const big: LlmPort = {
      modelId: 'gemini:flash',
      maxInputChars: 120_000,
      generateJson: vi.fn(async () => {
        throw new LlmError('rate-limit', '429', { retryAfterMs: 60_000 })
      }),
    }
    const events: string[] = []
    const chain = new FallbackLlm(
      [
        { id: 'gemini', label: 'Gemini', llm: big },
        { id: 'groq', label: 'Groq', llm: smallLlm },
      ],
      { health: new Map(), onFallback: (e) => events.push(`${e.from}->${e.to}:${e.error.kind}`) },
    )
    const { map } = await buildConceptMap(input({ lines }), { llm: chain })
    const extractCalls = small.requests.filter((r) => r.schema.properties?.concepts)
    expect(extractCalls.length).toBeGreaterThan(2) // the one big chunk became several small ones
    expect(map.model).toBe('groq:gpt-oss')
    // Said once, when the split happens — not silently, not once per part.
    expect(events).toEqual(['Gemini->Groq:rate-limit'])
  })

  it('a provider pacing its per-minute budget re-emits the current step with the wait', async () => {
    const { llm } = fakeLlm()
    const paced: LlmPort = {
      ...llm,
      generateJson: async (req) => {
        req.onWait?.({ provider: 'Groq', ms: 58_000 })
        return llm.generateJson(req)
      },
    }
    const progress: BuildProgress[] = []
    await buildConceptMap(input(), { llm: paced, onProgress: (p) => progress.push(p) })
    expect(progress.slice(0, 2)).toEqual([
      { step: 'extract', current: 1, total: 1 },
      { step: 'extract', current: 1, total: 1, wait: { provider: 'Groq', ms: 58_000 } },
    ])
  })

  it('every provider failing surfaces one aggregate error with each reason', async () => {
    const failing = (kind: 'auth' | 'rate-limit', id: string): LlmPort => ({
      modelId: id,
      maxInputChars: 120_000,
      generateJson: vi.fn(async () => {
        throw new LlmError(kind, kind)
      }),
    })
    const chain = new FallbackLlm(
      [
        { id: 'a', label: 'A', llm: failing('auth', 'a:m') },
        { id: 'b', label: 'B', llm: failing('rate-limit', 'b:m') },
      ],
      { health: new Map() },
    )
    const err = await buildConceptMap(input(), { llm: chain }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AllProvidersFailedError)
    expect((err as AllProvidersFailedError).failures.map((f) => `${f.provider}:${f.error.kind}`)).toEqual([
      'A:auth',
      'B:rate-limit',
    ])
  })

  it('long transcripts are chunked and concepts merged across chunks', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({ start: i * 30, text: `sentence number ${i} about limits` }))
    const { llm, requests } = fakeLlm()
    const { map } = await buildConceptMap(input({ lines }), { llm, maxChunkChars: 400 })
    const extractCalls = requests.filter((r) => r.schema.properties?.concepts)
    expect(extractCalls.length).toBeGreaterThan(1)
    expect(extractCalls[1]!.prompt).toMatch(/This is part 2 of \d+/)
    expect(map.concepts).toHaveLength(3) // same concepts from every chunk merged
  })

  it('a schema failure in the relate step degrades to a flat map', async () => {
    const { llm } = fakeLlm({ relations: new LlmError('schema', 'bad json') })
    const { map } = await buildConceptMap(input(), { llm })
    expect(map.concepts).toHaveLength(3)
    expect(map.relations).toEqual([])
  })

  it('transport errors in the relate step still propagate', async () => {
    const { llm } = fakeLlm({ relations: new LlmError('rate-limit', '429') })
    await expect(buildConceptMap(input(), { llm })).rejects.toMatchObject({ kind: 'rate-limit' })
  })

  it('no concepts → NoConceptsError; untimed input → no timestamps', async () => {
    await expect(buildConceptMap(input(), { llm: fakeLlm({ extraction: { topic: '', concepts: [] } }).llm })).rejects.toBeInstanceOf(
      NoConceptsError,
    )

    const { llm, requests } = fakeLlm()
    const { map } = await buildConceptMap(input({ timed: false, lines: [{ start: 0, text: 'plain prose' }] }), { llm })
    expect(map.timed).toBe(false)
    expect(map.concepts.every((c) => c.t === null)).toBe(true)
    expect(requests[0]!.prompt).not.toContain('[0]')
  })
})
