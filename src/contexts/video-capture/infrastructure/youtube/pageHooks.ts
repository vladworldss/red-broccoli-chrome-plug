/**
 * Runs in the page's MAIN world at document_start (see src/contents/youtube-main.ts).
 *
 * Why intercept instead of fetching captions ourselves: since 2025 YouTube's
 * /api/timedtext requires a PO token (`&pot=`) and returns an empty 200 without
 * one. The player's OWN caption request carries a valid token, so we let the
 * player fetch and read a clone of the response. That is why these wrappers
 * must be installed before the player script runs.
 *
 * Rules for this file: never throw into YouTube's code paths, never change a
 * request or response, never block. Every hook body is wrapped in try/catch
 * and works on a clone.
 */
import { parsePlayerResponse } from '../../domain/parsers'
import type { VideoMeta } from '../../domain/Transcript'
import { PAGE_FROM_BRIDGE, PAGE_FROM_MAIN, type BridgeToMain, type MainToBridge } from '../messages'
import { PLAYER, SUBTITLES_BUTTON } from './selectors'

type YtPlayer = HTMLElement & {
  getPlayerResponse?: () => unknown
  loadModule?: (name: string) => void
  setOption?: (module: string, option: string, value: unknown) => void
  isSubtitlesOn?: () => boolean
  toggleSubtitlesOn?: () => void
  toggleSubtitles?: () => void
}

type HookedWindow = Window & typeof globalThis & {
  __redbroccoliHooks?: boolean
  ytInitialPlayerResponse?: unknown
}

const TIMEDTEXT = /\/api\/timedtext\b/

export function installPageHooks(win: HookedWindow = window as HookedWindow): void {
  if (win.__redbroccoliHooks) return
  win.__redbroccoliHooks = true

  const post = (msg: MainToBridge) => win.postMessage(msg, win.location.origin)

  // --- fetch -------------------------------------------------------------
  const origFetch = win.fetch
  win.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const res = await origFetch.apply(this, args)
    try {
      const input = args[0]
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (TIMEDTEXT.test(url) && res.ok) {
        res
          .clone()
          .text()
          .then((body) => body && post({ source: PAGE_FROM_MAIN, kind: 'timedtext', url, body }))
          .catch(() => {})
      }
    } catch {
      // never interfere with the page
    }
    return res
  } as typeof fetch

  // --- XHR ---------------------------------------------------------------
  type TaggedXhr = XMLHttpRequest & { __shUrl?: string }
  const proto = win.XMLHttpRequest.prototype
  const origOpen = proto.open
  const origSend = proto.send
  proto.open = function (this: TaggedXhr, ...args: unknown[]) {
    try {
      this.__shUrl = String(args[1])
    } catch {
      // ignore
    }
    return (origOpen as (...a: unknown[]) => void).apply(this, args)
  } as typeof proto.open
  proto.send = function (this: TaggedXhr, body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      const url = this.__shUrl
      if (url && TIMEDTEXT.test(url)) {
        this.addEventListener('load', () => {
          try {
            if (this.status >= 200 && this.status < 300 && (this.responseType === '' || this.responseType === 'text')) {
              const text = this.responseText
              if (text) post({ source: PAGE_FROM_MAIN, kind: 'timedtext', url, body: text })
            }
          } catch {
            // ignore
          }
        })
      }
    } catch {
      // ignore
    }
    return origSend.call(this, body ?? null)
  }

  // --- requests from the bridge -------------------------------------------
  let toggledByUs = false

  win.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== win) return
    const msg = event.data as Partial<BridgeToMain> | null
    if (!msg || msg.source !== PAGE_FROM_BRIDGE) return
    try {
      if (msg.kind === 'get-meta' && typeof msg.requestId === 'string') {
        post({ source: PAGE_FROM_MAIN, kind: 'meta', requestId: msg.requestId, meta: readMeta(win) })
      } else if (msg.kind === 'enable-captions' && typeof msg.requestId === 'string') {
        const languageCode = typeof msg.languageCode === 'string' ? msg.languageCode : null
        const result = enableCaptions(win, languageCode)
        if (result.toggled) toggledByUs = true
        post({ source: PAGE_FROM_MAIN, kind: 'captions', requestId: msg.requestId, ok: result.ok })
      } else if (msg.kind === 'restore-captions') {
        if (toggledByUs) disableCaptions(win)
        toggledByUs = false
      }
    } catch {
      // ignore
    }
  })
}

/**
 * The player's live response is authoritative after SPA navigation;
 * `ytInitialPlayerResponse` is only right for the first video of the document,
 * so it is used only when its videoId matches the URL.
 */
function readMeta(win: HookedWindow): VideoMeta | null {
  const player = win.document.querySelector(PLAYER) as YtPlayer | null
  const current = new URL(win.location.href).searchParams.get('v')
  const live = parsePlayerResponse(safeCall(() => player?.getPlayerResponse?.()))
  if (live && (!current || live.videoId === current)) return live
  const initial = parsePlayerResponse(win.ytInitialPlayerResponse)
  if (initial && (!current || initial.videoId === current)) return initial
  return live ?? null
}

/**
 * Makes the player request caption track `languageCode` (or its default).
 * Player API first; the CC button as fallback. Reports whether it changed the
 * user's visible caption state, so `restore-captions` can undo exactly that.
 */
function enableCaptions(win: HookedWindow, languageCode: string | null): { ok: boolean; toggled: boolean } {
  const player = win.document.querySelector(PLAYER) as YtPlayer | null
  if (!player) return { ok: false, toggled: false }
  const wasOn = safeCall(() => player.isSubtitlesOn?.()) ?? isCcButtonOn(win)

  safeCall(() => player.loadModule?.('captions'))
  if (languageCode && typeof player.setOption === 'function') {
    safeCall(() => player.setOption?.('captions', 'track', { languageCode }))
  }
  const nowOn = safeCall(() => player.isSubtitlesOn?.()) ?? isCcButtonOn(win)
  if (!nowOn) {
    if (typeof player.toggleSubtitlesOn === 'function') safeCall(() => player.toggleSubtitlesOn?.())
    else {
      const btn = win.document.querySelector<HTMLButtonElement>(SUBTITLES_BUTTON)
      if (btn && btn.getAttribute('aria-pressed') === 'false') btn.click()
    }
  }
  return { ok: true, toggled: wasOn === false }
}

function disableCaptions(win: HookedWindow): void {
  const player = win.document.querySelector(PLAYER) as YtPlayer | null
  const on = safeCall(() => player?.isSubtitlesOn?.()) ?? isCcButtonOn(win)
  if (!on) return
  if (player && typeof player.toggleSubtitles === 'function') {
    safeCall(() => player.toggleSubtitles?.())
    return
  }
  win.document.querySelector<HTMLButtonElement>(SUBTITLES_BUTTON)?.click()
}

function isCcButtonOn(win: HookedWindow): boolean | undefined {
  const pressed = win.document.querySelector(SUBTITLES_BUTTON)?.getAttribute('aria-pressed')
  return pressed === 'true' ? true : pressed === 'false' ? false : undefined
}

function safeCall<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}
