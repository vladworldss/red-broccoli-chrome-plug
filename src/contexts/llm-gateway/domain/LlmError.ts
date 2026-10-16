/**
 * Provider-neutral failure taxonomy. Each kind maps to one thing the user can
 * do about it (fix the key, wait, retry, shorten the input), which is all the
 * UI needs to know.
 */
export type LlmErrorKind =
  | 'no-key'
  | 'auth'
  | 'rate-limit'
  | 'bad-request'
  | 'server'
  | 'network'
  | 'schema'
  | 'blocked'
  | 'aborted'

export class LlmError extends Error {
  readonly kind: LlmErrorKind
  readonly status: number | undefined
  /** Server-suggested wait before retrying (429 RetryInfo), if any. */
  readonly retryAfterMs: number | undefined

  constructor(kind: LlmErrorKind, message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(message)
    this.name = 'LlmError'
    this.kind = kind
    this.status = opts.status
    this.retryAfterMs = opts.retryAfterMs
  }

  /** Transient: worth retrying the same request after a pause. */
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
    const retryAfterMs = retryDelayMs(err)
    return new LlmError('rate-limit', message, retryAfterMs !== undefined ? { status, retryAfterMs } : { status })
  }
  if (status === 404) return new LlmError('bad-request', message, { status })
  if (status >= 500) return new LlmError('server', message, { status })
  return new LlmError('bad-request', message, { status })
}

/** Short, actionable text for the side panel. */
export function describeLlmError(err: LlmError): string {
  switch (err.kind) {
    case 'no-key':
      return 'Add your Gemini API key in Settings first.'
    case 'auth':
      return 'Gemini rejected the API key. Check it in Settings.'
    case 'rate-limit':
      return 'Gemini rate limit reached. Wait a minute and try again.'
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

/** google.rpc.RetryInfo: `details:[{"@type":"…RetryInfo","retryDelay":"17s"}]`. */
function retryDelayMs(err: Record<string, unknown> | null): number | undefined {
  const details = err && Array.isArray(err.details) ? err.details : []
  for (const d of details) {
    if (!isRecord(d) || typeof d.retryDelay !== 'string') continue
    const m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay)
    if (m) return Math.round(Number(m[1]) * 1000)
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
