import { PROVIDERS, type ProviderId } from '../domain/providers'
import { GeminiApiAdapter } from './GeminiApiAdapter'
import type { FetchLike, SleepFn } from './http'
import { OpenAiCompatibleAdapter } from './OpenAiCompatibleAdapter'

export type ProviderAdapter = GeminiApiAdapter | OpenAiCompatibleAdapter

/** Provider id + its settings → the adapter that speaks its protocol. */
export function createAdapter(
  id: ProviderId,
  cfg: { apiKey: string; model?: string },
  overrides: { fetch?: FetchLike; sleep?: SleepFn } = {},
): ProviderAdapter {
  const preset = PROVIDERS[id]
  const common = {
    apiKey: cfg.apiKey,
    ...(cfg.model ? { model: cfg.model } : {}),
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
  }
  return preset.api === 'gemini'
    ? new GeminiApiAdapter({ ...common, preset })
    : new OpenAiCompatibleAdapter({ ...common, preset })
}
