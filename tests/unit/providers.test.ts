import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  AllProvidersFailedError,
  FallbackLlm,
  GeminiApiAdapter,
  InputTooLargeError,
  LlmError,
  OpenAiCompatibleAdapter,
  PROVIDERS,
  describeLlmErrorShort,
  describeModels,
  type LlmPort,
  type ProviderHealth,
} from '../../src/contexts/llm-gateway'
import { extractJson } from '../../src/contexts/llm-gateway/domain/extractJson'
import { classifyHttpError } from '../../src/contexts/llm-gateway/domain/LlmError'
import { RateLimiter } from '../../src/contexts/llm-gateway/domain/RateLimiter'
import { toStandardJsonSchema } from '../../src/contexts/llm-gateway/domain/schemaConversion'
import type { FetchLike } from '../../src/contexts/llm-gateway/infrastructure/http'

const SCHEMA = {
  type: 'OBJECT' as const,
  properties: {
    term: { type: 'STRING' as const },
    t: { type: 'INTEGER' as const, nullable: true },
    tags: { type: 'ARRAY' as const, items: { type: 'STRING' as const } },
    kind: { type: 'STRING' as const, enum: ['a', 'b'] },
  },
  required: ['term'],
  propertyOrdering: ['term', 't', 'tags', 'kind'],
}
const REQ = { system: 'sys', prompt: 'hello', schema: SCHEMA }

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const chat = (content: string, finish = 'stop') => ({ choices: [{ message: { content }, finish_reason: finish }] })

function scripted(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetch: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error('unexpected extra request')
    if (next instanceof Error) throw next
    return next
  })
  return { fetch, calls, body: (i: number) => JSON.parse(String(calls[i]!.init!.body)) }
}
const noSleep = async () => {}

describe('schema conversion (Gemini dialect → strict JSON Schema)', () => {
  it('lowercases types, unions nullable, requires every property, forbids extras', () => {
    expect(toStandardJsonSchema(SCHEMA)).toEqual({
      type: 'object',
      properties: {
        term: { type: 'string' },
        t: { type: ['integer', 'null'] },
        tags: { type: 'array', items: { type: 'string' } },
        kind: { type: 'string', enum: ['a', 'b'] },
      },
      required: ['term', 't', 'tags', 'kind'],
      additionalProperties: false,
    })
  })
})

describe('extractJson', () => {
  it('plain, fenced, and wrapped in prose', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 })
    expect(extractJson('Sure! Here it is: {"a":{"b":"}"}} Hope it helps.')).toEqual({ a: { b: '}' } })
  })

  it('no object → SyntaxError', () => {
    expect(() => extractJson('I cannot help with that.')).toThrow(SyntaxError)
  })
})

describe('RateLimiter', () => {
  it('tokens refill continuously (tpm/60 per second), not a minute after the last request', () => {
    let now = 0
    const l = new RateLimiter({ tpm: 6000 }, () => now) // 100 tokens/s
    expect(l.waitMs(5000)).toBe(0)
    l.record(5000) // 1000 left
    expect(l.waitMs(5000)).toBe(40_000) // 4000 more at 100/s
    now = 30_000 // 4000 left
    expect(l.waitMs(5000)).toBe(10_000)
    now = 120_000
    expect(l.waitMs(5000)).toBe(0) // capped at a full bucket, not 13k
    l.record(5000)
    expect(l.waitMs(5000)).toBe(40_000)
  })

  it('sync takes the provider’s own count of what is left', () => {
    const l = new RateLimiter({ tpm: 8000 }, () => 0)
    l.record(1000) // we think 7000 are left…
    l.sync(363) // …Groq says 363 (another tab spent the rest)
    expect(l.waitMs(5000)).toBe(Math.ceil(((5000 - 363) * 60_000) / 8000))
    l.sync(Number('')) // a missing header changes nothing… (NaN is ignored)
    l.sync(99_999) // …and nothing exceeds the bucket
    expect(l.waitMs(8000)).toBe(0)
  })

  it('paces by requests per minute', () => {
    let now = 0
    const l = new RateLimiter({ rpm: 2 }, () => now)
    l.record(1)
    now = 1000
    l.record(1)
    expect(l.waitMs(1)).toBe(59_000)
  })

  it('a request bigger than the whole budget waits only for a full bucket (the provider decides)', () => {
    let now = 0
    const l = new RateLimiter({ tpm: 100 }, () => now)
    expect(l.waitMs(500)).toBe(0)
    l.record(90)
    expect(l.waitMs(500)).toBe(54_000) // the 90 refill, then it goes
  })

  it('acquire sleeps the computed wait, then records', async () => {
    let now = 0
    const l = new RateLimiter({ rpm: 1 }, () => now)
    l.record(1)
    const sleep = vi.fn(async (ms: number) => {
      now += ms
    })
    const waits: number[] = []
    await l.acquire(1, sleep, undefined, (ms) => waits.push(ms))
    expect(sleep).toHaveBeenCalledWith(60_000, undefined)
    expect(waits).toEqual([60_000]) // announced before the pause, so the UI can count down
  })
})

