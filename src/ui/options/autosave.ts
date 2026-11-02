/**
 * Auto-save for the Settings page. There is no Save button: every change is
 * written on its own, so a user who pastes a key and closes the tab keeps it.
 *
 * - `schedule` debounces (typing a key is many changes, one write);
 * - `now` writes at once (a checkbox, a reorder, the language);
 * - `flush` writes a pending change immediately (field blur, tab hidden).
 *
 * Writes run one at a time, in order: `writeSettings` is read-modify-write, so
 * two overlapping writes could otherwise land out of order. A failed write is
 * kept as pending, so the next `flush` (the Retry button) sends it again.
 */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export type Autosaver<T> = {
  schedule: (value: T) => void
  now: (value: T) => Promise<void>
  flush: () => Promise<void>
}

export function createAutosaver<T>(
  write: (value: T) => Promise<unknown>,
  opts: { delayMs: number; onState: (state: SaveState) => void },
): Autosaver<T> {
  let pending: { value: T } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let queue: Promise<void> = Promise.resolve()

  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = null
    if (!pending) return queue
    const { value } = pending
    pending = null
    opts.onState('saving')
    queue = queue.then(
      () =>
        write(value).then(
          // A newer change is already waiting: it will report its own outcome.
          () => (pending ? undefined : opts.onState('saved')),
          () => {
            pending ??= { value }
            opts.onState('error')
          },
        ),
    )
    return queue
  }

  return {
    schedule(value) {
      pending = { value }
      opts.onState('saving')
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void flush(), opts.delayMs)
    },
    now(value) {
      pending = { value }
      return flush()
    },
    flush,
  }
}
