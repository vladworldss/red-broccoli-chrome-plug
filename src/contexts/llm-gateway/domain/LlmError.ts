/**
 * Provider-neutral failure taxonomy. Each kind maps to one thing the user can
 * do about it (fix the key, wait, retry, shorten the input, switch provider),
 * which is all the UI — and the fallback chain — needs to know.
 */
export type LlmErrorKind =
  | 'no-key'
  | 'auth'
  | 'billing'
  | 'rate-limit'
  | 'daily-quota'
  | 'too-large'
  | 'bad-request'
  | 'server'
  | 'network'
  | 'timeout'
  | 'schema'
  | 'blocked'
  | 'aborted'

/**
 * Which quota a 429 tripped, as far as the response says. No provider offers
 * an API to read the remaining quota up front — a 429 is the only place this
 * information ever appears.
 */
export type QuotaInfo = {
  scope: 'minute' | 'day' | 'unknown'
  metric: 'requests' | 'tokens' | 'unknown'
  /** The quota's ceiling (e.g. 250 requests/day), when reported. */
  limit?: number
  model?: string
}

export type LlmErrorOptions = {
  status?: number
  retryAfterMs?: number
  quota?: QuotaInfo
  /** Human label of the provider that failed ("Gemini", "Groq"…). */
  provider?: string
}

export class LlmError extends Error {
  readonly kind: LlmErrorKind
  readonly status: number | undefined
  /** Server-suggested wait before retrying (Retry-After / RetryInfo), if any. */
  readonly retryAfterMs: number | undefined
  readonly quota: QuotaInfo | undefined
  /** Set by the adapter that threw; read by messages and the fallback chain. */
  provider: string | undefined

  constructor(kind: LlmErrorKind, message: string, opts: LlmErrorOptions = {}) {
    super(message)
    this.name = 'LlmError'
    this.kind = kind
    this.status = opts.status
    this.retryAfterMs = opts.retryAfterMs
    this.quota = opts.quota
    this.provider = opts.provider
  }

  /**
   * Transient: worth retrying the SAME request at the SAME provider after a
   * pause. `daily-quota` (resets in hours), `timeout` (a slow provider stays
   * slow) and `too-large` (the same input stays too large) are deliberately
   * not here — the fallback chain moves on instead.
   */
  get retryable(): boolean {
    return this.kind === 'rate-limit' || this.kind === 'server' || this.kind === 'network'
  }
}

/** The slice of `Headers` we read; plain objects work in tests. */
export type HeaderLike = { get(name: string): string | null }

/**
 * HTTP status + parsed error body (+ headers) → LlmError. Understands both
 * Google's shape (`{error:{message, details:[QuotaFailure, RetryInfo]}}`) and
 * the OpenAI-compatible ones (`{error:{message,code}}`, Mistral's top-level
 * `{message}`), plus the `Retry-After` header.
 *
 * Google returns 400 (not 401) with API_KEY_INVALID for a bad key, and Groq
 * returns 413 for a single request larger than its per-minute token budget,
 * so bodies are inspected, not just statuses.
 */
export function classifyHttpError(status: number, body: unknown, headers?: HeaderLike): LlmError {
  const err = isRecord(body) && isRecord(body.error) ? body.error : null
  const message = messageOf(body, err) ?? `HTTP ${status}`
  const blob = JSON.stringify(body ?? '')

  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(blob)) {
    return new LlmError('auth', message, { status })
  }
  if (status === 401 || status === 403) return new LlmError('auth', message, { status })
  if (status === 402) return new LlmError('billing', message, { status })
  if (status === 413 || (status === 400 && TOO_LARGE.test(message))) {
    return new LlmError('too-large', message, { status })
  }
  if (status === 429) {
    const quota = quotaInfo(err, message)
    const retryAfterMs = retryAfterHeaderMs(headers) ?? retryDelayMs(err, message)
    return new LlmError(quota.scope === 'day' ? 'daily-quota' : 'rate-limit', message, {
      status,
      quota,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    })
  }
  if (status === 404) return new LlmError('bad-request', message, { status })
  if (status >= 500) return new LlmError('server', message, { status })
  return new LlmError('bad-request', message, { status })
}

const TOO_LARGE = /context length|context window|too long|too large|maximum (?:context|input)|reduce the length/i

/** Providers whose daily quotas reset at midnight Pacific (Google's). */
const PACIFIC_RESET = new Set(['Gemini', 'Gemma'])

