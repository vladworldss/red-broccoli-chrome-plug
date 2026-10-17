/**
 * Wire contracts. Two hops:
 *
 *   MAIN-world hooks  ⇄ (window.postMessage) ⇄  ISOLATED bridge
 *   ISOLATED bridge   ⇄ (chrome.tabs / chrome.runtime messaging) ⇄  side panel
 *
 * The page hop is visible to YouTube's own scripts, so the bridge validates
 * every inbound page message and nothing secret ever crosses it (the API key
 * never leaves extension pages).
 */
import type { Transcript, VideoMeta } from '../domain'

// --- page hop --------------------------------------------------------------

export const PAGE_FROM_MAIN = 'redbroccoli:main'
export const PAGE_FROM_BRIDGE = 'redbroccoli:bridge'

export type MainToBridge =
  | { source: typeof PAGE_FROM_MAIN; kind: 'timedtext'; url: string; body: string }
  | { source: typeof PAGE_FROM_MAIN; kind: 'meta'; requestId: string; meta: VideoMeta | null }
  | { source: typeof PAGE_FROM_MAIN; kind: 'captions'; requestId: string; ok: boolean }

export type BridgeToMain =
  | { source: typeof PAGE_FROM_BRIDGE; kind: 'get-meta'; requestId: string }
  | { source: typeof PAGE_FROM_BRIDGE; kind: 'enable-captions'; requestId: string; languageCode: string | null }
  | { source: typeof PAGE_FROM_BRIDGE; kind: 'restore-captions' }

// --- extension hop ---------------------------------------------------------

export type CaptureMode = 'intercept' | 'dom'

export type TabRequest =
  | { type: 'SH_GET_STATE' }
  | { type: 'SH_GET_TRANSCRIPT'; videoId: string; mode: CaptureMode; preferredLangs: string[] }
  | { type: 'SH_SEEK'; t: number }

export type TabState = {
  videoId: string | null
  /** Page title fallback when the player metadata isn't available yet. */
  title: string
  meta: VideoMeta | null
}

export type TranscriptResponse =
  | { ok: true; transcript: Transcript | null }
  | { ok: false; error: string }

export type SeekResponse = { ok: boolean }

/** Bridge → runtime broadcast; the side panel filters on the sender tab. */
export type VideoChangedEvent = { type: 'SH_VIDEO_CHANGED'; videoId: string | null }

export function isTabRequest(v: unknown): v is TabRequest {
  if (typeof v !== 'object' || v === null) return false
  const t = (v as { type?: unknown }).type
  return t === 'SH_GET_STATE' || t === 'SH_GET_TRANSCRIPT' || t === 'SH_SEEK'
}

export function isVideoChangedEvent(v: unknown): v is VideoChangedEvent {
  return typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'SH_VIDEO_CHANGED'
}