describe('OpenAiCompatibleAdapter', () => {
  it('takes the server’s remaining-token count into its pacing (Groq headers)', async () => {
    const limiter = new RateLimiter({ tpm: 8000 }, () => 0)
    const { fetch } = scripted(
      json(200, chat('{"a":1}'), { 'x-ratelimit-remaining-tokens': '363' }),
    )
    const llm = new OpenAiCompatibleAdapter({ preset: PROVIDERS.groq, apiKey: 'k', fetch, sleep: noSleep, limiter })
    await llm.generateJson(REQ)
    expect(limiter.waitMs(1000)).toBe(Math.ceil(((1000 - 363) * 60_000) / 8000))
  })

  it('json-schema mode (Groq): Bearer key, strict schema, preset extras, model qualified', async () => {
    const { fetch, calls, body } = scripted(json(200, chat('{"term":"Derivative","t":null,"tags":[],"kind":"a"}')))
    const llm = new OpenAiCompatibleAdapter({ preset: PROVIDERS.groq, apiKey: ' gsk ', fetch, sleep: noSleep, limiter: null })
    await expect(llm.generateJson(REQ)).resolves.toMatchObject({ term: 'Derivative' })
    expect(llm.modelId).toBe('groq:openai/gpt-oss-120b')
    expect(calls[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer gsk')
    const b = body(0)
    expect(b.model).toBe('openai/gpt-oss-120b')
    expect(b.temperature).toBe(0)
    expect(b.reasoning_effort).toBe('low')
    expect(b.response_format.type).toBe('json_schema')
    expect(b.response_format.json_schema.strict).toBe(true)
    expect(b.messages[0]).toEqual({ role: 'system', content: 'sys' })
  })

  it('json-object mode (DeepSeek): schema and the word JSON go into the system prompt', async () => {
    const { fetch, body } = scripted(json(200, chat('```json\n{"term":"x"}\n```')))
    const llm = new OpenAiCompatibleAdapter({ preset: PROVIDERS.deepseek, apiKey: 'k', fetch, limiter: null })
    await expect(llm.generateJson(REQ)).resolves.toEqual({ term: 'x' })
    const b = body(0)
    expect(b.response_format).toEqual({ type: 'json_object' })
    expect(b.messages[0].content).toContain('JSON')
    expect(b.messages[0].content).toContain('"additionalProperties":false')
  })

  it('a model that rejects strict schemas is degraded to json-object once, not failed', async () => {
    const { fetch, body } = scripted(
      json(400, { error: { message: 'response_format json_schema is not supported for this model' } }),
      json(200, chat('{"term":"x"}')),
    )
    const llm = new OpenAiCompatibleAdapter({ preset: PROVIDERS.mistral, apiKey: 'k', fetch, sleep: noSleep, limiter: null })
    await expect(llm.generateJson(REQ)).resolves.toEqual({ term: 'x' })
    expect(body(1).response_format).toEqual({ type: 'json_object' })
  })

  it('429 with Retry-After is waited (short) and retried', async () => {
    const sleep = vi.fn(async () => {})
    const { fetch } = scripted(
      json(429, { error: { message: 'Rate limit reached on requests per minute (RPM)' } }, { 'retry-after': '2' }),
      json(200, chat('{"term":"x"}')),
    )
    const llm = new OpenAiCompatibleAdapter({ preset: PROVIDERS.openrouter, apiKey: 'k', fetch, sleep, limiter: null })
    await llm.generateJson(REQ)
    expect(sleep).toHaveBeenCalledWith(2000, undefined)
  })

  it('401 → auth, tagged with the provider; 413 → too-large; neither retried', async () => {
    const a = scripted(json(401, { message: 'Unauthorized' }))
    await expect(
      new OpenAiCompatibleAdapter({ preset: PROVIDERS.mistral, apiKey: 'bad', fetch: a.fetch, limiter: null }).generateJson(REQ),
    ).rejects.toMatchObject({ kind: 'auth', provider: 'Mistral' })
    expect(a.fetch).toHaveBeenCalledTimes(1)

    const b = scripted(json(413, { error: { message: 'Request too large for model on tokens per minute (TPM): Limit 8000, Requested 12000' } }))
    await expect(
      new OpenAiCompatibleAdapter({ preset: PROVIDERS.groq, apiKey: 'k', fetch: b.fetch, limiter: null }).generateJson(REQ),
    ).rejects.toMatchObject({ kind: 'too-large', provider: 'Groq' })
  })

  it('cut-off output (finish_reason length) is a schema error, retried once', async () => {
    const { fetch } = scripted(json(200, chat('{"term":', 'length')), json(200, chat('{"term":"x"}')))
    const llm = new OpenAiCompatibleAdapter({ preset: PROVIDERS.mistral, apiKey: 'k', fetch, sleep: noSleep, limiter: null })
    await expect(llm.generateJson(REQ)).resolves.toEqual({ term: 'x' })
  })

  it('testKey lists models with the Bearer key', async () => {
    const { fetch, calls } = scripted(json(200, { data: [] }))
    await new OpenAiCompatibleAdapter({ preset: PROVIDERS.groq, apiKey: 'k', fetch }).testKey()
    expect(calls[0]!.url).toBe('https://api.groq.com/openai/v1/models')
  })

  it('a hanging provider times out (not "cancelled") so the chain can move on', async () => {
    vi.useFakeTimers()
    try {
      const fetch: FetchLike = (_url, init) =>
        new Promise((_res, rej) =>
          init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
        )
      const preset = { ...PROVIDERS.mistral, timeoutMs: 1000 }
      const p = new OpenAiCompatibleAdapter({ preset, apiKey: 'k', fetch, limiter: null }).generateJson(REQ)
      const assertion = expect(p).rejects.toMatchObject({ kind: 'timeout', provider: 'Mistral' })
      await vi.advanceTimersByTimeAsync(1500)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Gemma via the Gemini API (prompt mode)', () => {
  it('no systemInstruction / responseSchema; instructions + schema in the prompt; JSON cut out of text', async () => {
    const { fetch, calls, body } = scripted(
      json(200, { candidates: [{ content: { parts: [{ text: 'Here you go:\n```json\n{"term":"x"}\n```' }] }, finishReason: 'STOP' }] }),
    )
    const llm = new GeminiApiAdapter({ apiKey: 'k', preset: PROVIDERS.gemma, fetch, limiter: null })
    await expect(llm.generateJson(REQ)).resolves.toEqual({ term: 'x' })
    expect(calls[0]!.url).toContain('/models/gemma-4-31b-it:generateContent')
    const b = body(0)
    expect(b.systemInstruction).toBeUndefined()
    expect(b.generationConfig.responseSchema).toBeUndefined()
    expect(b.contents[0].parts[0].text).toMatch(/^sys\n\nReply with only a JSON object/)
    expect(llm.modelId).toBe('gemma:gemma-4-31b-it')
  })
})

describe('error bodies of other providers', () => {
  it('Groq daily token limit (TPD) → daily-quota with limit; "try again in 1m26.4s"', () => {
    const e = classifyHttpError(429, {
      error: {
        message:
          'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_1` on tokens per day (TPD): Limit 200000, Used 199000, Requested 3000. Please try again in 1m26.4s.',
        code: 'rate_limit_exceeded',
      },
    })
    expect(e.kind).toBe('daily-quota')
    expect(e.quota).toMatchObject({ scope: 'day', metric: 'tokens', limit: 200000 })
    expect(e.retryAfterMs).toBe(86_400)
  })

  it('Mistral top-level {message}; OpenRouter "free-models-per-day"; DeepSeek 402 billing', () => {
    expect(classifyHttpError(429, { message: 'Requests rate limit exceeded' }).kind).toBe('rate-limit')
    expect(classifyHttpError(429, { error: { message: 'Rate limit exceeded: free-models-per-day', code: 429 } }).kind).toBe(
      'daily-quota',
    )
    expect(classifyHttpError(402, { error: { message: 'Insufficient Balance' } }).kind).toBe('billing')
  })

  it('Retry-After header wins and accepts seconds', () => {
    const e = classifyHttpError(429, { message: 'slow down' }, { get: (n: string) => (n === 'retry-after' ? '7' : null) })
    expect(e.retryAfterMs).toBe(7000)
  })
})

describe('FallbackLlm', () => {
  const ok = (id: string, chars = 120_000): LlmPort => ({
    modelId: id,
    maxInputChars: chars,
    generateJson: vi.fn(async () => ({ from: id })),
  })
  const failing = (id: string, error: LlmError): LlmPort => ({
    modelId: id,
    maxInputChars: 120_000,
    generateJson: vi.fn(async () => {
      throw error
    }),
  })

  it('first healthy provider answers; modelId names it', async () => {
    const chain = new FallbackLlm([
      { id: 'a', label: 'A', llm: ok('a:m') },
      { id: 'b', label: 'B', llm: ok('b:m') },
    ])
    await expect(chain.generateJson(REQ)).resolves.toEqual({ from: 'a:m' })
    expect(chain.modelId).toBe('a:m')
  })

  it('a failure moves on, reports the switch, and cools the provider down for the next call', async () => {
    const health: ProviderHealth = new Map()
    const a = failing('a:m', new LlmError('rate-limit', '429', { retryAfterMs: 30_000 }))
    const events: string[] = []
    const chain = new FallbackLlm(
      [
        { id: 'a', label: 'A', llm: a },
        { id: 'b', label: 'B', llm: ok('b:m') },
      ],
      { health, now: () => 1000, onFallback: (e) => events.push(`${e.from}->${e.to}`) },
    )
    await chain.generateJson(REQ)
    await chain.generateJson(REQ)
    expect(a.generateJson).toHaveBeenCalledTimes(1) // second call skipped A while cooling
    expect(events).toEqual(['A->B'])
    expect(health.get('a')?.until).toBe(31_000)
    expect(chain.maxInputChars).toBe(120_000)
  })

  it('a user Cancel stops the chain instead of falling back', async () => {
    const b = ok('b:m')
    const chain = new FallbackLlm([
      { id: 'a', label: 'A', llm: failing('a:m', new LlmError('aborted', 'x')) },
      { id: 'b', label: 'B', llm: b },
    ])
    await expect(chain.generateJson(REQ)).rejects.toMatchObject({ kind: 'aborted' })
    expect(b.generateJson).not.toHaveBeenCalled()
  })

  it('a one-provider chain keeps that provider’s own error', async () => {
    const chain = new FallbackLlm([{ id: 'a', label: 'A', llm: failing('a:m', new LlmError('daily-quota', 'q')) }])
    await expect(chain.generateJson(REQ)).rejects.toMatchObject({ kind: 'daily-quota', provider: 'A' })
  })

  it('all failing → AllProvidersFailedError listing each reason', async () => {
    const chain = new FallbackLlm([
      { id: 'a', label: 'A', llm: failing('a:m', new LlmError('auth', 'x')) },
      { id: 'b', label: 'B', llm: failing('b:m', new LlmError('timeout', 'x')) },
    ])
    const err = (await chain.generateJson(REQ).catch((e: unknown) => e)) as AllProvidersFailedError
    expect(err).toBeInstanceOf(AllProvidersFailedError)
    expect(err.failures.map((f) => `${f.provider}: ${describeLlmErrorShort(f.error)}`)).toEqual([
      'A: API key rejected',
      'B: timed out',
    ])
  })

  it('a request too big for every remaining provider asks the pipeline to split', async () => {
    const chain = new FallbackLlm([{ id: 'small', label: 'S', llm: ok('s:m', 1000) }])
    const big = { ...REQ, prompt: 'x'.repeat(10_000) }
    const err = await chain.generateJson(big).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InputTooLargeError)
    expect((err as InputTooLargeError).maxChars).toBe(1000)
  })
})

describe('presets ↔ manifest', () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'))

  it('every provider host is declared: required for Google, optional for the rest', () => {
    for (const p of Object.values(PROVIDERS)) {
      const list: string[] = p.optionalHost ? pkg.manifest.optional_host_permissions : pkg.manifest.host_permissions
      expect(list).toContain(p.host)
    }
    const optional = Object.values(PROVIDERS).filter((p) => p.optionalHost).map((p) => p.host)
    expect([...pkg.manifest.optional_host_permissions].sort()).toEqual([...new Set(optional)].sort())
  })

  it('describeModels reads qualified, combined and legacy ids', () => {
    expect(describeModels('groq:openai/gpt-oss-120b')).toBe('Groq · openai/gpt-oss-120b')
    expect(describeModels('gemini:a + mistral:b')).toBe('Gemini · a + Mistral · b')
    expect(describeModels('gemini-flash-latest')).toBe('Gemini · gemini-flash-latest')
  })
})
