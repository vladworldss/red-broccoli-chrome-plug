/**
 * Every LLM provider StudHelper can use, as data. Adding a provider is a new
 * row here (plus a host permission); the adapters are generic.
 *
 * Verified 2026-10-16 against provider docs / live model lists. Free model
 * rosters change — every model is editable in Settings, these are defaults.
 */

export type ProviderId = 'gemini' | 'mistral' | 'groq' | 'openrouter' | 'gemma' | 'deepseek'

/**
 * How the provider is made to return JSON:
 *  - gemini-schema: Gemini `responseSchema` (our JsonSchema as-is)
 *  - json-schema:   OpenAI `response_format: {type:'json_schema', strict}`
 *  - json-object:   OpenAI `response_format: {type:'json_object'}`; schema in the prompt
 *  - prompt:        no JSON mode at all; schema in the prompt, JSON cut out of the text
 */
export type JsonMode = 'gemini-schema' | 'json-schema' | 'json-object' | 'prompt'

export type ProviderPreset = {
  id: ProviderId
  label: string
  /** Which adapter speaks its protocol. */
  api: 'gemini' | 'openai'
  baseUrl: string
  defaultModel: string
  /** Host permission origin pattern for `chrome.permissions`. */
  host: string
  /** Declared in `optional_host_permissions` and requested at runtime. */
  optionalHost: boolean
  /** Where the user gets a key. */
  keyUrl: string
  /** Gemma runs on the Gemini API with the Gemini key. */
  keySource: ProviderId
  jsonMode: JsonMode
  /**
   * Soft per-minute limits for client-side pacing (free tier). Undefined =
   * no pacing; rely on the provider's own 429 + Retry-After.
   */
  limits?: { rpm?: number; tpm?: number }
  /** Output tokens to reserve when pacing by tokens (TPM counts output too). */
  outputReserveTokens: number
  /** Per-request transcript budget in characters (≈ 4 chars per token). */
  maxInputChars: number
  /** A request taking longer than this is abandoned and the chain moves on. */
  timeoutMs: number
  /** Extra JSON merged into OpenAI-compatible request bodies. */
  extraBody?: Record<string, unknown>
  /** Shown in Settings next to the provider. */
  note: string
  /** Paid-only providers are never enabled implicitly. */
  paid: boolean
}

export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    api: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-flash-latest',
    host: 'https://generativelanguage.googleapis.com/*',
    optionalHost: false,
    keyUrl: 'https://aistudio.google.com/apikey',
    keySource: 'gemini',
    jsonMode: 'gemini-schema',
    outputReserveTokens: 4000,
    maxInputChars: 120_000,
    timeoutMs: 120_000,
    note: 'Free tier; small daily quota.',
    paid: false,
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    api: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    host: 'https://api.mistral.ai/*',
    optionalHost: true,
    keyUrl: 'https://console.mistral.ai/api-keys',
    keySource: 'mistral',
    jsonMode: 'json-schema',
    limits: { rpm: 30 },
    outputReserveTokens: 4000,
    maxInputChars: 120_000,
    timeoutMs: 150_000,
    note: 'Free "Experiment" plan (phone verification; may train on free-tier data).',
    paid: false,
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    api: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b',
    host: 'https://api.groq.com/*',
    optionalHost: true,
    keyUrl: 'https://console.groq.com/keys',
    keySource: 'groq',
    jsonMode: 'json-schema',
    // Free tier for gpt-oss-120b, from live x-ratelimit-* headers: 8000 TPM, 1000 RPD.
    limits: { rpm: 30, tpm: 8000 },
    // Measured: 1.0–1.2k completion tokens per part (reasoning ~90 of them).
    outputReserveTokens: 1500,
    // ≈3.5k input tokens, so input + system + output stays under 8k TPM.
    maxInputChars: 14_000,
    timeoutMs: 120_000,
    // gpt-oss reasons before answering; "low" keeps that inside the TPM budget.
    extraBody: { reasoning_effort: 'low' },
    note: 'Free and fast; ~1000 requests/day, small per-minute token budget (long lectures go in parts).',
    paid: false,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    api: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'nvidia/nemotron-3-super-120b-a12b:free',
    host: 'https://openrouter.ai/*',
    optionalHost: true,
    keyUrl: 'https://openrouter.ai/keys',
    keySource: 'openrouter',
    jsonMode: 'json-schema',
    limits: { rpm: 20 },
    outputReserveTokens: 4000,
    maxInputChars: 120_000,
    timeoutMs: 180_000,
    note: 'Free ":free" models; 50 requests/day (1000 after a one-time $10 credit). Free models change often.',
    paid: false,
  },
  gemma: {
    id: 'gemma',
    label: 'Gemma',
    api: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemma-4-31b-it',
    host: 'https://generativelanguage.googleapis.com/*',
    optionalHost: false,
    keyUrl: 'https://aistudio.google.com/apikey',
    keySource: 'gemini',
    // Gemma on the Gemini API takes neither systemInstruction nor responseSchema reliably.
    jsonMode: 'prompt',
    limits: { rpm: 30, tpm: 15_000 },
    outputReserveTokens: 3000,
    maxInputChars: 40_000,
    // Measured: ~80 s for a one-line prompt. Slow, so it runs last.
    timeoutMs: 300_000,
    note: 'Uses your Gemini key with a separate quota. Very slow (minutes per lecture).',
    paid: false,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    api: 'openai',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    host: 'https://api.deepseek.com/*',
    optionalHost: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keySource: 'deepseek',
    jsonMode: 'json-object',
    outputReserveTokens: 4000,
    maxInputChars: 120_000,
    timeoutMs: 150_000,
    note: 'Paid but very cheap (about $0.003 per lecture). No free tier.',
    paid: true,
  },
}

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[]

/** Default fallback order. The user stressed Mistral, so it is the first fallback. */
export const DEFAULT_ORDER: ProviderId[] = ['gemini', 'mistral', 'groq', 'openrouter', 'gemma', 'deepseek']

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && v in PROVIDERS
}

/**
 * "groq:openai/gpt-oss-120b" ↔ parts. A map built by several providers (one
 * chunk each) records them joined with " + ". Legacy maps stored a bare model
 * ("gemini-flash-latest"), which reads as Gemini.
 */
export function qualifiedModel(provider: ProviderId, model: string): string {
  return `${provider}:${model}`
}

export function describeModels(stored: string): string {
  return stored
    .split(' + ')
    .map((part) => {
      const i = part.indexOf(':')
      const id = i > 0 ? part.slice(0, i) : 'gemini'
      const model = i > 0 ? part.slice(i + 1) : part
      return `${isProviderId(id) ? PROVIDERS[id].label : id} · ${model}`
    })
    .join(' + ')
}
