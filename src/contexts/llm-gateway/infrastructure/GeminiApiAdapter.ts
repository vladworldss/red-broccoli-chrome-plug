import type { LlmPort, LlmRequest } from '../application/LlmPort'
import { classifyHttpError, LlmError } from '../domain/LlmError'

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

/**
 * Google's rolling alias for the current Flash model. Used as the default so a
 * model retirement doesn't silently break every install; users can pin a
 * specific model in Settings.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type GeminiApiAdapterOptions = {
  apiKey: string
  model?: string
  fetch?: FetchLike
  /** Injectable for tests; must reject with an AbortError-like when aborted. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Total attempts for transient failures (429/5xx/network). */
  maxAttempts?: number
}

/**
 * Gemini `generateContent` with JSON-schema output.
 *
 * Retry policy:
 *  - 429 / 5xx / network: up to `maxAttempts` total, waiting the server's
 *    RetryInfo delay (capped) or exponential backoff 2s, 4s, 8s, 16s. The
 *    free tier answers 503 "high demand" in bursts that usually clear within
 *    ~30s, so the budget is sized for that; the panel offers Cancel meanwhile.
 *  - unparseable/truncated JSON: exactly one more attempt.
 *  - auth / bad request / blocked: never retried — the same request will fail
 *    the same way.
 *
 * The key travels in the `x-goog-api-key` header, never in the URL, so it
 * cannot end up in logs or the Referer of anything.
 */
export class GeminiApiAdapter implements LlmPort {
  readonly modelId: string
  private readonly apiKey: string
  private readonly fetchImpl: FetchLike
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly maxAttempts: number

  constructor(opts: GeminiApiAdapterOptions) {
    this.apiKey = opts.apiKey.trim()
    this.modelId = (opts.model ?? '').trim() || DEFAULT_GEMINI_MODEL
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.sleep = opts.sleep ?? abortableSleep
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 5)
  }

  async generateJson(req: LlmRequest): Promise<unknown> {
    if (!this.apiKey) throw new LlmError('no-key', 'No Gemini API key configured')

    let schemaRetried = false
    for (let attempt = 1; ; attempt++) {
      try {
        const text = await this.callOnce(req)
        try {
          return JSON.parse(text)
        } catch {
          throw new LlmError('schema', 'Gemini returned malformed JSON')
        }
      } catch (err) {
        const e = toLlmError(err)
        if (e.kind === 'schema' && !schemaRetried) {
          schemaRetried = true
          continue
        }
        if (!e.retryable || attempt >= this.maxAttempts) throw e
        const backoff = 2000 * 2 ** (attempt - 1)
        await this.sleep(Math.min(e.retryAfterMs ?? backoff, 30_000), req.signal).catch(() => {
          throw new LlmError('aborted', 'Aborted')
        })
      }
    }
  }

  /**
   * Cheapest possible key check: model metadata, no generation, no quota used.
   * Also validates the model name in the same round trip.
   */
  async testKey(signal?: AbortSignal): Promise<void> {
    if (!this.apiKey) throw new LlmError('no-key', 'No Gemini API key configured')
    let res: Response
    try {
      res = await this.fetchImpl(`${GEMINI_API_BASE}/${modelPath(this.modelId)}`, {
        method: 'GET',
        headers: { 'x-goog-api-key': this.apiKey },
        ...(signal ? { signal } : {}),
      })
    } catch (err) {
      throw toLlmError(err)
    }
    if (!res.ok) throw classifyHttpError(res.status, await safeJson(res))
  }

  private async callOnce(req: LlmRequest): Promise<string> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: req.schema,
      },
    }

    let res: Response
    try {
      res = await this.fetchImpl(`${GEMINI_API_BASE}/${modelPath(this.modelId)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        ...(req.signal ? { signal: req.signal } : {}),
      })
    } catch (err) {
      throw toLlmError(err)
    }

    const json = await safeJson(res)
    if (!res.ok) throw classifyHttpError(res.status, json)
    return extractText(json)
  }
}

/** `generateContent` response → the JSON text the model produced. */
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
  // Thinking models may emit thought parts; only the answer parts are JSON.
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
  const name = model.startsWith('models/') ? model.slice('models/'.length) : model
  return `models/${encodeURIComponent(name)}`
}

function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err
  if (isAbort(err)) return new LlmError('aborted', 'Aborted')
  return new LlmError('network', err instanceof Error ? err.message : String(err))
}

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
