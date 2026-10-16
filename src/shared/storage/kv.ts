/**
 * The slice of `chrome.storage.local` this extension touches. Narrow on purpose:
 * it keeps the test double small and documents exactly what is used.
 */

export type StorageChange = { newValue?: unknown; oldValue?: unknown }
export type ChangeListener = (changes: Record<string, StorageChange>, areaName: string) => void

export type KeyValueStorage = {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
  getBytesInUse(keys: null): Promise<number>
  onChanged: {
    addListener(cb: ChangeListener): void
    removeListener(cb: ChangeListener): void
  }
}

/** Every key this extension writes starts with this, so "clear" can't hit anything else. */
export const KEY_PREFIX = 'sh:'

/**
 * Real `chrome.storage.local`, or `null` where the API is unavailable (jsdom,
 * an invalidated extension context). Callers treat `null` as "use defaults,
 * don't persist".
 */
export function chromeLocalStorage(): KeyValueStorage | null {
  try {
    const local = globalThis.chrome?.storage?.local
    const onChanged = globalThis.chrome?.storage?.onChanged
    if (!local || !onChanged) return null
    return {
      get: (keys) => local.get(keys) as Promise<Record<string, unknown>>,
      set: (items) => local.set(items),
      remove: (keys) => local.remove(keys),
      getBytesInUse: (keys) => local.getBytesInUse(keys),
      onChanged: {
        addListener: (cb) => onChanged.addListener(cb),
        removeListener: (cb) => onChanged.removeListener(cb),
      },
    }
  } catch {
    return null
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
