import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildConceptMap, toMarkdown, toTree } from '../../src/contexts/concept-mapping'
import { PROVIDERS, createAdapter, type ProviderId } from '../../src/contexts/llm-gateway'
import { manualTranscript, transcriptToLines } from '../../src/contexts/video-capture'

/**
 * Real round trips, one per provider whose key is available (env or
 * .env.local). Proves each request shape — schema mode, headers, model id —
 * is accepted by the live API, which no mocked test can show. Providers
 * without a key are skipped, not failed. Gemma needs GEMMA_LIVE=1: it is
 * correct but takes minutes.
 */
function envFile(): Record<string, string> {
  const file = resolve(__dirname, '../../.env.local')
  if (!existsSync(file)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m) out[m[1]!] = (m[2] ?? '').trim().replace(/^["']|["']$/g, '')
  }
  return out
}
const env = { ...envFile(), ...process.env } as Record<string, string | undefined>

const KEYS: Record<ProviderId, string | undefined> = {
  gemini: env.GEMINI_API_KEY ?? env.GOOGLE_AI_STUDIO_API_KEY,
  gemma: env.GEMMA_LIVE === '1' ? (env.GEMINI_API_KEY ?? env.GOOGLE_AI_STUDIO_API_KEY) : undefined,
  mistral: env.MISTRAL_API_KEY,
  groq: env.GROQ_API_KEY,
  openrouter: env.OPENROUTER_API_KEY,
  deepseek: env.DEEPSEEK_API_KEY,
}

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

for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
  const key = KEYS[id]
  describe.skipIf(!key)(`${PROVIDERS[id].label} live`, () => {
    it('key + default model are accepted', async () => {
      await createAdapter(id, { apiKey: key! }).testKey()
    })

    it('builds a concept map end to end', { timeout: PROVIDERS[id].timeoutMs * 3 }, async () => {
      const llm = createAdapter(id, { apiKey: key! })
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
      console.log(`--- ${PROVIDERS[id].label}: ${map.concepts.length} concepts, ${map.relations.length} relations, ${map.model}`)
      console.log(toMarkdown(map, toTree(map)))

      const terms = map.concepts.map((c) => c.term.toLowerCase())
      expect(terms.some((x) => x.includes('derivative'))).toBe(true)
      expect(terms.some((x) => x.includes('limit'))).toBe(true)
      expect(map.concepts.every((c) => c.t === null || (c.t >= 0 && c.t <= 240))).toBe(true)
      expect(map.model.startsWith(`${id}:`)).toBe(true)
      // p2: the notes need a plain-language summary and a Wikipedia title per concept.
      expect(map.concepts.filter((c) => c.summary).length).toBeGreaterThanOrEqual(map.concepts.length / 2)
      expect(map.concepts.filter((c) => c.refTitle).length).toBeGreaterThanOrEqual(map.concepts.length / 2)
      expect(map.field).toBe('math')
    })
  })
}
