/**
 * Transcript → files a student can keep. Pure string builders; saving the
 * file is the UI's job.
 */
import { safeFileStem } from '../../../shared/fileName'
import { formatTimestamp } from '../../../shared/time'
import { mergeIntoLines } from './parsers'
import type { Transcript } from './Transcript'

/** Cues without a usable duration are shown this long (seconds). */
const FALLBACK_CUE_SEC = 3

/**
 * SubRip (.srt), one cue per caption segment, original timing kept.
 *
 * YouTube's ASR cues overlap (rolling captions), so each cue's end is clamped
 * to the next cue's start — players would otherwise stack two lines. Null for
 * an untimed transcript: SRT without times is meaningless.
 */
export function toSrt(t: Transcript): string | null {
  if (!t.timed) return null
  const segs = t.segments.filter((s) => s.text.trim())
  const cues = segs.map((s, i) => {
    const next = segs[i + 1]
    let end = s.dur > 0 ? s.start + s.dur : next ? next.start : s.start + FALLBACK_CUE_SEC
    if (next && next.start > s.start) end = Math.min(end, next.start)
    if (end <= s.start) end = s.start + 0.5
    return `${i + 1}\n${srtTime(s.start)} --> ${srtTime(end)}\n${s.text.trim()}\n`
  })
  return cues.join('\n')
}

/**
 * Readable text: sentence-ish lines prefixed with "m:ss". This is exactly the
 * shape the panel's paste box parses, so a downloaded .txt can be pasted back
 * (or edited and pasted) to rebuild a map without captions.
 */
export function toTimestampedText(t: Transcript): string {
  if (!t.timed) return t.segments.map((s) => s.text.trim()).filter(Boolean).join('\n\n') + '\n'
  return mergeIntoLines(t.segments).map((l) => `${formatTimestamp(l.start)} ${l.text}`).join('\n') + '\n'
}

/**
 * "1. Algorithms and Computation [ZA-tUyM_y7s].en.srt". Characters illegal in
 * Windows/macOS file names are dropped; "und" (unknown) language is omitted.
 */
export function subtitleFileName(title: string, videoId: string, lang: string, ext: 'srt' | 'txt'): string {
  const clean = safeFileStem(title)
  const base = clean ? `${clean} [${videoId}]` : videoId
  const langPart = lang && lang !== 'und' ? `.${lang.replace(/[^A-Za-z0-9-]/g, '')}` : ''
  return `${base}${langPart}.${ext}`
}

/** 3725.4 → "01:02:05,400" */
function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000))
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`
}
