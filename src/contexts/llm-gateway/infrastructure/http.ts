/**
 * Plumbing shared by every adapter: timeouts, retries, abortable sleeps and
 * error tagging. One policy, so every provider behaves the same way and the
 * fallback chain can rely on it.
 */
import { LlmError } from '../domain/LlmError'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>

/** Longest server-requested pause we sit through behind a spinner. */
export const MAX_SILENT_WAIT_MS = 30_000

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
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

/**
 * A signal for ONE request that fires on the user's Cancel or after
 * `timeoutMs` — and remembers which, because they mean different things: a
 * Cancel stops everything, a timeout only moves the chain to the next provider.
 */
export function attemptSignal(user: AbortSignal | undefined, timeoutMs: number) {
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, timeoutMs)
  const onUser = () => ac.abort()
  if (user?.aborted) ac.abort()
  else user?.addEventListener('abort', onUser, { once: true })
  return {
    signal: ac.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer)
      user?.removeEventListener('abort', onUser)
    },
  }
}

export function toLlmError(err: unknown, timedOut = false): LlmError {
  if (err instanceof LlmError) return err
  if (isAbort(err)) return timedOut ? new LlmError('timeout', 'Timed out') : new LlmError('aborted', 'Aborted')
  return new LlmError('network', err instanceof Error ? err.message : String(err))
}

/** Names the provider on an error that doesn't carry one yet. */
export function tag(err: LlmError, provider: string): LlmError {
  if (!err.provider) err.provider = provider
  return err
}

export async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Retry policy (same for every provider):
 *  - rate-limit / server / network: up to `maxAttempts`, waiting the server's
 *    hint or backing off 2s, 4s, 8s, 16s;
 *  - a server-requested wait over MAX_SILENT_WAIT_MS: thrown at once (the
 *    chain moves on; alone, the UI says "try again in N s");
 *  - unparseable JSON (`schema`): exactly one more attempt;
 *  - everything else (auth, billing, daily quota, too-large, timeout,
 *    blocked, bad request): thrown at once — repeating cannot help.
 */
export async function runWithRetries<T>(
  once: () => Promise<T>,
  opts: { maxAttempts: number; sleep: SleepFn; signal?: AbortSignal; provider: string },
): Promise<T> {
  let schemaRetried = false
  for (let attempt = 1; ; attempt++) {
    try {
      return await once()
    } catch (err) {
      const e = tag(toLlmError(err), opts.provider)
      if (e.kind === 'schema' && !schemaRetried) {
        schemaRetried = true
        continue
      }
      if (!e.retryable || attempt >= opts.maxAttempts) throw e
      if (e.retryAfterMs !== undefined && e.retryAfterMs > MAX_SILENT_WAIT_MS) throw e
      const backoff = 2000 * 2 ** (attempt - 1)
      await opts.sleep(e.retryAfterMs ?? backoff, opts.signal).catch(() => {
        throw tag(new LlmError('aborted', 'Aborted'), opts.provider)
      })
    }
  }
}

/** The instruction given to providers that only see the schema as text. */
export function jsonInstruction(schemaJson: string): string {
  return (
    'Reply with only a JSON object — no prose, no code fences — that matches this JSON schema:\n' + schemaJson
  )
}

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}
