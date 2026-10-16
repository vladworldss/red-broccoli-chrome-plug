import type { ChangeListener, KeyValueStorage, StorageChange } from '../../../src/shared/storage/kv'

export type FakeChromeStorage = KeyValueStorage & {
  /** Raw backing bag, for asserting what actually landed in storage. */
  data: Record<string, unknown>
  listenerCount(): number
  /** Emit an arbitrary change, e.g. a foreign key or a non-local area. */
  emit(changes: Record<string, StorageChange>, areaName?: string): void
}

/**
 * Minimal `chrome.storage.local` double (ported from chrome_ai_plug, extended
 * with get(null)/get([...]), remove and getBytesInUse).
 *
 *  - `set()`/`remove()` fire `onChanged` the way Chrome does.
 *  - `get()` omits missing keys (NOT `{key: undefined}`), like the real API.
 *  - Values are deep-copied on the way in and out, as Chrome serializes them —
 *    so a test can't pass by mutating a shared object reference.
 */
export function fakeChromeStorage(initial: Record<string, unknown> = {}): FakeChromeStorage {
  const data: Record<string, unknown> = structuredClone(initial)
  const listeners = new Set<ChangeListener>()
  const emit = (changes: Record<string, StorageChange>, areaName = 'local') => {
    for (const l of [...listeners]) l(changes, areaName)
  }

  return {
    data,
    listenerCount: () => listeners.size,
    emit,
    async get(keys) {
      const wanted = keys === null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys]
      const out: Record<string, unknown> = {}
      for (const k of wanted) if (k in data) out[k] = structuredClone(data[k])
      return out
    },
    async set(items) {
      const changes: Record<string, StorageChange> = {}
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data[k], newValue: structuredClone(v) }
        data[k] = structuredClone(v)
      }
      emit(changes)
    },
    async remove(keys) {
      const changes: Record<string, StorageChange> = {}
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (!(k in data)) continue
        changes[k] = { oldValue: data[k] }
        delete data[k]
      }
      emit(changes)
    },
    async getBytesInUse() {
      return Object.entries(data).reduce((n, [k, v]) => n + k.length + JSON.stringify(v).length, 0)
    },
    onChanged: {
      addListener: (cb) => void listeners.add(cb),
      removeListener: (cb) => void listeners.delete(cb),
    },
  }
}
