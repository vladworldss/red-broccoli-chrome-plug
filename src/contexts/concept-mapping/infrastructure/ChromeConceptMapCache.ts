import { isRecord, type KeyValueStorage } from '../../../shared/storage/kv'
import type { ConceptMapCache, ConceptMapKey } from '../application/ConceptMapCache'
import type { ConceptMap } from '../domain'

type IndexEntry = { lang: string; promptVersion: string; model: string; createdAt: string }

/**
 * Maps live at `sh:map:{videoId}:{lang}:{promptVersion}:{model}`. A per-video
 * index (`sh:mapidx:{videoId}`) lists which of those exist, so `findLatest`
 * is two small reads instead of a scan of the whole storage area.
 */
export class ChromeConceptMapCache implements ConceptMapCache {
  constructor(private readonly storage: KeyValueStorage) {}

  async get(key: ConceptMapKey): Promise<ConceptMap | null> {
    const k = mapKey(key)
    const bag = await this.storage.get(k)
    return asConceptMap(bag[k])
  }

  async findLatest(videoId: string, promptVersion: string, model: string): Promise<ConceptMap | null> {
    return this.newestOf(videoId, (e) => e.promptVersion === promptVersion && e.model === model)
  }

  async findLatestAny(videoId: string): Promise<ConceptMap | null> {
    return this.newestOf(videoId, () => true)
  }

  /** Newest indexed map passing `accept`; entries whose map is gone are skipped. */
  private async newestOf(videoId: string, accept: (e: IndexEntry) => boolean): Promise<ConceptMap | null> {
    const candidates = (await this.readIndex(videoId))
      .filter(accept)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    for (const e of candidates) {
      const map = await this.get({ videoId, lang: e.lang, promptVersion: e.promptVersion, model: e.model })
      if (map) return map
    }
    return null
  }

  async put(map: ConceptMap): Promise<void> {
    const key: ConceptMapKey = {
      videoId: map.videoId,
      lang: map.lang,
      promptVersion: map.promptVersion,
      model: map.model,
    }
    const idx = (await this.readIndex(map.videoId)).filter(
      (e) => !(e.lang === key.lang && e.promptVersion === key.promptVersion && e.model === key.model),
    )
    idx.push({ lang: key.lang, promptVersion: key.promptVersion, model: key.model, createdAt: map.createdAt })
    await this.storage.set({ [mapKey(key)]: map, [indexKey(map.videoId)]: idx })
  }

  private async readIndex(videoId: string): Promise<IndexEntry[]> {
    const k = indexKey(videoId)
    const raw = (await this.storage.get(k))[k]
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (e): e is IndexEntry =>
        isRecord(e) &&
        typeof e.lang === 'string' &&
        typeof e.promptVersion === 'string' &&
        typeof e.model === 'string' &&
        typeof e.createdAt === 'string',
    )
  }
}

export function mapKey(k: ConceptMapKey): string {
  return `sh:map:${k.videoId}:${k.lang}:${k.promptVersion}:${k.model}`
}

function indexKey(videoId: string): string {
  return `sh:mapidx:${videoId}`
}

/** Shallow shape check: a corrupted entry is a cache miss, not a crash. */
function asConceptMap(v: unknown): ConceptMap | null {
  if (!isRecord(v)) return null
  if (typeof v.videoId !== 'string' || !Array.isArray(v.concepts) || !Array.isArray(v.relations)) return null
  return v as unknown as ConceptMap
}
