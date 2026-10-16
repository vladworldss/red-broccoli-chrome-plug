/**
 * Side-panel controller: the composition root that wires the three contexts
 * together (video-capture → concept-mapping → llm-gateway) and exposes one
 * `View` state machine to the React tree.
 *
 * Staleness: every resolve (tab switch, SPA navigation) bumps `gen` and aborts
 * the in-flight build. Each async step re-checks `gen` before touching state,
 * so a slow Gemini answer for video A can never paint over video B.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  ChromeConceptMapCache,
  NoConceptsError,
  EmptyTranscriptError,
  buildConceptMap,
  loadCachedConceptMap,
  loadFallbackConceptMap,
  type BuildProgress,
  type ConceptMap,
} from '../../contexts/concept-mapping'
import { DEFAULT_GEMINI_MODEL, GeminiApiAdapter, LlmError, describeLlmError } from '../../contexts/llm-gateway'
import {
  ChromeTranscriptCache,
  YouTubeTabClient,
  activeTabId,
  captureTranscript,
  manualTranscript,
  subscribeTabChanges,
  transcriptToLines,
  type CaptureAttempt,
  type Transcript,
  type VideoMeta,
} from '../../contexts/video-capture'
import { chromeLocalStorage } from '../../shared/storage/kv'
import { DEFAULT_SETTINGS, readSettings, subscribeSettings, type Settings } from '../../shared/storage/settings'

export type VideoRef = { tabId: number; videoId: string; title: string; meta: VideoMeta | null }

export type View =
  | { kind: 'loading' }
  | { kind: 'no-video' }
  | { kind: 'ready'; video: VideoRef }
  | { kind: 'capturing'; video: VideoRef }
  | { kind: 'no-captions'; video: VideoRef; attempts: CaptureAttempt[] }
  | { kind: 'building'; video: VideoRef; progress: BuildProgress | null }
  | {
      kind: 'map'
      video: VideoRef
      map: ConceptMap
      fromCache: boolean
      /** Set when a (re)build failed and this is the previous map kept on screen. */
      error?: BuildFailure
    }
  | ({ kind: 'error'; video: VideoRef } & BuildFailure)

export type BuildFailure = {
  message: string
  /** The one button that fixes it: retry, or Settings (key, or another model). */
  action: 'retry' | 'settings'
  /** Where to read more, e.g. the user's quota page for a 429. */
  help?: { label: string; url: string }
}

/** AI Studio's per-key view of active limits and usage (linked from Google's rate-limit docs). */
const RATE_LIMIT_HELP = { label: 'See your limits in AI Studio', url: 'https://aistudio.google.com/rate-limit' }

export function modelOf(settings: Settings): string {
  return settings.model || DEFAULT_GEMINI_MODEL
}