/** Short, actionable text for the side panel. `now` is injectable for tests. */
export function describeLlmError(err: LlmError, now: Date = new Date()): string {
  const p = err.provider ?? 'Gemini'
  switch (err.kind) {
    case 'no-key':
      return `Add your ${p} API key in Settings first.`
    case 'auth':
      return `${p} rejected the API key. Check it in Settings.`
    case 'billing':
      return `${p} says the account has no credit left. Top it up or use another provider.`
    case 'rate-limit': {
      const what =
        err.quota?.metric === 'tokens'
          ? ' (tokens per minute)'
          : err.quota?.scope === 'minute'
            ? ' (requests per minute)'
            : ''
      const wait = err.retryAfterMs !== undefined ? `in ${Math.max(1, Math.ceil(err.retryAfterMs / 1000))} s` : 'in a minute'
      return `${p} rate limit reached${what}. Try again ${wait}.`
    }
    case 'daily-quota': {
      const model = err.quota?.model ? ` for ${err.quota.model}` : ''
      const unit = err.quota?.metric === 'tokens' ? 'tokens' : 'requests'
      const limit = err.quota?.limit !== undefined ? ` (limit ${err.quota.limit} ${unit}/day)` : ''
      const reset = PACIFIC_RESET.has(p)
        ? ` It resets at midnight Pacific time — in about ${formatDuration(msUntilPacificMidnight(now))}.`
        : ''
      return `Daily ${p} quota used up${model}${limit}.${reset} You can pick another model or provider in Settings.`
    }
    case 'too-large':
      return `The transcript is too long for ${p} in one request.`
    case 'bad-request':
      return err.status === 404
        ? `Unknown model name for ${p}. Check the model in Settings.`
        : `${p} rejected the request: ${err.message}`
    case 'server':
      return err.status === 503
        ? `${p} is overloaded right now. Try again in a minute, or choose another model in Settings.`
        : `${p} is having trouble right now. Try again shortly.`
    case 'network':
      return `Could not reach ${p}. Check your connection.`
    case 'timeout':
      return `${p} didn't answer in time.`
    case 'schema':
      return `${p} returned an unexpected answer. Try Rebuild.`
    case 'blocked':
      return `${p} declined to process this transcript.`
    case 'aborted':
      return 'Cancelled.'
  }
}

/** One short clause per provider, for the "all providers failed" list. */
export function describeLlmErrorShort(err: LlmError, now: Date = new Date()): string {
  switch (err.kind) {
    case 'no-key':
      return 'no API key'
    case 'auth':
      return 'API key rejected'
    case 'billing':
      return 'no credit left'
    case 'rate-limit':
      return err.retryAfterMs !== undefined
        ? `rate limit — try in ${Math.max(1, Math.ceil(err.retryAfterMs / 1000))} s`
        : 'rate limit'
    case 'daily-quota':
      return PACIFIC_RESET.has(err.provider ?? 'Gemini')
        ? `daily quota used up (resets in ${formatDuration(msUntilPacificMidnight(now))})`
        : 'daily quota used up'
    case 'too-large':
      return 'transcript too long for one request'
    case 'bad-request':
      return err.status === 404 ? 'unknown model' : 'request rejected'
    case 'server':
      return err.status === 503 ? 'overloaded' : 'server error'
    case 'network':
      return 'unreachable'
    case 'timeout':
      return 'timed out'
    case 'schema':
      return 'unexpected answer'
    case 'blocked':
      return 'declined the content'
    case 'aborted':
      return 'cancelled'
  }
}

// ---------------------------------------------------------------------------
// 429 body parsing
// ---------------------------------------------------------------------------

function messageOf(body: unknown, err: Record<string, unknown> | null): string | undefined {
  if (err && typeof err.message === 'string') return err.message
  if (isRecord(body)) {
    if (typeof body.message === 'string') return body.message // Mistral
    if (typeof body.detail === 'string') return body.detail
    if (typeof body.error === 'string') return body.error
  }
  return undefined
}

/**
 * google.rpc.QuotaFailure:
 *   details: [{ "@type": "…QuotaFailure", violations: [{
 *     quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
 *     quotaValue: "250", quotaDimensions: { model: "gemini-2.5-flash" } }] }]
 * Otherwise the human message, e.g. Groq's "…on tokens per day (TPD): Limit
 * 100000…" or OpenRouter's "…free-models-per-day…".
 */
