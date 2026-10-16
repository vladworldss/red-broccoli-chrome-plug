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
} from '../../src/contexts/concept-mapping'
import { LlmError, type LlmPort, type LlmRequest } from '../../src/contexts/llm-gateway'
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

  it('caches by video+lang+prompt+model; a second build is free; force re-runs the LLM', async () => {
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

    // The panel's open-a-video path finds it without knowing the language.
    expect(await loadCachedConceptMap(VID, { cache, model: 'fake-model' })).not.toBeNull()
    expect(await loadCachedConceptMap(VID, { cache, model: 'another-model' })).toBeNull()
  })

  it('a failed rebuild leaves the previous map in the cache for the fallback', async () => {
    const cache = new ChromeConceptMapCache(fakeChromeStorage())
    const { map: first } = await buildConceptMap(input(), { llm: fakeLlm().llm, cache })

    const failing: LlmPort = {
      modelId: 'fake-model',
      generateJson: vi.fn(async () => {
        throw new LlmError('rate-limit', '429')
      }),
    }
    await expect(buildConceptMap(input({ force: true }), { llm: failing, cache })).rejects.toMatchObject({
      kind: 'rate-limit',
    })
    expect(await loadFallbackConceptMap(VID, { cache, model: 'fake-model' })).toEqual(first)
  })

  it('fallback prefers the current prompt+model, else any older map, flagged as outdated', async () => {
    const cache = new ChromeConceptMapCache(fakeChromeStorage())
    expect(await loadFallbackConceptMap(VID, { cache, model: 'new-model' })).toBeNull()

    await buildConceptMap(input(), { llm: { ...fakeLlm().llm, modelId: 'old-model' }, cache, clock: () => '2026-10-16T09:00:00Z' })
    const older = await loadFallbackConceptMap(VID, { cache, model: 'new-model' })
    expect(older?.model).toBe('old-model')
    expect(isOutdatedMap(older!, 'new-model')).toBe(true)

    await buildConceptMap(input(), { llm: { ...fakeLlm().llm, modelId: 'new-model' }, cache, clock: () => '2026-10-16T08:00:00Z' })
    const current = await loadFallbackConceptMap(VID, { cache, model: 'new-model' })
    expect(current?.model).toBe('new-model') // current version wins even though it is older in time
    expect(isOutdatedMap(current!, 'new-model')).toBe(false)
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
