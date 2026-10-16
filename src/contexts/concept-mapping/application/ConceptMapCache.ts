import type { ConceptMap } from '../domain'

/**
 * Everything that makes a map reproducible. Two requests with equal keys must
 * get the same map back; anything that can change the output belongs here.
 */
export type ConceptMapKey = {
  videoId: string
  lang: string
  promptVersion: string
  model: string
}

export interface ConceptMapCache {
  get(key: ConceptMapKey): Promise<ConceptMap | null>
  /**
   * Most recent map for a video under the current prompt version and model,
   * in any transcript language. Lets the panel show a map the instant a video
   * opens, before (and without) capturing the transcript again.
   */
  findLatest(videoId: string, promptVersion: string, model: string): Promise<ConceptMap | null>
  /**
   * Most recent map for a video under ANY prompt version or model. Only a
   * fallback for when building fails: an older map beats an empty error screen.
   */
  findLatestAny(videoId: string): Promise<ConceptMap | null>
  put(map: ConceptMap): Promise<void>
}

export function keyOf(map: ConceptMap): ConceptMapKey {
  return { videoId: map.videoId, lang: map.lang, promptVersion: map.promptVersion, model: map.model }
}
