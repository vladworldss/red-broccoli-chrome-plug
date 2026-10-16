/**
 * Side-panel end of the extension hop. Needs neither the `tabs` permission nor
 * a YouTube host permission: the active tab's id is enough to message the
 * content script, which is the only thing that ever reads the page.
 */
import type { TranscriptProvider } from '../application/captureTranscript'
import type { Transcript } from '../domain'
import {
  isVideoChangedEvent,
  type CaptureMode,
  type SeekResponse,
  type TabRequest,
  type TabState,
  type TranscriptResponse,
} from './messages'

export class YouTubeTabClient {
  constructor(readonly tabId: number) {}

  /** Null when the tab has no bridge: not YouTube, or opened before install. */
  async getState(): Promise<TabState | null> {
    return this.send<TabState>({ type: 'SH_GET_STATE' }).catch(() => null)
  }

  async seek(t: number): Promise<boolean> {
    const res = await this.send<SeekResponse>({ type: 'SH_SEEK', t }).catch(() => null)
    return !!res?.ok
  }

  provider(mode: CaptureMode): TranscriptProvider {
    return {
      name: mode,
      get: async (videoId, { preferredLangs }): Promise<Transcript | null> => {
        const res = await this.send<TranscriptResponse | null>({
          type: 'SH_GET_TRANSCRIPT',
          videoId,
          mode,
          preferredLangs: [...preferredLangs],
        })
        if (!res) throw new Error('No answer from the YouTube tab')
        if (!res.ok) throw new Error(res.error)
        return res.transcript
      },
    }
  }

  private send<T>(msg: TabRequest): Promise<T> {
    return chrome.tabs.sendMessage(this.tabId, msg) as Promise<T>
  }
}

/** The active tab of the panel's own window (`currentWindow` = the panel's). */
export async function activeTabId(): Promise<number | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    return tab?.id ?? null
  } catch {
    return null
  }
}

/**
 * Fires when the panel should re-resolve what it is showing: the user switched
 * tabs, or a YouTube tab navigated to another video (SPA, no reload).
 */
export function subscribeTabChanges(
  onTabActivated: () => void,
  onVideoChanged: (tabId: number, videoId: string | null) => void,
): () => void {
  const activated = () => onTabActivated()
  const message = (msg: unknown, sender: chrome.runtime.MessageSender) => {
    if (isVideoChangedEvent(msg) && sender.tab?.id !== undefined) onVideoChanged(sender.tab.id, msg.videoId)
  }
  chrome.tabs.onActivated.addListener(activated)
  chrome.runtime.onMessage.addListener(message)
  return () => {
    chrome.tabs.onActivated.removeListener(activated)
    chrome.runtime.onMessage.removeListener(message)
  }
}

export function watchUrl(videoId: string, t?: number): string {
  const base = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  return t !== undefined ? `${base}&t=${Math.floor(t)}s` : base
}
