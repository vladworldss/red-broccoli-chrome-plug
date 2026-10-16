/**
 * Timestamp helpers shared by every context. Pure — no DOM, no chrome.*.
 */

/** 734 → "12:14", 3725 → "1:02:05". Negative/NaN clamp to "0:00". */
export function formatTimestamp(totalSeconds: number): string {
  const s = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/**
 * "12:14" → 734, "1:02:05" → 3725, "0:07" → 7. Returns null for anything that
 * is not 2–3 colon-separated integer groups (so "12" or "a:b" are rejected —
 * a lone number in caption text must not be mistaken for a timestamp).
 */
export function parseTimestamp(text: string): number | null {
  const m = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*$/.exec(text)
  if (!m) return null
  const [, h, min, sec] = m
  const seconds = Number(sec)
  if (seconds >= 60) return null
  return Number(h ?? 0) * 3600 + Number(min) * 60 + seconds
}
