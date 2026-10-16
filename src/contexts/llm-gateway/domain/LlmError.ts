/**
 * Provider-neutral failure taxonomy. Each kind maps to one thing the user can
 * do about it (fix the key, wait, retry, shorten the input), which is all the
 * UI needs to know.
 */
export type LlmErrorKind =
  | 'no-key'
  | 'auth'
  | 'rate-limit'
  | 'daily-quota'
  | 'bad-request'
  | 'server'
  | 'network'
  | 'schema'
  | 'blocked'
  | 'aborted'

/**
 * Which quota a 429 tripped, as far as the response says. Gemini limits are
 * per project and per model, on three axes: requests/minute, tokens/minute,
 * requests/day. There is no API to read the remaining quota up front — a 429
 * is the only place this information ever appears.
 */
export type QuotaInfo = {
  scope: 'minute' | 'day' | 'unknown'
  metric: 'requests' | 'tokens' | 'unknown'
  /** The quota's ceiling (e.g. 250 requests/day), when reported. */
  limit?: number
  model?: string
}

export class LlmError extends Error {
  readonly kind: LlmErrorKind
  readonly status: number | undefined
  /** Server-suggested wait before retrying (429 RetryInfo), if any. */
  readonly retryAfterMs: number | undefined
  readonly quota: QuotaInfo | undefined

  constructor(
    kind: LlmErrorKind,
    message: string,
    opts: { status?: number; retryAfterMs?: number; quota?: QuotaInfo } = {},
  ) {
    super(message)
    this.name = 'LlmError'
    this.kind = kind
    this.status = opts.status
    this.retryAfterMs = opts.retryAfterMs
    this.quota = opts.quota
  }

  /**
   * Transient: worth retrying the same request after a pause. `daily-quota`
   * is deliberately NOT here — it resets at midnight Pacific, so every retry
   * would only burn time.
   */
  get retryable(): boolean {
    return this.kind === 'rate-limit' || this.kind === 'server' || this.kind === 'network'
  }
}

/**
 * HTTP status + parsed error body → LlmError. Google returns 400 (not 401) with
 * reason API_KEY_INVALID for a bad key, so the body is inspected too.
 */
export function classifyHttpError(status: number, body: unknown): LlmError {
  const err = isRecord(body) && isRecord(body.error) ? body.error : null
  const message = err && typeof err.message === 'string' ? err.message : `HTTP ${status}`
  const blob = JSON.stringify(body ?? '')

  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(blob)) {
    return new LlmError('auth', message, { status })
  }
  if (status === 401 || status === 403) return new LlmError('auth', message, { status })
  if (status === 429) {
    const quota = quotaInfo(err, message)
    const retryAfterMs = retryDelayMs(err, message)
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

/** Short, actionable text for the side panel. `now` is injectable for tests. */
export function describeLlmError(err: LlmError, now: Date = new Date()): string {
  switch (err.kind) {
    case 'no-key':
      return 'Add your Gemini API key in Settings first.'
    case 'auth':
      return 'Gemini rejected the API key. Check it in Settings.'
    case 'rate-limit': {
      const what = err.quota?.metric === 'tokens' ? ' (tokens per minute)' : err.quota?.scope === 'minute' ? ' (requests per minute)' : ''
      const wait = err.retryAfterMs !== undefined ? `in ${Math.max(1, Math.ceil(err.retryAfterMs / 1000))} s` : 'in a minute'
      return `Gemini rate limit reached${what}. Try again ${wait}.`
    }
    case 'daily-quota': {
      const model = err.quota?.model ? ` for ${err.quota.model}` : ''
      const unit = err.quota?.metric === 'tokens' ? 'tokens' : 'requests'
      const limit = err.quota?.limit !== undefined ? ` (limit ${err.quota.limit} ${unit}/day)` : ''
      return (
        `Daily Gemini quota used up${model}${limit}. ` +
        `It resets at midnight Pacific time — in about ${formatDuration(msUntilPacificMidnight(now))}. ` +
        'You can pick another model in Settings.'
      )
    }
    case 'bad-request':
      return err.status === 404
        ? 'Unknown model name. Check the model in Settings.'
        : `Gemini rejected the request: ${err.message}`
    case 'server':
      return err.status === 503
        ? 'Gemini is overloaded right now. Try again in a minute, or choose another model in Settings.'
        : 'Gemini is having trouble right now. Try again shortly.'
    case 'network':
      return 'Could not reach Gemini. Check your connection.'
    case 'schema':
      return 'Gemini returned an unexpected answer. Try Rebuild.'
    case 'blocked':
      return 'Gemini declined to process this transcript.'
    case 'aborted':
      return 'Cancelled.'
  }
}

// ---------------------------------------------------------------------------
// 429 body parsing
// ---------------------------------------------------------------------------

/**
 * google.rpc.QuotaFailure:
 *   details: [{ "@type": "…QuotaFailure", violations: [{
 *     quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
 *     quotaValue: "250", quotaDimensions: { model: "gemini-2.5-flash" } }] }]
 * Falls back to the human message ("…per day…", "limit: 250, model: …") when
 * the structured details are missing.
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

  const limit = /limit:\s*(\d+)/i.exec(message)?.[1]
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
  if (/per\s*day|PerDay|daily/i.test(text)) return 'day'
  if (/per\s*minute|PerMinute/i.test(text)) return 'minute'
  return 'unknown'
}

function metricOf(text: string): QuotaInfo['metric'] {
  if (/token/i.test(text)) return 'tokens'
  if (/request/i.test(text)) return 'requests'
  return 'unknown'
}

/**
 * google.rpc.RetryInfo `retryDelay: "41s"`, or the message's
 * "Please retry in 41.6s." when the details are missing.
 */
function retryDelayMs(err: Record<string, unknown> | null, message: string): number | undefined {
  const details = err && Array.isArray(err.details) ? err.details : []
  for (const d of details) {
    if (!isRecord(d) || typeof d.retryDelay !== 'string') continue
    const m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay)
    if (m) return Math.round(Number(m[1]) * 1000)
  }
  const m = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(message)
  return m ? Math.round(Number(m[1]) * 1000) : undefined
}

// ---------------------------------------------------------------------------
// Daily reset time
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
