/**
 * Side-panel controller: the composition root that wires the three contexts
 * together (video-capture → concept-mapping → llm-gateway) and exposes one
 * `View` state machine to the React tree.
 *
 * Staleness: every resolve (tab switch, SPA navigation) bumps `gen`; each of
 * its async steps re-checks `gen` before touching state.
 *
 * A build is a `job` that OUTLIVES resolves: switching tabs or videos while
 * Groq paces a long lecture used to abort it, and coming back showed "Build
 * map" again as if nothing had happened. Now the job keeps running, keeps its
 * latest view, and paints only while its video is the one on screen; coming
 * back to that video shows it again (or, once done, the cached map). Only
 * Cancel or a new build stops it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  ChromeConceptMapCache,
  NoConceptsError,
  EmptyTranscriptError,
  buildConceptMap,
  loadFallbackConceptMap,
  type BuildProgress,
  type ConceptMap,
} from '../../contexts/concept-mapping'
import {
  AllProvidersFailedError,
  LlmError,
  describeLlmError,
  describeLlmErrorShort,
  type FallbackEvent,
} from '../../contexts/llm-gateway'
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
import { buildChain, hasAnyProvider, providerHealth } from '../llmChain'

export type VideoRef = { tabId: number; videoId: string; title: string; meta: VideoMeta | null }

export type View =
  | { kind: 'loading' }
  | { kind: 'no-video' }
  | { kind: 'ready'; video: VideoRef }
  | { kind: 'capturing'; video: VideoRef }
  | { kind: 'no-captions'; video: VideoRef; attempts: CaptureAttempt[] }
  | {
      kind: 'building'
      video: VideoRef
      progress: BuildProgress | null
      /** "Gemini: daily quota used up — trying Mistral…" while the chain falls back. */
      note?: string
      /** A provider's per-minute budget is holding the next request until `until` (epoch ms). */
      wait?: { provider: string; until: number }
    }
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
const GOOGLE_LIMITS_HELP = { label: 'See your Gemini limits in AI Studio', url: 'https://aistudio.google.com/rate-limit' }