export function usePanel() {
  const storage = useMemo(() => chromeLocalStorage(), [])
  const transcriptCache = useMemo(() => (storage ? new ChromeTranscriptCache(storage) : undefined), [storage])
  const mapCache = useMemo(() => (storage ? new ChromeConceptMapCache(storage) : undefined), [storage])

  const [settings, setSettings] = useState<Settings | null>(null)
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS)
  const [view, setView] = useState<View>({ kind: 'loading' })

  const gen = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const clientRef = useRef<YouTubeTabClient | null>(null)
  /** The map last shown, so a failed Rebuild can put it straight back. */
  const shownMap = useRef<ConceptMap | null>(null)
  useEffect(() => {
    if (view.kind === 'map') shownMap.current = view.map
  }, [view])
  const currentTabId = useRef<number | null>(null)

  // --- settings ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    void readSettings(storage).then((s) => {
      if (cancelled) return
      settingsRef.current = s
      setSettings(s)
    })
    const unsubscribe = subscribeSettings(storage, (s) => {
      settingsRef.current = s
      setSettings(s)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [storage])

  // --- what is the panel looking at? ---------------------------------------------
  const resolve = useCallback(async () => {
    const my = ++gen.current
    abortRef.current?.abort()
    abortRef.current = null
    setView({ kind: 'loading' })

    const tabId = await activeTabId()
    if (my !== gen.current) return
    currentTabId.current = tabId
    if (tabId === null) return setView({ kind: 'no-video' })

    const client = new YouTubeTabClient(tabId)
    clientRef.current = client
    const state = await client.getState()
    if (my !== gen.current) return
    if (!state?.videoId) return setView({ kind: 'no-video' })

    const video: VideoRef = {
      tabId,
      videoId: state.videoId,
      title: state.meta?.title || state.title,
      meta: state.meta,
    }
    const cached = mapCache
      ? await loadCachedConceptMap(video.videoId, { cache: mapCache, model: modelOf(settingsRef.current) })
      : null
    if (my !== gen.current) return
    setView(cached ? { kind: 'map', video, map: cached, fromCache: true } : { kind: 'ready', video })
  }, [mapCache])

  const settingsLoaded = settings !== null
  useEffect(() => {
    if (!settingsLoaded) return
    void resolve()
    return subscribeTabChanges(
      () => void resolve(),
      (tabId) => {
        if (tabId === currentTabId.current) void resolve()
      },
    )
  }, [resolve, settingsLoaded])

  // --- transcript -------------------------------------------------------------------
  /** Cache first, then the tab's providers. Shared by Build and Download. */
  const getTranscript = useCallback(
    (video: VideoRef) => {
      const client = new YouTubeTabClient(video.tabId)
      return captureTranscript(
        { videoId: video.videoId },
        {
          providers: [client.provider('intercept'), client.provider('dom')],
          ...(transcriptCache ? { cache: transcriptCache } : {}),
        },
      )
    },
    [transcriptCache],
  )

  // --- failure ---------------------------------------------------------------------
  /**
   * A failed build never blanks out a map the user already had. Fallback order:
   * the map on screen (Rebuild), the cached map for the current prompt+model,
   * then any older cached map of this video. Only with none of those does the
   * bare error card appear.
   */
  const fail = useCallback(
    async (video: VideoRef, failure: BuildFailure, stale: () => boolean) => {
      const onScreen = shownMap.current?.videoId === video.videoId ? shownMap.current : null
      const previous =
        onScreen ??
        (mapCache
          ? await loadFallbackConceptMap(video.videoId, { cache: mapCache, model: modelOf(settingsRef.current) })
          : null)
      if (stale()) return
      setView(
        previous
          ? { kind: 'map', video, map: previous, fromCache: true, error: failure }
          : { kind: 'error', video, ...failure },
      )
    },
    [mapCache],
  )

  // --- build ----------------------------------------------------------------------
  const build = useCallback(
    async (video: VideoRef, opts: { force?: boolean; pasted?: string } = {}) => {
      const my = gen.current
      const stale = () => my !== gen.current
      const s = settingsRef.current
      if (!s.apiKey) {
        await fail(video, { message: describeLlmError(new LlmError('no-key', '')), action: 'settings' }, stale)
        return
      }

      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac

      try {
        let transcript: Transcript | null
        if (opts.pasted !== undefined) {
          transcript = manualTranscript(video.videoId, opts.pasted)
          if (!transcript) {
            await fail(video, { message: 'The pasted text is empty.', action: 'retry' }, stale)
            return
          }
          await transcriptCache?.put(transcript).catch(() => {})
        } else {
          setView({ kind: 'capturing', video })
          const res = await getTranscript(video)
          if (stale()) return
          if (!res.transcript) {
            setView({ kind: 'no-captions', video, attempts: res.attempts })
            return
          }
          transcript = res.transcript
        }

        setView({ kind: 'building', video, progress: null })
        const llm = new GeminiApiAdapter({ apiKey: s.apiKey, model: modelOf(s) })
        const meta = video.meta
        const { map, fromCache } = await buildConceptMap(
          {
            videoId: video.videoId,
            title: video.title,
            lang: transcript.lang,
            lines: transcriptToLines(transcript),
            timed: transcript.timed,
            autoGeneratedCaptions: transcript.autoGenerated,
            outputLanguage: s.outputLanguage,
            ...(meta?.durationSec ? { durationSec: meta.durationSec } : {}),
            ...(meta?.chapters.length ? { chapters: meta.chapters } : {}),
            ...(opts.force || opts.pasted !== undefined ? { force: true } : {}),
          },
          {
            llm,
            ...(mapCache ? { cache: mapCache } : {}),
            signal: ac.signal,
            onProgress: (progress) => {
              if (!stale()) setView({ kind: 'building', video, progress })
            },
          },
        )
        if (stale()) return
        setView({ kind: 'map', video, map, fromCache })
      } catch (err) {
        if (stale() || (err instanceof LlmError && err.kind === 'aborted')) return
        await fail(video, failureOf(err), stale)
      } finally {
        if (abortRef.current === ac) abortRef.current = null
      }
    },
    [fail, getTranscript, mapCache, transcriptCache],
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    void resolve()
  }, [resolve])

  const seek = useCallback(async (t: number): Promise<boolean> => {
    const client = clientRef.current
    return client ? client.seek(t) : false
  }, [])

  return { view, settings, build, cancel, seek, getTranscript, refresh: resolve }
}

/** Error → what the panel shows: message, the fixing action, a help link for limits. */
function failureOf(err: unknown): BuildFailure {
  const message = errorText(err)
  if (!(err instanceof LlmError)) return { message, action: 'retry' }
  switch (err.kind) {
    case 'auth':
    case 'no-key':
      return { message, action: 'settings' }
    case 'daily-quota':
      // Retrying today is pointless; another model has its own quota.
      return { message, action: 'settings', help: RATE_LIMIT_HELP }
    case 'rate-limit':
      return { message, action: 'retry', help: RATE_LIMIT_HELP }
    default:
      return { message, action: 'retry' }
  }
}

function errorText(err: unknown): string {
  if (err instanceof LlmError) return describeLlmError(err)
  if (err instanceof NoConceptsError) return 'No study concepts were found in this video.'
  if (err instanceof EmptyTranscriptError) return 'The transcript is empty.'
  return err instanceof Error ? err.message : String(err)
}