function quotaInfo(err: Record<string, unknown> | null, message: string): QuotaInfo {
  const details = err && Array.isArray(err.details) ? err.details : []
  for (const d of details) {
    if (!isRecord(d) || typeof d['@type'] !== 'string' || !d['@type'].endsWith('QuotaFailure')) continue
    const v = Array.isArray(d.violations) ? d.violations.find(isRecord) : undefined
    if (!v) continue
    const id = [v.quotaId, v.quotaMetric].filter((x) => typeof x === 'string').join(' ')
    const dims = isRecord(v.quotaDimensions) ? v.quotaDimensions : {}
    const limit = Number(v.quotaValue)
    return {
      scope: scopeOf(id),
      metric: metricOf(id),
      ...(Number.isFinite(limit) && v.quotaValue !== undefined ? { limit } : {}),
      ...(typeof dims.model === 'string' ? { model: dims.model } : {}),
    }
  }

  const limit = /limit:?\s*(\d+)/i.exec(message)?.[1]
  // Dots only BETWEEN parts: keeps "gemini-2.5-flash", drops a sentence's final period.
  const model = /model:\s*([\w-]+(?:\.[\w-]+)*)/i.exec(message)?.[1]
  return {
    scope: scopeOf(message),
    metric: metricOf(message),
    ...(limit ? { limit: Number(limit) } : {}),
    ...(model ? { model } : {}),
  }
}

function scopeOf(text: string): QuotaInfo['scope'] {
  if (/per[\s-]*day|PerDay|daily|\((?:TPD|RPD)\)/i.test(text)) return 'day'
  if (/per[\s-]*minute|PerMinute|\((?:TPM|RPM)\)/i.test(text)) return 'minute'
  return 'unknown'
}

function metricOf(text: string): QuotaInfo['metric'] {
  if (/token|\(TP[MD]\)/i.test(text)) return 'tokens'
  if (/request|\(RP[MD]\)/i.test(text)) return 'requests'
  return 'unknown'
}

/** `Retry-After: 17` (seconds) or an HTTP date. */
function retryAfterHeaderMs(headers: HeaderLike | undefined): number | undefined {
  const raw = headers?.get('retry-after')
  if (!raw) return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000))
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

/**
 * google.rpc.RetryInfo `retryDelay: "41s"`, or the message's "Please retry in
 * 41.6s." / Groq's "Please try again in 1m26.4s".
 */
function retryDelayMs(err: Record<string, unknown> | null, message: string): number | undefined {
  const details = err && Array.isArray(err.details) ? err.details : []
  for (const d of details) {
    if (!isRecord(d) || typeof d.retryDelay !== 'string') continue
    const m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay)
    if (m) return Math.round(Number(m[1]) * 1000)
  }
  const m = /(?:retry|try again) in\s*(?:(\d+)m)?\s*(\d+(?:\.\d+)?)\s*s/i.exec(message)
  return m ? Math.round((Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000) : undefined
}

// ---------------------------------------------------------------------------
// Daily reset time (Google)
// ---------------------------------------------------------------------------

const PACIFIC = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
})

/** Wall-clock time in Los Angeles, encoded as if it were a UTC instant. */
function pacificWallAsUtc(d: Date): number {
  const p: Record<string, number> = {}
  for (const part of PACIFIC.formatToParts(d)) p[part.type] = Number(part.value)
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!)
}

/**
 * Milliseconds until the next midnight in America/Los_Angeles, when Gemini's
 * daily quotas reset. DST-correct: on transition days the answer is 23 h or
 * 25 h from the previous midnight, not a naive 24 h.
 */
export function msUntilPacificMidnight(now: Date): number {
  const nowSec = Math.floor(now.getTime() / 1000) * 1000
  const offset = (d: Date) => pacificWallAsUtc(d) - Math.floor(d.getTime() / 1000) * 1000
  const wall = new Date(pacificWallAsUtc(now))
  const nextMidnightWall = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1)
  // Two passes: the offset at "now" may differ from the offset at midnight (DST).
  let instant = nextMidnightWall - offset(now)
  instant = nextMidnightWall - offset(new Date(instant))
  return Math.max(0, instant - nowSec)
}

function formatDuration(ms: number): string {
  const totalMin = Math.max(1, Math.round(ms / 60_000))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h} h ${m} min` : `${m} min`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
