/**
 * The only thing the rest of the extension knows about language models.
 * Implementations: GeminiApiAdapter (Gemini, Gemma), OpenAiCompatibleAdapter
 * (Mistral, Groq, OpenRouter, DeepSeek) and FallbackLlm, which chains them.
 */
import type { JsonSchema } from '../domain/JsonSchema'

export type { JsonSchema }

export type LlmRequest = {
  system: string
  prompt: string
  schema: JsonSchema
  signal?: AbortSignal
  /**
   * Client-side pacing is holding this request back for `ms` (a small
   * per-minute budget, e.g. Groq's). Silence here looks like a hang.
   */
  onWait?: (e: { provider: string; ms: number }) => void
}

export interface LlmPort {
  /**
   * "<provider>:<model>" — part of the map cache key, so a different model
   * never reuses another's map. For a chain it names whoever answered last
   * (or every provider used, joined with " + "), so read it AFTER the calls.
   */
  readonly modelId: string
  /**
   * Largest transcript chunk (in characters) a request should carry. For a
   * chain: the budget of the provider currently in front.
   */
  readonly maxInputChars: number
  /** Resolves to parsed JSON matching `schema` in shape; throws LlmError. */
  generateJson(req: LlmRequest): Promise<unknown>
}
