import type { TranscriptLine } from './Concept'

/**
 * Splits transcript lines into chunks of at most `maxChars` rendered
 * characters, never splitting a line. A single line longer than the budget
 * still gets its own chunk rather than being dropped.
 *
 * Cloud Gemini takes a whole lecture in one chunk (the default budget is
 * ~30k tokens); a small local model (v2) would pass a few thousand.
 */
export function chunkLines(
  lines: readonly TranscriptLine[],
  maxChars: number,
  timed: boolean,
): TranscriptLine[][] {
  const chunks: TranscriptLine[][] = []
  let cur: TranscriptLine[] = []
  let size = 0
  for (const line of lines) {
    const len = renderLine(line, timed).length + 1
    if (cur.length > 0 && size + len > maxChars) {
      chunks.push(cur)
      cur = []
      size = 0
    }
    cur.push(line)
    size += len
  }
  if (cur.length > 0) chunks.push(cur)
  return chunks
}

/**
 * The exact text the LLM sees. Timed lines carry the start second in brackets
 * ("[734] …") — the prompt asks the model to copy that number back as `t`,
 * which is far more reliable than asking it to do mm:ss arithmetic.
 */
export function renderLine(line: TranscriptLine, timed: boolean): string {
  return timed ? `[${Math.floor(line.start)}] ${line.text}` : line.text
}

export function renderLines(lines: readonly TranscriptLine[], timed: boolean): string {
  return lines.map((l) => renderLine(l, timed)).join('\n')
}
