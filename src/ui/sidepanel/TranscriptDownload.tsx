import { useState } from 'react'

import {
  subtitleFileName,
  toSrt,
  toTimestampedText,
  type CaptureResult,
} from '../../contexts/video-capture'
import { ChevronIcon, DownloadIcon, FileIcon, FileTextIcon, SubtitlesIcon } from '../icons'
import { saveTextFile } from '../saveTextFile'
import type { VideoRef } from './usePanel'

type Props = {
  video: VideoRef
  getTranscript: (video: VideoRef) => Promise<CaptureResult>
  onToast: (msg: string) => void
}

/**
 * "Subtitles" card with a "Download subtitles" menu (.srt / .txt). Uses the cached transcript when there is one, so
 * after a map is built this is instant and never toggles captions again. Needs
 * no API key — nothing leaves the browser.
 */
export function TranscriptDownload({ video, getTranscript, onToast }: Props) {
  const [busy, setBusy] = useState(false)

  const download = async (format: 'srt' | 'txt') => {
    setBusy(true)
    try {
      const { transcript } = await getTranscript(video)
      if (!transcript) {
        onToast('No subtitles found for this video')
        return
      }
      const title = video.title || video.videoId
      const srt = format === 'srt' ? toSrt(transcript) : null
      if (srt !== null) {
        saveTextFile(subtitleFileName(title, video.videoId, transcript.lang, 'srt'), srt, 'application/x-subrip', { bom: true })
        return
      }
      saveTextFile(subtitleFileName(title, video.videoId, transcript.lang, 'txt'), toTimestampedText(transcript), 'text/plain')
      if (format === 'srt') onToast('This transcript has no timestamps — saved as .txt')
    } catch (err) {
      onToast(`Download failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="sh-subs sh-card" aria-label="Subtitles">
      <div className="sh-subs-head">
        <SubtitlesIcon />
        <div>
          <strong>Subtitles</strong>
          <div className="sh-small sh-muted">Download transcript</div>
        </div>
      </div>
      {/* Native disclosure: keyboard and screen-reader friendly, no state to keep. */}
      <details className="sh-disclosure">
        <summary className="sh-btn sh-btn-secondary">
          <DownloadIcon />
          <span>{busy ? 'Reading subtitles…' : 'Download subtitles'}</span>
          <span className="sh-chevron">
            <ChevronIcon />
          </span>
        </summary>
        <div className="sh-menu">
          <button
            className="sh-menu-item"
            disabled={busy}
            onClick={() => void download('srt')}
          >
            <FileTextIcon />
            <span>
              Subtitles (.srt)
              <span className="sh-small sh-muted">With timestamps, for video players</span>
            </span>
          </button>
          <button
            className="sh-menu-item"
            disabled={busy}
            onClick={() => void download('txt')}
          >
            <FileIcon />
            <span>
              Plain text (.txt)
              {/* It keeps an m:ss per line on purpose: that is what lets the
                  file be pasted back to rebuild a map. */}
              <span className="sh-small sh-muted">Readable; can be pasted back to rebuild</span>
            </span>
          </button>
        </div>
      </details>
    </section>
  )
}
