import { describe, expect, it, vi } from 'vitest'

import { LlmError, describeLlmError } from '../../src/contexts/llm-gateway'
import { classifyHttpError } from '../../src/contexts/llm-gateway/domain/LlmError'
import {
  GEMINI_API_BASE,
  GeminiApiAdapter,
  extractText,
  type FetchLike,
} from '../../src/contexts/llm-gateway/infrastructure/GeminiApiAdapter'
import { fixture } from './helpers/fixtures'

const SCHEMA = { type: 'OBJECT' as const, properties: { ok: { type: 'BOOLEAN' as const } } }
const REQ = { system: 'sys', prompt: 'hello', schema: SCHEMA }

const okBody = (text: string) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] })
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function scripted(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetch: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error('unexpected extra request')
    if (next instanceof Error) throw next
    return next
  })
  return { fetch, calls }
}

const noSleep = vi.fn(async () => {})

describe('classifyHttpError', () => {
  it('maps Google error shapes to kinds', () => {
    expect(classifyHttpError(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }).kind).toBe('auth')
    expect(classifyHttpError(403, {}).kind).toBe('auth')
    expect(classifyHttpError(404, {}).kind).toBe('bad-request')
    expect(classifyHttpError(500, {}).kind).toBe('server')
    const rl = classifyHttpError(429, {
      error: { message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17s' }] },
    })
    expect(rl.kind).toBe('rate-limit')
    expect(rl.retryAfterMs).toBe(17_000)
    expect(rl.retryable).toBe(true)
  })

  it('every kind has user-facing text', () => {
    for (const kind of ['no-key', 'auth', 'rate-limit', 'bad-request', 'server', 'network', 'schema', 'blocked', 'aborted'] as const) {
      expect(describeLlmError(new LlmError(kind, 'x'))).toBeTruthy()
    }
  })
})

describe('GeminiApiAdapter.generateJson', () => {
  it('posts the documented request shape with the key in a header, not the URL', async () => {
    const { fetch, calls } = scripted(json(200, okBody('{"ok":true}')))
    const llm = new GeminiApiAdapter({ apiKey: ' KEY ', model: 'gemini-x', fetch, sleep: noSleep })
    await expect(llm.generateJson(REQ)).resolves.toEqual({ ok: true })

    const { url, init } = calls[0]!
    expect(url).toBe(`${GEMINI_API_BASE}/models/gemini-x:generateContent`)
    expect(url).not.toContain('KEY')
    expect((init!.headers as Record<string, string>)['x-goog-api-key']).toBe('KEY')
    const body = JSON.parse(String(init!.body))
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: 'sys' }] },
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
    })
  })

  it('defaults to the rolling Flash alias and accepts a "models/" prefix', async () => {
    expect(new GeminiApiAdapter({ apiKey: 'k' }).modelId).toBe('gemini-flash-latest')
    const { fetch, calls } = scripted(json(200, okBody('{}')))
    await new GeminiApiAdapter({ apiKey: 'k', model: 'models/gemini-y', fetch }).generateJson(REQ)
    expect(calls[0]!.url).toContain('/models/gemini-y:generateContent')
  })

  it('no key → no-key error without a request', async () => {
    const { fetch } = scripted()
    await expect(new GeminiApiAdapter({ apiKey: '', fetch }).generateJson(REQ)).rejects.toMatchObject({ kind: 'no-key' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('retries 429 using the server delay, then succeeds', async () => {
    const sleep = vi.fn(async () => {})
    const { fetch } = scripted(
      json(429, { error: { message: 'slow down', details: [{ retryDelay: '3s' }] } }),
      json(200, okBody('{"ok":true}')),
    )
    await expect(new GeminiApiAdapter({ apiKey: 'k', fetch, sleep }).generateJson(REQ)).resolves.toEqual({ ok: true })
    expect(sleep).toHaveBeenCalledWith(3000, undefined)
  })

  it('backs off exponentially on 5xx/network and gives up after maxAttempts', async () => {
    const sleep = vi.fn(async () => {})
    const { fetch } = scripted(json(503, {}), new TypeError('Failed to fetch'), json(500, {}))
    await expect(
      new GeminiApiAdapter({ apiKey: 'k', fetch, sleep, maxAttempts: 3 }).generateJson(REQ),
    ).rejects.toMatchObject({ kind: 'server' })
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([2000, 4000])
  })

  it('never retries auth errors', async () => {
    const { fetch } = scripted(json(400, { error: { message: 'API key not valid', status: 'INVALID_ARGUMENT' } }))
    await expect(new GeminiApiAdapter({ apiKey: 'k', fetch, sleep: noSleep }).generateJson(REQ)).rejects.toMatchObject({
      kind: 'auth',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('malformed JSON gets exactly one retry', async () => {
    const { fetch } = scripted(json(200, okBody('{"ok":')), json(200, okBody('not json either')))
    await expect(new GeminiApiAdapter({ apiKey: 'k', fetch, sleep: noSleep }).generateJson(REQ)).rejects.toMatchObject({
      kind: 'schema',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('an aborted request surfaces as "aborted"', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const { fetch } = scripted(abort)
    await expect(new GeminiApiAdapter({ apiKey: 'k', fetch }).generateJson(REQ)).rejects.toMatchObject({ kind: 'aborted' })
  })
})

describe('extractText', () => {
  it('reads the fixture response', () => {
    const parsed = JSON.parse(extractText(JSON.parse(fixture('gemini-extraction.json'))))
    expect(parsed.concepts).toHaveLength(3)
  })

  it('skips thought parts and joins answer parts', () => {
    expect(
      extractText({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"a"' }, { text: ':1}' }] } }] }),
    ).toBe('{"a":1}')
  })

  it('blocked prompts and safety stops → blocked; MAX_TOKENS → schema', () => {
    expect(() => extractText({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(/Blocked/)
    expect(() => extractText({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] })).toThrow(
      expect.objectContaining({ kind: 'blocked' }),
    )
    expect(() => extractText({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"a":' }] } }] })).toThrow(
      expect.objectContaining({ kind: 'schema' }),
    )
  })
})

describe('GeminiApiAdapter.testKey', () => {
  it('GETs model metadata (no generation) and maps failures', async () => {
    const ok = scripted(json(200, { name: 'models/gemini-flash-latest' }))
    await new GeminiApiAdapter({ apiKey: 'k', fetch: ok.fetch }).testKey()
    expect(ok.calls[0]!.url).toBe(`${GEMINI_API_BASE}/models/gemini-flash-latest`)
    expect(ok.calls[0]!.init!.method).toBe('GET')

    const bad = scripted(json(404, { error: { message: 'not found' } }))
    await expect(new GeminiApiAdapter({ apiKey: 'k', model: 'nope', fetch: bad.fetch }).testKey()).rejects.toMatchObject({
      kind: 'bad-request',
      status: 404,
    })
  })
})
