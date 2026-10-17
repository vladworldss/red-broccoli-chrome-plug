/**
 * Client-side pacing against a provider's per-minute limits, so a small
 * budget (Groq: 8k tokens/min) means "wait a bit between parts" instead of a
 * stream of 429s. Injectable clock for tests.
 *
 *  - Requests/min: a sliding 60-second window over what we sent.
 *  - Tokens/min: a bucket that refills CONTINUOUSLY (tpm/60 per second) —
 *    measured on Groq 2026-10-16: 1 s after a 4.4k-token request it reported
 *    3608 left and "full again in 33 s", i.e. 133 tokens/s. A sliding window
 *    made every next part wait a whole minute; the bucket waits ~10–35 s.
 *
 * Only our own traffic is visible here; `sync` takes the provider's own count
 * when a response carries one (x-ratelimit-remaining-tokens), and the
 * provider's 429 + Retry-After still covers anything else spending the key.
 */
export type Clock = () => number
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

const WINDOW_MS = 60_000

export class RateLimiter {
  private readonly sent: number[] = []
  private tokens: number
  private refilledAt: number

  constructor(
    private readonly limits: { rpm?: number; tpm?: number },
    private readonly now: Clock = Date.now,
  ) {
    this.tokens = limits.tpm ?? 0
    this.refilledAt = now()
  }

  /**
   * How long to wait before a request of `tokens` may go, in ms (0 = now).
   * A request bigger than the whole TPM budget never fits, so it goes as soon
   * as the bucket is full and the provider decides (413 → the chain falls back).
   */
  waitMs(tokens: number): number {
    const t = this.now()
    this.refill(t)
    while (this.sent.length > 0 && this.sent[0]! <= t - WINDOW_MS) this.sent.shift()
    const { rpm, tpm } = this.limits
    let wait = 0
    if (rpm !== undefined && this.sent.length >= rpm) {
      wait = this.sent[this.sent.length - rpm]! + WINDOW_MS - t
    }
    if (tpm !== undefined) {
      const need = Math.min(tokens, tpm)
      if (this.tokens < need) wait = Math.max(wait, Math.ceil(((need - this.tokens) * WINDOW_MS) / tpm))
    }
    return Math.max(0, wait)
  }

  /** Record a request as sent now. */
  record(tokens: number): void {
    const t = this.now()
    this.refill(t)
    this.sent.push(t)
    this.tokens -= tokens
  }

  /** The provider's own count of tokens left in its minute (more exact than our estimate). */
  sync(remainingTokens: number): void {
    if (this.limits.tpm === undefined || !Number.isFinite(remainingTokens)) return
    this.refill(this.now())
    this.tokens = Math.min(this.limits.tpm, Math.max(0, remainingTokens))
  }

  /**
   * Wait (abortably) until the request fits, then record it. `onWait` hears
   * each pause before it starts, so the UI can say why nothing moves.
   */
  async acquire(tokens: number, sleep: Sleep, signal?: AbortSignal, onWait?: (ms: number) => void): Promise<void> {
    for (let wait = this.waitMs(tokens); wait > 0; wait = this.waitMs(tokens)) {
      onWait?.(wait)
      await sleep(wait, signal)
    }
    this.record(tokens)
  }

  private refill(t: number): void {
    const { tpm } = this.limits
    if (tpm !== undefined) this.tokens = Math.min(tpm, this.tokens + ((t - this.refilledAt) * tpm) / WINDOW_MS)
    this.refilledAt = t
  }
}

/** ≈ tokens for a prompt: 4 characters per token is the usual rule of thumb. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

/**
 * One limiter per provider for the lifetime of the page, so pacing carries
 * across builds (a second lecture right after the first still waits its turn).
 */
const shared = new Map<string, RateLimiter>()
export function sharedLimiter(key: string, limits: { rpm?: number; tpm?: number }): RateLimiter {
  let l = shared.get(key)
  if (!l) {
    l = new RateLimiter(limits)
    shared.set(key, l)
  }
  return l
}
