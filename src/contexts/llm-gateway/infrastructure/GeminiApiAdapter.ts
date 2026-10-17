import type { LlmPort, LlmRequest } from '../application/LlmPort'
import { extractJson } from '../domain/extractJson'
import { LlmError, classifyHttpError } from '../domain/LlmError'
import { PROVIDERS, qualifiedModel, type ProviderPreset } from '../domain/providers'
import { RateLimiter, estimateTokens, sharedLimiter } from '../domain/RateLimiter'
import { schemaForPrompt } from '../domain/schemaConversion'
import {
  abortableSleep,
  attemptSignal,
  jsonInstruction,
  runWithRetries,
  safeJson,
  tag,
  toLlmError,
  type FetchLike,
  type SleepFn,
} from './http'

export type { FetchLike } from './http'

export const GEMINI_API_BASE = PROVIDERS.gemini.baseUrl

/**
 * Google's rolling alias for the current Flash model. Used as the default so a
 * model retirement doesn't silently break every install; users can pin a
 * specific model in Settings.
 */
export const DEFAULT_GEMINI_MODEL = PROVIDERS.gemini.defaultModel

export type GeminiApiAdapterOptions = {
  apiKey: string
  model?: string
  /** `PROVIDERS.gemini` (default) or `PROVIDERS.gemma` — same API, different JSON mode. */
  preset?: ProviderPreset
  fetch?: FetchLike
  /** Injectable for tests; must reject with an AbortError-like when aborted. */
  sleep?: SleepFn
  /** Total attempts for transient failures (429/5xx/network). */
  maxAttempts?: number
  /** Client-side pacing; default: the page-wide limiter for this provider. Null disables. */
  limiter?: RateLimiter | null
}

/**
 * Gemini API `generateContent` (Gemini and Gemma models).
 *  - Gemini: JSON-schema output via `responseSchema`, instructions via
 *    `systemInstruction`.
 *  - Gemma: neither is accepted reliably, so instructions and schema go into
 *    the prompt and the JSON is cut out of the answer.
 *
 * The key travels in the `x-goog-api-key` header, never in the URL, so it
 * cannot end up in logs or the Referer of anything. Retries, timeouts and
 * error tagging follow the shared policy in http.ts.
 */
export class GeminiApiAdapter implements LlmPort {
  readonly model: string
  readonly modelId: string
  readonly maxInputChars: number
  private readonly preset: ProviderPreset
  private readonly apiKey: string
  private readonly fetchImpl: FetchLike
  private readonly sleep: SleepFn
  private readonly maxAttempts: number
  private readonly limiter: RateLimiter | null

  constructor(opts: GeminiApiAdapterOptions) {
    this.preset = opts.preset ?? PROVIDERS.gemini
    this.apiKey = opts.apiKey.trim()
    this.model = (opts.model ?? '').trim().replace(/^models\//, '') || this.preset.defaultModel
    this.modelId = qualifiedModel(this.preset.id, this.model)
    this.maxInputChars = this.preset.maxInputChars
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.sleep = opts.sleep ?? abortableSleep
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 5)
    this.limiter =
      opts.limiter !== undefined
        ? opts.limiter
        : this.preset.limits
          ? sharedLimiter(this.modelId, this.preset.limits)
          : null
  }

  async generateJson(req: LlmRequest): Promise<unknown> {
    if (!this.apiKey) throw tag(new LlmError('no-key', `No ${this.preset.label} API key configured`), this.preset.label)
    return runWithRetries(() => this.callOnce(req), {
      maxAttempts: this.maxAttempts,
      sleep: this.sleep,
      provider: this.preset.label,
      ...(req.signal ? { signal: req.signal } : {}),
    })
  }

  /**
   * Cheapest possible key check: model metadata, no generation, no quota used.
   * Also validates the model name in the same round trip.
   */
  async testKey(signal?: AbortSignal): Promise<void> {
    if (!this.apiKey) throw tag(new LlmError('no-key', 'No API key configured'), this.preset.label)
    let res: Response
    try {
      res = await this.fetchImpl(`${this.preset.baseUrl}/${modelPath(this.model)}`, {
        method: 'GET',
        headers: { 'x-goog-api-key': this.apiKey },
        ...(signal ? { signal } : {}),
      })
    } catch (err) {
      throw tag(toLlmError(err), this.preset.label)
    }
    if (!res.ok) throw tag(classifyHttpError(res.status, await safeJson(res), res.headers), this.preset.label)
  }

  private async callOnce(req: LlmRequest): Promise<unknown> {
    const promptMode = this.preset.jsonMode === 'prompt'
    const body = promptMode
      ? {
          contents: [
            {
              role: 'user',
              parts: [{ text: `${req.system}\n\n${jsonInstruction(schemaForPrompt(req.schema))}\n\n${req.prompt}` }],
            },
          ],
          generationConfig: { temperature: 0 },
        }
      : {
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: req.schema,
          },
        }

    if (this.limiter) {
      const tokens = estimateTokens(req.system.length + req.prompt.length) + this.preset.outputReserveTokens
      const onWait = req.onWait
      await this.limiter.acquire(
        tokens,
        this.sleep,
        req.signal,
        onWait ? (ms) => onWait({ provider: this.preset.label, ms }) : undefined,
      )
    }

    const attempt = attemptSignal(req.signal, this.preset.timeoutMs)
    try {
      let res: Response
      try {
        res = await this.fetchImpl(`${this.preset.baseUrl}/${modelPath(this.model)}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
          signal: attempt.signal,
        })
      } catch (err) {
        throw toLlmError(err, attempt.timedOut())
      }
      const json = await safeJson(res)
      if (!res.ok) throw classifyHttpError(res.status, json, res.headers)
      const text = extractText(json)
      try {
        return promptMode ? extractJson(text) : JSON.parse(text)
      } catch {
        throw new LlmError('schema', 'The model returned malformed JSON')
      }
    } catch (err) {
      throw toLlmError(err, attempt.timedOut())
    } finally {
      attempt.done()
    }
  }
}

/** `generateContent` response → the text the model produced. */
export function extractText(json: unknown): string {
  if (!isRecord(json)) throw new LlmError('schema', 'Empty response from Gemini')

  const feedback = isRecord(json.promptFeedback) ? json.promptFeedback : null
  if (feedback && typeof feedback.blockReason === 'string') {
    throw new LlmError('blocked', `Blocked: ${feedback.blockReason}`)
  }

  const candidate = Array.isArray(json.candidates) && isRecord(json.candidates[0]) ? json.candidates[0] : null
  if (!candidate) throw new LlmError('schema', 'Gemini returned no candidates')

  const finish = typeof candidate.finishReason === 'string' ? candidate.finishReason : ''
  if (/^(SAFETY|RECITATION|BLOCKLIST|PROHIBITED_CONTENT|SPII)$/.test(finish)) {
    throw new LlmError('blocked', `Blocked: ${finish}`)
  }

  const content = isRecord(candidate.content) ? candidate.content : null
  const parts = content && Array.isArray(content.parts) ? content.parts : []
  // Thinking models may emit thought parts; only the answer parts matter.
  const text = parts
    .filter((p): p is Record<string, unknown> => isRecord(p) && p.thought !== true)
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim()

  if (!text) throw new LlmError('schema', `Gemini returned no text (finishReason ${finish || 'unknown'})`)
  if (finish === 'MAX_TOKENS') throw new LlmError('schema', 'Gemini output was cut off (MAX_TOKENS)')
  return text
}

function modelPath(model: string): string {
  return `models/${encodeURIComponent(model)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
