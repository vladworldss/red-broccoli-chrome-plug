import { isRecord, type KeyValueStorage } from '../../../shared/storage/kv'
import type { TranscriptCache } from '../application/captureTranscript'
import type { Transcript } from '../domain'

/**
 * One transcript per video at `sh:transcript:{videoId}` — the most recently
 * captured one. Kept apart from the maps so a prompt-version bump re-runs only
 * the LLM step, not the (fragile) capture.
 */
export class ChromeTranscriptCache implements TranscriptCache {
  constructor(private readonly storage: KeyValueStorage) {}

  async get(videoId: string): Promise<Transcript | null> {
    const k = transcriptKey(videoId)
    const v = (await this.storage.get(k))[k]
    if (!isRecord(v) || v.videoId !== videoId || !Array.isArray(v.segments)) return null
    return v as unknown as Transcript
  }

  async put(t: Transcript): Promise<void> {
    await this.storage.set({ [transcriptKey(t.videoId)]: t })
  }
}

export function transcriptKey(videoId: string): string {
  return `sh:transcript:${videoId}`
}
