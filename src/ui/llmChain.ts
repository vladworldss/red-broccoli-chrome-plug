/**
 * Settings → the provider fallback chain. Part of the composition root (UI):
 * it is the one place that knows about settings, chrome.permissions and the
 * llm-gateway adapters at the same time.
 */
import {
  FallbackLlm,
  PROVIDERS,
  createAdapter,
  type FallbackEvent,
  type ProviderHealth,
  type ProviderId,
} from '../contexts/llm-gateway'
import type { Settings } from '../shared/storage/settings'

/**
 * Provider cooldowns for this page's lifetime. Survives across builds (a
 * known-exhausted provider isn't asked again for every lecture); cleared when
 * settings change, because a fixed key or model deserves a fresh chance.
 */
export const providerHealth: ProviderHealth = new Map()

/** Gemma rides on the Gemini key. */
export function keyFor(settings: Settings, id: ProviderId): string {
  return settings.providers[PROVIDERS[id].keySource].apiKey
}

/** Enabled and has a key — permission is checked separately (async). */
export function isConfigured(settings: Settings, id: ProviderId): boolean {
  return settings.providers[id].enabled && keyFor(settings, id).length > 0
}

export function hasAnyProvider(settings: Settings): boolean {
  return settings.order.some((id) => isConfigured(settings, id))
}

/** Host access for providers declared as optional permissions. */
export async function hasHostAccess(id: ProviderId): Promise<boolean> {
  const preset = PROVIDERS[id]
  if (!preset.optionalHost) return true
  try {
    return await chrome.permissions.contains({ origins: [preset.host] })
  } catch {
    return false
  }
}

/**
 * Must run inside a click handler (Chrome requires a user gesture). Returns
 * whether access is (now) granted.
 */
export async function requestHostAccess(id: ProviderId): Promise<boolean> {
  const preset = PROVIDERS[id]
  if (!preset.optionalHost) return true
  try {
    return await chrome.permissions.request({ origins: [preset.host] })
  } catch {
    return false
  }
}

/**
 * The chain in the user's order, skipping providers that are disabled,
 * keyless, or lack host access. Null when nothing is usable.
 */
export async function buildChain(
  settings: Settings,
  opts: { onFallback?: (e: FallbackEvent) => void } = {},
): Promise<FallbackLlm | null> {
  const ids: ProviderId[] = []
  for (const id of settings.order) {
    if (isConfigured(settings, id) && (await hasHostAccess(id))) ids.push(id)
  }
  if (ids.length === 0) return null
  return new FallbackLlm(
    ids.map((id) => ({
      id,
      label: PROVIDERS[id].label,
      llm: createAdapter(id, { apiKey: keyFor(settings, id), model: settings.providers[id].model }),
      resetsAtPacificMidnight: PROVIDERS[id].keySource === 'gemini',
    })),
    { health: providerHealth, ...(opts.onFallback ? { onFallback: opts.onFallback } : {}) },
  )
}
