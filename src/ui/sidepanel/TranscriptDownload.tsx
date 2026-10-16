import { useState } from 'react'

import {
  subtitleFileName,
  toSrt,
  toTimestampedText,
  type CaptureResult,
} from '../../contexts/video-capture'
import { saveTextFile } from '../saveTextFile'
import type { VideoRef } from './usePanel'

type Props = {
  video: VideoRef
  getTranscript: (video: VideoRef) => Promise<CaptureResult>
  onToast: (msg: string) => void
}

/**
 * "Subtitles: .srt / .txt". Uses the cached transcript when there is one, so
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
    <div className="sh-row sh-small">
      <span className="sh-muted">{busy ? 'Reading subtitles…' : 'Subtitles:'}</span>
      <button className="sh-btn" disabled={busy} onClick={() => void download('srt')} title="Subtitle file with timing, for video players">
        Download .srt
      </button>
      <button className="sh-btn" disabled={busy} onClick={() => void download('txt')} title="Readable text with timestamps">
        Download .txt
      </button>
    </div>
  )
}
