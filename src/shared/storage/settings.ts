/**
 * User settings in `chrome.storage.local`, under ONE key holding one object so
 * an update fires `onChanged` once — no half-applied state reaches the UI.
 *
 * Local, not `sync`: API keys must not be copied to other devices via the
 * user's Google account. They are stored unencrypted in the Chrome profile
 * (the Options page says so) and only ever read by extension pages — content
 * scripts never see them.
 *
 * v2 (0.3.0) holds one entry per LLM provider plus the fallback order. v1
 * (`{apiKey, model}`, Gemini only) is migrated on read, so upgrading users
 * keep their key.
 */
import { isRecord, type ChangeListener, type KeyValueStorage } from './kv'

/**
 * Provider ids, in the default fallback order. Shared code can't import the
 * llm-gateway context, so this mirrors `DEFAULT_ORDER` in
 * contexts/llm-gateway/domain/providers.ts — a unit test keeps them equal.
 */
export const SETTINGS_PROVIDER_ORDER = ['gemini', 'mistral', 'groq', 'openrouter', 'gemma', 'deepseek'] as const
export type SettingsProviderId = (typeof SETTINGS_PROVIDER_ORDER)[number]

export type ProviderSettings = {
  /** Part of the fallback chain (it still needs a key — and Gemma, a Gemini key). */
  enabled: boolean
  /** Empty = not configured. Gemma uses the Gemini key and ignores its own. */
  apiKey: string
  /** Empty = the provider's default model. */
  model: string
}

export type Settings = {
  providers: Record<SettingsProviderId, ProviderSettings>
  /** Fallback order: the first usable provider builds the map. */
  order: SettingsProviderId[]
  /** "auto" = the lecture's own language; otherwise a language name. */
  outputLanguage: string
}

export const SETTINGS_KEY = 'sh:settings'

const emptyProvider = (enabled: boolean): ProviderSettings => ({ enabled, apiKey: '', model: '' })

/** Only Gemini is on out of the box; others switch on when the user adds a key. */
export const DEFAULT_SETTINGS: Settings = {
  providers: {
    gemini: emptyProvider(true),
    mistral: emptyProvider(false),
    groq: emptyProvider(false),
    openrouter: emptyProvider(false),
    gemma: emptyProvider(false),
    deepseek: emptyProvider(false),
  },
  order: [...SETTINGS_PROVIDER_ORDER],
  outputLanguage: 'auto',
}

type SettingsStorage = Pick<KeyValueStorage, 'get' | 'set' | 'onChanged'>

/**
 * Defensive parse + v1→v2 migration. Wrong types fall back to defaults rather
 * than being coerced; unknown provider ids are dropped; a missing provider in
 * `order` is appended in default position so a newly added provider appears.
 */
export function normalizeSettings(raw: unknown): Settings {
  const out = cloneDefaults()
  if (!isRecord(raw)) return out
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined)

  const providers = isRecord(raw.providers) ? raw.providers : null
  if (providers) {
    for (const id of SETTINGS_PROVIDER_ORDER) {
      const p = providers[id]
      if (!isRecord(p)) continue
      out.providers[id] = {
        enabled: typeof p.enabled === 'boolean' ? p.enabled : out.providers[id].enabled,
        apiKey: str(p.apiKey) ?? '',
        model: str(p.model) ?? '',
      }
    }
  } else if (str(raw.apiKey) !== undefined || str(raw.model) !== undefined) {
    // v1: a single Gemini key and model.
    out.providers.gemini = { enabled: true, apiKey: str(raw.apiKey) ?? '', model: str(raw.model) ?? '' }
  }

  if (Array.isArray(raw.order)) {
    const seen = new Set<SettingsProviderId>()
    for (const id of raw.order) {
      if (isSettingsProviderId(id) && !seen.has(id)) seen.add(id)
    }
    out.order = [...seen, ...SETTINGS_PROVIDER_ORDER.filter((id) => !seen.has(id))]
  }

  out.outputLanguage = str(raw.outputLanguage) || 'auto'
  return out
}

export async function readSettings(storage: SettingsStorage | null): Promise<Settings> {
  if (!storage) return cloneDefaults()
  try {
    const bag = await storage.get(SETTINGS_KEY)
    return normalizeSettings(bag[SETTINGS_KEY])
  } catch {
    // Extension context invalidated (reloaded while a page stayed open).
    return cloneDefaults()
  }
}

export type SettingsPatch = {
  providers?: Partial<Record<SettingsProviderId, Partial<ProviderSettings>>>
  order?: SettingsProviderId[]
  outputLanguage?: string
}

/**
 * Read-modify-write of a partial patch; untouched providers and fields are
 * preserved (patching Groq's key must not clear Gemini's).
 */
export async function writeSettings(storage: SettingsStorage | null, patch: SettingsPatch): Promise<Settings> {
  const current = await readSettings(storage)
  const providers = { ...current.providers }
  for (const id of SETTINGS_PROVIDER_ORDER) {
    const p = patch.providers?.[id]
    if (p) providers[id] = { ...providers[id], ...p }
  }
  const next = normalizeSettings({
    providers,
    order: patch.order ?? current.order,
    outputLanguage: patch.outputLanguage ?? current.outputLanguage,
  })
  if (!storage) return next
  await storage.set({ [SETTINGS_KEY]: next })
  return next
}

/**
 * Filters on area AND key: `onChanged` fires for every area and every key,
 * including the cache writes, which must not look like a settings change.
 */
export function subscribeSettings(storage: SettingsStorage | null, onChange: (s: Settings) => void): () => void {
  if (!storage) return () => {}
  const listener: ChangeListener = (changes, areaName) => {
    if (areaName !== 'local') return
    const entry = changes[SETTINGS_KEY]
    if (!entry) return
    onChange(normalizeSettings(entry.newValue))
  }
  try {
    storage.onChanged.addListener(listener)
  } catch {
    return () => {}
  }
  return () => {
    try {
      storage.onChanged.removeListener(listener)
    } catch {
      // Context gone; the listener went with it.
    }
  }
}

export function isSettingsProviderId(v: unknown): v is SettingsProviderId {
  return typeof v === 'string' && (SETTINGS_PROVIDER_ORDER as readonly string[]).includes(v)
}

function cloneDefaults(): Settings {
  return structuredClone(DEFAULT_SETTINGS)
}
