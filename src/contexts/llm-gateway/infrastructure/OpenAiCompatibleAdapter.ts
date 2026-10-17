import type { LlmPort, LlmRequest } from '../application/LlmPort'
import { extractJson } from '../domain/extractJson'
import { LlmError, classifyHttpError } from '../domain/LlmError'
import { qualifiedModel, type JsonMode, type ProviderPreset } from '../domain/providers'
import { RateLimiter, estimateTokens, sharedLimiter } from '../domain/RateLimiter'
import { schemaForPrompt, toStandardJsonSchema } from '../domain/schemaConversion'
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

export type OpenAiCompatibleAdapterOptions = {
  preset: ProviderPreset
  apiKey: string
  model?: string
  fetch?: FetchLike
  sleep?: SleepFn
  maxAttempts?: number
  /** Client-side pacing; default: the page-wide limiter for this provider. Null disables. */
  limiter?: RateLimiter | null
}

/**
 * `POST {baseUrl}/chat/completions` — the OpenAI-compatible dialect spoken by
 * Mistral, Groq, OpenRouter and DeepSeek. One class, configured by a preset.
 *
 * JSON output follows the preset's `jsonMode`:
 *  - json-schema → strict `response_format.json_schema` (our schema converted).
 *    If the provider/model rejects it (400), the adapter drops to json-object
 *    for the rest of its life instead of failing — models change under us.
 *  - json-object → `response_format: {type:'json_object'}` + schema in the
 *    system prompt (which also satisfies DeepSeek's "must mention JSON" rule).
 * The reply is always run through `extractJson`, which tolerates code fences.
 */
export class OpenAiCompatibleAdapter implements LlmPort {
  readonly model: string
  readonly modelId: string
  readonly maxInputChars: number
  private readonly preset: ProviderPreset
  private readonly apiKey: string
  private readonly fetchImpl: FetchLike
  private readonly sleep: SleepFn
  private readonly maxAttempts: number
  private readonly limiter: RateLimiter | null
  private degraded = false

  constructor(opts: OpenAiCompatibleAdapterOptions) {
    this.preset = opts.preset
    this.apiKey = opts.apiKey.trim()
    this.model = (opts.model ?? '').trim() || opts.preset.defaultModel
    this.modelId = qualifiedModel(opts.preset.id, this.model)
    this.maxInputChars = opts.preset.maxInputChars
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.sleep = opts.sleep ?? abortableSleep
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 5)
    this.limiter =
      opts.limiter !== undefined
        ? opts.limiter
        : opts.preset.limits
          ? sharedLimiter(this.modelId, opts.preset.limits)
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

  /** `GET /models` — validates the key without spending generation quota. */
  async testKey(signal?: AbortSignal): Promise<void> {
    if (!this.apiKey) throw tag(new LlmError('no-key', 'No API key configured'), this.preset.label)
    let res: Response
    try {
      res = await this.fetchImpl(`${this.preset.baseUrl}/models`, {
        method: 'GET',
        headers: this.headers(),
        ...(signal ? { signal } : {}),
      })
    } catch (err) {
      throw tag(toLlmError(err), this.preset.label)
    }
    if (!res.ok) throw tag(classifyHttpError(res.status, await safeJson(res), res.headers), this.preset.label)
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
      // OpenRouter's app attribution; harmless elsewhere, so only sent there.
      ...(this.preset.id === 'openrouter' ? { 'X-Title': 'StudHelper' } : {}),
    }
  }

  private body(req: LlmRequest, mode: JsonMode): Record<string, unknown> {
    const schemaInPrompt = mode !== 'json-schema'
    const system = schemaInPrompt ? `${req.system}\n\n${jsonInstruction(schemaForPrompt(req.schema))}` : req.system
    return {
      model: this.model,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: req.prompt },
      ],
      ...(mode === 'json-schema'
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'studhelper', strict: true, schema: toStandardJsonSchema(req.schema) },
            },
          }
        : mode === 'json-object'
          ? { response_format: { type: 'json_object' } }
          : {}),
      ...(this.preset.extraBody ?? {}),
    }
  }

  private async callOnce(req: LlmRequest): Promise<unknown> {
    const mode: JsonMode = this.degraded && this.preset.jsonMode === 'json-schema' ? 'json-object' : this.preset.jsonMode

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
        res = await this.fetchImpl(`${this.preset.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(this.body(req, mode)),
          signal: attempt.signal,
        })
      } catch (err) {
        throw toLlmError(err, attempt.timedOut())
      }
      // Groq (and OpenAI-style APIs) say how much of the minute's budget is
      // left; trust that over our own estimate for the next request.
      const remaining = res.headers.get('x-ratelimit-remaining-tokens')
      if (this.limiter && remaining !== null && remaining.trim() !== '') this.limiter.sync(Number(remaining))
      const json = await safeJson(res)
      if (!res.ok) {
        const err = classifyHttpError(res.status, json, res.headers)
        if (err.kind === 'bad-request' && mode === 'json-schema' && err.status === 400) {
          // Model doesn't do strict schemas (anymore): degrade once and redo.
          this.degraded = true
          return this.callOnce(req)
        }
        throw err
      }
      const text = choiceText(json)
      try {
        return extractJson(text)
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

/** `choices[0].message.content` of a chat completion, with the usual failure modes. */
export function choiceText(json: unknown): string {
  const choice =
    isRecord(json) && Array.isArray(json.choices) && isRecord(json.choices[0]) ? json.choices[0] : null
  if (!choice) throw new LlmError('schema', 'The model returned no choices')
  const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : ''
  if (finish === 'content_filter') throw new LlmError('blocked', 'Blocked by the content filter')
  const message = isRecord(choice.message) ? choice.message : null
  const content = message && typeof message.content === 'string' ? message.content.trim() : ''
  if (!content) throw new LlmError('schema', `The model returned no text (finish_reason ${finish || 'unknown'})`)
  if (finish === 'length') throw new LlmError('schema', 'The model output was cut off (length)')
  return content
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
