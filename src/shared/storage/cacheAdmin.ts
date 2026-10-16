import type { KeyValueStorage } from './kv'

/**
 * Prefixes of every cache key. Settings (`sh:settings`) are deliberately not
 * in this list: "Clear cache" must never wipe the user's API key.
 */
export const CACHE_PREFIXES = ['sh:transcript:', 'sh:map:', 'sh:mapidx:'] as const

export type CacheUsage = { bytes: number; videos: number }

export async function cacheUsage(storage: KeyValueStorage): Promise<CacheUsage> {
  const all = await storage.get(null)
  const keys = Object.keys(all).filter(isCacheKey)
  const videos = new Set(
    keys.filter((k) => k.startsWith('sh:mapidx:') || k.startsWith('sh:transcript:')).map((k) => k.split(':')[2]),
  )
  const bytes = await storage.getBytesInUse(null)
  return { bytes, videos: videos.size }
}

export async function clearCache(storage: KeyValueStorage): Promise<number> {
  const all = await storage.get(null)
  const keys = Object.keys(all).filter(isCacheKey)
  if (keys.length > 0) await storage.remove(keys)
  return keys.length
}

function isCacheKey(key: string): boolean {
  return CACHE_PREFIXES.some((p) => key.startsWith(p))
}