export function usePanel() {
  const storage = useMemo(() => chromeLocalStorage(), [])
  const transcriptCache = useMemo(() => (storage ? new ChromeTranscriptCache(storage) : undefined), [storage])
  const mapCache = useMemo(() => (storage ? new ChromeConceptMapCache(storage) : undefined), [storage])

  const [settings, setSettings] = useState<Settings | null>(null)
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS)
  const [view, setViewState] = useState<View>({ kind: 'loading' })

  const gen = useRef(0)
  /** The running build, if any. */
  const job = useRef<{ videoId: string; ac: AbortController; view: View } | null>(null)
  /** The video the panel currently shows; null while resolving or with no video. */
  const shownVideo = useRef<string | null>(null)
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
      // A fixed key or a new model deserves a fresh chance in the chain.
      providerHealth.clear()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [storage])

  // --- what is the panel looking at? ---------------------------------------------
  const resolve = useCallback(async () => {
    const my = ++gen.current
    shownVideo.current = null
    setViewState({ kind: 'loading' })

    const tabId = await activeTabId()
    if (my !== gen.current) return
    currentTabId.current = tabId
    if (tabId === null) return setViewState({ kind: 'no-video' })

    const client = new YouTubeTabClient(tabId)
    clientRef.current = client
    const state = await client.getState()
    if (my !== gen.current) return
    if (!state?.videoId) return setViewState({ kind: 'no-video' })

    const video: VideoRef = {
      tabId,
      videoId: state.videoId,
      title: state.meta?.title || state.title,
      meta: state.meta,
    }
    const running = job.current
    if (running?.videoId === video.videoId) {
      shownVideo.current = video.videoId
      return setViewState(running.view)
    }
    // Any saved map, even one from an older prompt version: after a prompt bump
    // the user still sees their map (badged "older version") instead of "Build map".
    const cached = mapCache
      ? await loadFallbackConceptMap(video.videoId, { cache: mapCache })
      : null
    if (my !== gen.current) return
    shownVideo.current = video.videoId
    setViewState(cached ? { kind: 'map', video, map: cached, fromCache: true } : { kind: 'ready', video })
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
    async (video: VideoRef, failure: BuildFailure, post: (v: View) => void) => {
      const onScreen = shownMap.current?.videoId === video.videoId ? shownMap.current : null
      const previous =
        onScreen ??
        (mapCache
          ? await loadFallbackConceptMap(video.videoId, { cache: mapCache })
          : null)
      post(
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
      const s = settingsRef.current
      job.current?.ac.abort()
      const ac = new AbortController()
      const mine = { videoId: video.videoId, ac, view: { kind: 'ready', video } as View }
      job.current = mine
      const stale = () => job.current !== mine
      /** Remember the job's view; paint it only while its video is on screen. */
      const setView = (v: View) => {
        if (stale()) return
        mine.view = v
        if (shownVideo.current === video.videoId) setViewState(v)
      }

      if (!hasAnyProvider(s)) {
        await fail(video, { message: 'Set up at least one AI provider (an API key) in Settings.', action: 'settings' }, setView)
        job.current = null
        return
      }

      try {
        let transcript: Transcript | null
        if (opts.pasted !== undefined) {
          transcript = manualTranscript(video.videoId, opts.pasted)
          if (!transcript) {
            await fail(video, { message: 'The pasted text is empty.', action: 'retry' }, setView)
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
        let lastProgress: BuildProgress | null = null
        let note: string | undefined
        let wait: { provider: string; until: number } | undefined
        const show = () => {
          if (stale()) return
          setView({ kind: 'building', video, progress: lastProgress, ...(note ? { note } : {}), ...(wait ? { wait } : {}) })
        }
        const llm = await buildChain(s, {
          onFallback: (ev: FallbackEvent) => {
            note = `${ev.from}: ${describeLlmErrorShort(ev.error)} — trying ${ev.to}…`
            show()
          },
        })
        if (!llm) {
          await fail(
            video,
            { message: 'No AI provider is usable: allow its access or add a key in Settings.', action: 'settings' },
            setView,
          )
          return
        }
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
              lastProgress = progress
              wait = progress.wait ? { provider: progress.wait.provider, until: Date.now() + progress.wait.ms } : undefined
              show()
            },
          },
        )
        if (stale()) return
        setView({ kind: 'map', video, map, fromCache })
      } catch (err) {
        if (stale() || (err instanceof LlmError && err.kind === 'aborted')) return
        await fail(video, failureOf(err), setView)
      } finally {
        if (job.current === mine) job.current = null
      }
    },
    [fail, getTranscript, mapCache, transcriptCache],
  )

  const cancel = useCallback(() => {
    job.current?.ac.abort()
    job.current = null
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
  if (err instanceof AllProvidersFailedError) {
    const lines = err.failures.map((f) => `• ${f.provider}: ${describeLlmErrorShort(f.error)}`)
    // Only short waits everywhere → retrying soon can work; otherwise the fix is in Settings.
    const allTransient = err.failures.every((f) => f.error.kind === 'rate-limit' || f.error.kind === 'server')
    const googleQuota = err.failures.some(
      (f) => (f.provider === 'Gemini' || f.provider === 'Gemma') && /quota|rate/.test(f.error.kind),
    )
    return {
      message: `No provider could build the map:\n${lines.join('\n')}`,
      action: allTransient ? 'retry' : 'settings',
      ...(googleQuota ? { help: GOOGLE_LIMITS_HELP } : {}),
    }
  }
  const message = errorText(err)
  if (!(err instanceof LlmError)) return { message, action: 'retry' }
  const google = err.provider === undefined || err.provider === 'Gemini' || err.provider === 'Gemma'
  switch (err.kind) {
    case 'auth':
    case 'no-key':
    case 'billing':
      return { message, action: 'settings' }
    case 'daily-quota':
      // Retrying today is pointless; another model or provider has its own quota.
      return { message, action: 'settings', ...(google ? { help: GOOGLE_LIMITS_HELP } : {}) }
    case 'rate-limit':
      return { message, action: 'retry', ...(google ? { help: GOOGLE_LIMITS_HELP } : {}) }
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
