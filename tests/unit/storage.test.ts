import { describe, expect, it, vi } from 'vitest'

import { ChromeConceptMapCache, mapKey } from '../../src/contexts/concept-mapping/infrastructure/ChromeConceptMapCache'
import type { ConceptMap } from '../../src/contexts/concept-mapping'
import { ChromeTranscriptCache } from '../../src/contexts/video-capture'
import type { Transcript } from '../../src/contexts/video-capture'
import { cacheUsage, clearCache } from '../../src/shared/storage/cacheAdmin'
import { DEFAULT_ORDER, PROVIDERS } from '../../src/contexts/llm-gateway'
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  SETTINGS_PROVIDER_ORDER,
  normalizeSettings,
  readSettings,
  subscribeSettings,
  writeSettings,
} from '../../src/shared/storage/settings'
import { fakeChromeStorage } from './helpers/fakeChromeStorage'

const VID = 'dQw4w9WgXcQ'

function conceptMap(over: Partial<ConceptMap> = {}): ConceptMap {
  return {
    videoId: VID,
    title: 'T',
    lang: 'en',
    topic: 'Topic',
    model: 'gemini-flash-latest',
    promptVersion: 'p1',
    createdAt: '2026-10-16T10:00:00.000Z',
    timed: true,
    concepts: [{ id: 'a', term: 'A', definition: '', aliases: [], t: 1, importance: 1 }],
    relations: [],
    ...over,
  }
}

describe('settings', () => {
  it('absent or corrupt → defaults (only Gemini enabled, default order)', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('junk')).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.order[0]).toBe('gemini')
    expect(Object.values(DEFAULT_SETTINGS.providers).filter((p) => p.enabled)).toHaveLength(1)
  })

  it('migrates v1 {apiKey, model} into the Gemini provider — upgrading users keep their key', () => {
    const s = normalizeSettings({ apiKey: ' AIza-key ', model: ' gemini-2.5-flash ', outputLanguage: 'Russian' })
    expect(s.providers.gemini).toEqual({ enabled: true, apiKey: 'AIza-key', model: 'gemini-2.5-flash' })
    expect(s.outputLanguage).toBe('Russian')
    expect(s.order).toEqual([...SETTINGS_PROVIDER_ORDER])
  })

  it('v2: wrong types are rejected, unknown providers dropped, order de-duplicated and completed', () => {
    const s = normalizeSettings({
      providers: { groq: { enabled: 'yes', apiKey: 5, model: ' m ' }, evil: { enabled: true } },
      order: ['groq', 'groq', 'nope', 'mistral'],
      outputLanguage: '',
    })
    expect(s.providers.groq).toEqual({ enabled: false, apiKey: '', model: 'm' })
    expect('evil' in s.providers).toBe(false)
    expect(s.order).toEqual(['groq', 'mistral', 'gemini', 'openrouter', 'gemma', 'deepseek'])
    expect(s.outputLanguage).toBe('auto')
  })

  it('patching one provider preserves the others', async () => {
    const s = fakeChromeStorage()
    await writeSettings(s, { providers: { gemini: { apiKey: 'g' } } })
    await writeSettings(s, { providers: { groq: { apiKey: 'q', enabled: true } }, order: ['groq', 'gemini'] })
    const read = await readSettings(s)
    expect(read.providers.gemini.apiKey).toBe('g')
    expect(read.providers.groq).toEqual({ enabled: true, apiKey: 'q', model: '' })
    expect(read.order.slice(0, 2)).toEqual(['groq', 'gemini'])
  })

  it('null storage → defaults, no throw', async () => {
    expect(await readSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect((await writeSettings(null, { providers: { gemini: { apiKey: 'k' } } })).providers.gemini.apiKey).toBe('k')
  })

  it('subscribe filters on area and key; unsubscribe removes the listener', async () => {
    const s = fakeChromeStorage()
    const cb = vi.fn()
    const off = subscribeSettings(s, cb)
    s.emit({ 'sh:map:x': { newValue: 1 } })
    s.emit({ [SETTINGS_KEY]: { newValue: { apiKey: 'z' } } }, 'sync')
    expect(cb).not.toHaveBeenCalled()
    await writeSettings(s, { providers: { gemini: { apiKey: 'k' } } })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0]![0].providers.gemini.apiKey).toBe('k')
    off()
    expect(s.listenerCount()).toBe(0)
  })

  it('the settings provider list mirrors the llm-gateway presets (shared code cannot import them)', () => {
    expect([...SETTINGS_PROVIDER_ORDER]).toEqual(DEFAULT_ORDER)
    expect([...SETTINGS_PROVIDER_ORDER].sort()).toEqual(Object.keys(PROVIDERS).sort())
  })
})

