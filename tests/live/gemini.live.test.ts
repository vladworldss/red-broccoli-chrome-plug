import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildConceptMap, toMarkdown, toTree } from '../../src/contexts/concept-mapping'
import { GeminiApiAdapter } from '../../src/contexts/llm-gateway'
import { manualTranscript, transcriptToLines } from '../../src/contexts/video-capture'

/**
 * Real Gemini round trip with a tiny synthetic lecture. Proves the request
 * shape (responseSchema, model alias, headers) is accepted by the live API —
 * something no mocked test can show.
 *
 * Key: GOOGLE_AI_STUDIO_API_KEY or GEMINI_API_KEY, from the env or .env.local.
 * Skips (does not fail) when no key is available.
 */
function apiKey(): string {
  const fromEnv = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_STUDIO_API_KEY
  if (fromEnv) return fromEnv.trim()
  const file = resolve(__dirname, '../../.env.local')
  if (!existsSync(file)) return ''
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(GEMINI_API_KEY|GOOGLE_AI_STUDIO_API_KEY)\s*=\s*(.*)$/.exec(line)
    if (m) return (m[2] ?? '').trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

const KEY = apiKey()
const LECTURE = `0:00
Today we start calculus. Calculus is the mathematics of change.
0:15
First we need the idea of a limit: the value a function approaches as x gets close to a point.
1:05
Using limits we define the derivative, written f prime of x, as the limit of the difference quotient.
2:10
The derivative gives the slope of the tangent line, and it obeys rules: the sum rule, the product rule and the chain rule.
3:30
Finally, setting the derivative to zero helps us find extrema, the maxima and minima of a function.`

describe.skipIf(!KEY)('Gemini live', () => {
  it('key + model alias are accepted', async () => {
    await new GeminiApiAdapter({ apiKey: KEY }).testKey()
  })

  it('builds a concept map end to end', async () => {
    const llm = new GeminiApiAdapter({ apiKey: KEY })
    const t = manualTranscript('dQw4w9WgXcQ', LECTURE)!
    const { map } = await buildConceptMap(
      {
        videoId: t.videoId,
        title: 'Calculus 1: limits and derivatives',
        lang: 'en',
        durationSec: 240,
        lines: transcriptToLines(t),
        timed: true,
        outputLanguage: 'auto',
      },
      { llm },
    )
    console.log(toMarkdown(map, toTree(map)))
    console.log(`${map.concepts.length} concepts, ${map.relations.length} relations, model ${map.model}`)

    const terms = map.concepts.map((c) => c.term.toLowerCase())
    expect(terms.some((x) => x.includes('derivative'))).toBe(true)
    expect(terms.some((x) => x.includes('limit'))).toBe(true)
    expect(map.concepts.every((c) => c.t === null || (c.t >= 0 && c.t <= 240))).toBe(true)
    expect(map.relations.length).toBeGreaterThan(0)
  })
})
