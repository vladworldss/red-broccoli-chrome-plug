/**
 * Fallback capture: YouTube's own "Show transcript" panel. Slower and more
 * UI-dependent than interception, but it needs no CC toggle and no token.
 * Runs in the isolated world (DOM access is all it needs).
 */
import { parseTranscriptRows } from '../../domain/parsers'
import type { Segment } from '../../domain/Transcript'
import { PANEL_HIDDEN, SHOW_TRANSCRIPT_BUTTON, TRANSCRIPT_PANEL, TRANSCRIPT_ROWS } from './selectors'

export function readTranscriptRows(root: ParentNode): { timestamp: string; text: string }[] {
  for (const [rowSel, tsSel, textSel] of TRANSCRIPT_ROWS) {
    const rows = Array.from(root.querySelectorAll(rowSel))
    if (rows.length === 0) continue
    const out = rows.map((row) => ({
      timestamp: row.querySelector(tsSel)?.textContent?.trim() ?? '',
      text: row.querySelector(textSel)?.textContent?.trim() ?? '',
    }))
    if (out.some((r) => r.timestamp && r.text)) return out
  }
  return []
}

export type ScrapeOptions = {
  timeoutMs?: number
  pollMs?: number
  /** Injectable for tests. */
  wait?: (ms: number) => Promise<void>
}

/**
 * Reads the panel if it is already open; otherwise clicks "Show transcript",
 * polls until rows render, and hides the panel again if we were the ones who
 * opened it (the user's layout is left as we found it).
 */
export async function scrapeTranscriptPanel(doc: Document, opts: ScrapeOptions = {}): Promise<Segment[]> {
  const { timeoutMs = 8000, pollMs = 250 } = opts
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const existing = parseTranscriptRows(readTranscriptRows(doc))
  if (existing.length > 0) return existing

  const button = firstMatch<HTMLElement>(doc, SHOW_TRANSCRIPT_BUTTON)
  if (!button) return []
  button.click()

  let segments: Segment[] = []
  for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
    segments = parseTranscriptRows(readTranscriptRows(doc))
    if (segments.length > 0) break
    await wait(pollMs)
  }

  const panel = firstMatch<HTMLElement>(doc, TRANSCRIPT_PANEL)
  panel?.setAttribute('visibility', PANEL_HIDDEN)
  return segments
}

function firstMatch<T extends Element>(root: ParentNode, selectors: readonly string[]): T | null {
  for (const sel of selectors) {
    const el = root.querySelector<T>(sel)
    if (el) return el
  }
  return null
}