describe('ChromeConceptMapCache', () => {
  it('get by exact key; findLatest picks the newest matching prompt+model', async () => {
    const s = fakeChromeStorage()
    const cache = new ChromeConceptMapCache(s)
    await cache.put(conceptMap({ lang: 'en', createdAt: '2026-10-16T10:00:00Z' }))
    await cache.put(conceptMap({ lang: 'ru', createdAt: '2026-10-16T11:00:00Z' }))
    await cache.put(conceptMap({ lang: 'de', promptVersion: 'p0', createdAt: '2026-10-16T12:00:00Z' }))

    expect((await cache.get({ videoId: VID, lang: 'en', promptVersion: 'p1', model: 'gemini-flash-latest' }))?.lang).toBe('en')
    expect((await cache.findLatest(VID, 'p1', 'gemini-flash-latest'))?.lang).toBe('ru')
    expect(await cache.findLatest(VID, 'p1', 'other-model')).toBeNull()
    expect(await cache.findLatest('AAAAAAAAAAA', 'p1', 'gemini-flash-latest')).toBeNull()
  })

  it('findLatestAny ignores prompt version and model; skips index entries whose map is gone', async () => {
    const s = fakeChromeStorage()
    const cache = new ChromeConceptMapCache(s)
    await cache.put(conceptMap({ model: 'old-model', promptVersion: 'p0', createdAt: '2026-10-16T09:00:00Z' }))
    await cache.put(conceptMap({ model: 'other', createdAt: '2026-10-16T12:00:00Z' }))
    expect((await cache.findLatestAny(VID))?.model).toBe('other')

    delete s.data[mapKey({ videoId: VID, lang: 'en', promptVersion: 'p1', model: 'other' })]
    expect((await cache.findLatestAny(VID))?.model).toBe('old-model')
    expect(await cache.findLatestAny('AAAAAAAAAAA')).toBeNull()
  })

  it('re-putting the same key replaces the index entry instead of duplicating it', async () => {
    const s = fakeChromeStorage()
    const cache = new ChromeConceptMapCache(s)
    await cache.put(conceptMap())
    await cache.put(conceptMap({ topic: 'New' }))
    expect(s.data[`sh:mapidx:${VID}`]).toHaveLength(1)
    expect((await cache.findLatest(VID, 'p1', 'gemini-flash-latest'))?.topic).toBe('New')
  })

  it('corrupted entries are cache misses', async () => {
    const key = { videoId: VID, lang: 'en', promptVersion: 'p1', model: 'm' }
    const s = fakeChromeStorage({ [mapKey(key)]: { nope: true }, [`sh:mapidx:${VID}`]: 'garbage' })
    const cache = new ChromeConceptMapCache(s)
    expect(await cache.get(key)).toBeNull()
    expect(await cache.findLatest(VID, 'p1', 'm')).toBeNull()
  })
})

describe('ChromeTranscriptCache + cacheAdmin', () => {
  const t: Transcript = { videoId: VID, lang: 'en', autoGenerated: true, timed: true, source: 'intercept', segments: [{ start: 0, dur: 1, text: 'hi' }] }

  it('round-trips a transcript and rejects a mismatched entry', async () => {
    const s = fakeChromeStorage({ 'sh:transcript:AAAAAAAAAAA': { ...t, videoId: 'BBBBBBBBBBB' } })
    const cache = new ChromeTranscriptCache(s)
    await cache.put(t)
    expect(await cache.get(VID)).toEqual(t)
    expect(await cache.get('AAAAAAAAAAA')).toBeNull()
  })

  it('clearCache removes every cache key but never the settings (API key)', async () => {
    const s = fakeChromeStorage({ [SETTINGS_KEY]: { apiKey: 'secret' }, unrelated: 1 })
    await new ChromeTranscriptCache(s).put(t)
    await new ChromeConceptMapCache(s).put(conceptMap())

    expect((await cacheUsage(s)).videos).toBe(1)
    expect(await clearCache(s)).toBe(3) // transcript, map, map index
    expect(Object.keys(s.data).sort()).toEqual([SETTINGS_KEY, 'unrelated'])
    expect((await cacheUsage(s)).videos).toBe(0)
  })
})
