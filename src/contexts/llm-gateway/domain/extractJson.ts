/**
 * Pulls the JSON object out of a model's free-text answer, for providers
 * without a strict JSON mode. Handles the usual wrappings:
 *   ```json { … } ```   |   "Sure! Here it is: { … } Hope it helps."
 * Returns the parsed value, or throws SyntaxError when there is no valid
 * object — the caller maps that to a `schema` error (one retry, then fallback).
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // fall through to the forgiving paths
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim())
    } catch {
      // fall through
    }
  }

  const start = trimmed.indexOf('{')
  if (start >= 0) {
    // Scan to the matching closing brace, skipping braces inside strings.
    let depth = 0
    let inString = false
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (inString) {
        if (ch === '\\') i++
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) return JSON.parse(trimmed.slice(start, i + 1))
    }
  }
  throw new SyntaxError('No JSON object in the model answer')
}
