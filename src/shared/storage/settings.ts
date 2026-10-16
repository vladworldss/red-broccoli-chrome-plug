/**
 * User settings in `chrome.storage.local`, under ONE key holding one object so
 * an update fires `onChanged` once — no half-applied state reaches the UI.
 *
 * Local, not `sync`: the API key must not be copied to other devices via the
 * user's Google account. It is stored unencrypted in the Chrome profile (the
 * Options page says so) and is only ever read by extension pages — content
 * scripts never see it.
 */
import { isRecord, type ChangeListener, type KeyValueStorage } from './kv'

export type Settings = {
  /** Gemini API key from Google AI Studio. Empty = not configured. */
  apiKey: string
  /** Empty = the adapter's default (a rolling "latest Flash" alias). */
  model: string
  /** "auto" = the lecture's own language; otherwise a language name. */
  outputLanguage: string
}

export const SETTINGS_KEY = 'sh:settings'

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: '',
  outputLanguage: 'auto',
}

type SettingsStorage = Pick<KeyValueStorage, 'get' | 'set' | 'onChanged'>

/** Defensive parse: wrong types fall back to defaults rather than being coerced. */
export function normalizeSettings(raw: unknown): Settings {
  if (!isRecord(raw)) return { ...DEFAULT_SETTINGS }
  const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v.trim() : fallback)
  return {
    apiKey: str(raw.apiKey, DEFAULT_SETTINGS.apiKey),
    model: str(raw.model, DEFAULT_SETTINGS.model),
    outputLanguage: str(raw.outputLanguage, DEFAULT_SETTINGS.outputLanguage) || 'auto',
  }
}

export async function readSettings(storage: SettingsStorage | null): Promise<Settings> {
  if (!storage) return { ...DEFAULT_SETTINGS }
  try {
    const bag = await storage.get(SETTINGS_KEY)
    return normalizeSettings(bag[SETTINGS_KEY])
  } catch {
    // Extension context invalidated (reloaded while a page stayed open).
    return { ...DEFAULT_SETTINGS }
  }
}

/** Read-modify-write of a partial patch; sibling fields are preserved. */
export async function writeSettings(
  storage: SettingsStorage | null,
  patch: Partial<Settings>,
): Promise<Settings> {
  const current = await readSettings(storage)
  const next = normalizeSettings({ ...current, ...patch })
  if (!storage) return next
  await storage.set({ [SETTINGS_KEY]: next })
  return next
}

/**
 * Filters on area AND key: `onChanged` fires for every area and every key,
 * including the cache writes, which must not look like a settings change.
 */
export function subscribeSettings(
  storage: SettingsStorage | null,
  onChange: (s: Settings) => void,
): () => void {
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
