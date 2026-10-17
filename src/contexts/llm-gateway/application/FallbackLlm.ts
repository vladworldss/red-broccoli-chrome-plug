import { LlmError, msUntilPacificMidnight } from '../domain/LlmError'
import type { LlmPort, LlmRequest } from './LlmPort'

export type ChainEntry = {
  /** Stable key for cooldown bookkeeping, e.g. "groq". */
  id: string
  /** Human label for messages, e.g. "Groq". */
  label: string
  llm: LlmPort
  /** Daily quotas of Google providers reset at midnight Pacific. */
  resetsAtPacificMidnight?: boolean
}

/**
 * Provider cooldowns shared across builds (module state in the panel): after
 * Gemini says "daily quota used up", the next lecture shouldn't spend a
 * request finding that out again.
 */
export type ProviderHealth = Map<string, { until: number; error: LlmError }>

export type FallbackEvent = { from: string; to: string; error: LlmError }

/** Every provider in the chain failed; `failures` says why, one per provider. */
export class AllProvidersFailedError extends Error {
  constructor(readonly failures: { provider: string; error: LlmError }[]) {
    super(`All providers failed: ${failures.map((f) => `${f.provider} (${f.error.kind})`).join(', ')}`)
    this.name = 'AllProvidersFailedError'
  }
}

/**
 * The request is larger than any provider still available can take in one
 * go. The pipeline answers by splitting the chunk to `maxChars` and retrying.
 */
export class InputTooLargeError extends Error {
  constructor(readonly maxChars: number) {
    super(`Input too large; split to at most ${maxChars} characters`)
    this.name = 'InputTooLargeError'
  }
}

/** Header lines (title, chapters, instructions) ride along with each chunk. */
const PROMPT_OVERHEAD_CHARS = 4000

/**
 * An LlmPort over an ordered chain of providers. Each call goes to the first
 * provider that is not cooling down and can take the request's size; any
 * failure except a user Cancel moves on to the next one.
 *
 * Cooldowns by failure:
 *   daily quota → until its reset (midnight Pacific for Google, else 1 h)
 *   rate limit  → the server's Retry-After, else 60 s
 *   server/net  → 60 s / 30 s;  timeout → 10 min (a slow provider stays slow)
 *   auth / no key / billing → until settings change (the panel clears `health`)
 *   schema / bad request / blocked / too large → none (request-specific)
 */
export class FallbackLlm implements LlmPort {
  private readonly used: string[] = []
  private readonly reported = new Set<string>()

  constructor(
    private readonly entries: readonly ChainEntry[],
    private readonly opts: {
      onFallback?: (e: FallbackEvent) => void
      health?: ProviderHealth
      now?: () => number
    } = {},
  ) {
    if (entries.length === 0) throw new Error('FallbackLlm needs at least one provider')
  }

  /** Every model that answered, in order of first use: "gemini:x + groq:y". */
  get modelId(): string {
    return this.used.length > 0 ? this.used.join(' + ') : this.entries[0]!.llm.modelId
  }

  /** Budget of the provider currently in front (first one not cooling down). */
  get maxInputChars(): number {
    const front = this.entries.find((e) => !this.cooling(e))
    return (front ?? this.entries[0]!).llm.maxInputChars
  }

  async generateJson(req: LlmRequest): Promise<unknown> {
    const failures: { provider: string; error: LlmError }[] = []
    let fitFor = 0 // largest budget among providers skipped only for size
    let fitLabel = '' // …and whose budget that is
    // The provider we are falling back FROM: one that just failed, or one
    // still cooling down from an earlier failure.
    let from: { label: string; error: LlmError } | null = null

    for (const e of this.entries) {
      const cooled = this.cooling(e)
      if (cooled) {
        failures.push({ provider: e.label, error: cooled })
        from = { label: e.label, error: cooled }
        continue
      }
      if (req.prompt.length > e.llm.maxInputChars + PROMPT_OVERHEAD_CHARS) {
        if (e.llm.maxInputChars > fitFor) {
          fitFor = e.llm.maxInputChars
          fitLabel = e.label
        }
        continue
      }
      if (from) this.report(from, e.label)
      try {
        const out = await e.llm.generateJson(req)
        if (!this.used.includes(e.llm.modelId)) this.used.push(e.llm.modelId)
        return out
      } catch (err) {
        const error = asLlmError(err, e.label)
        if (error.kind === 'aborted') throw error
        if (error.kind === 'too-large') {
          // Our size estimate was optimistic for this provider: ask for smaller parts.
          const target = Math.floor(req.prompt.length * 0.6)
          if (target > fitFor) {
            fitFor = target
            fitLabel = e.label
          }
        }
        failures.push({ provider: e.label, error })
        this.cool(e, error)
        from = { label: e.label, error }
      }
    }

    if (fitFor > 0) {
      // The switch happens on the re-split parts; say so now, not after them.
      if (from && from.label !== fitLabel) this.report(from, fitLabel)
      throw new InputTooLargeError(fitFor)
    }
    // A one-provider chain keeps that provider's own (more specific) error.
    if (failures.length === 1 && this.entries.length === 1) throw failures[0]!.error
    throw new AllProvidersFailedError(failures)
  }

  /** Once per failed provider per chain: every later part would say the same. */
  private report(from: { label: string; error: LlmError }, to: string): void {
    if (this.reported.has(from.label)) return
    this.reported.add(from.label)
    this.opts.onFallback?.({ from: from.label, to, error: from.error })
  }

  private cooling(e: ChainEntry): LlmError | null {
    const h = this.opts.health?.get(e.id)
    if (!h) return null
    if (h.until > this.now()) return h.error
    this.opts.health?.delete(e.id)
    return null
  }

  private cool(e: ChainEntry, error: LlmError): void {
    const ms = cooldownMs(error, e, this.now())
    if (ms > 0) this.opts.health?.set(e.id, { until: this.now() + ms, error })
  }

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }
}

function cooldownMs(error: LlmError, e: ChainEntry, now: number): number {
  switch (error.kind) {
    case 'daily-quota':
      return e.resetsAtPacificMidnight ? msUntilPacificMidnight(new Date(now)) : 60 * 60_000
    case 'rate-limit':
      return error.retryAfterMs ?? 60_000
    case 'server':
      return 60_000
    case 'network':
      return 30_000
    case 'timeout':
      return 10 * 60_000
    case 'auth':
    case 'no-key':
    case 'billing':
      return Number.POSITIVE_INFINITY
    default:
      return 0
  }
}

function asLlmError(err: unknown, label: string): LlmError {
  const e = err instanceof LlmError ? err : new LlmError('network', err instanceof Error ? err.message : String(err))
  if (!e.provider) e.provider = label
  return e
}
