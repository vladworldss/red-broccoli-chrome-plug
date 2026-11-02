import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/storage/settings'
import { readiness } from '../../src/ui/llmChain'
import { createAutosaver, type SaveState } from '../../src/ui/options/autosave'

function harness(write: (v: string) => Promise<unknown> = async () => {}) {
  const writes: string[] = []
  const states: SaveState[] = []
  const saver = createAutosaver<string>(
    (v) => {
      writes.push(v)
      return write(v)
    },
    { delayMs: 400, onState: (s) => states.push(s) },
  )
  return { saver, writes, states }
}

describe('createAutosaver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('typing: one write of the last value after the pause', async () => {
    const { saver, writes, states } = harness()
    saver.schedule('a')
    saver.schedule('ab')
    saver.schedule('abc')
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(400)
    expect(writes).toEqual(['abc'])
    expect(states.at(-1)).toBe('saved')
  })

  it('flush (blur, tab hidden) writes the pending value at once, and only once', async () => {
    const { saver, writes } = harness()
    saver.schedule('key')
    await saver.flush()
    expect(writes).toEqual(['key'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toEqual(['key'])
  })

  it('flush with nothing pending writes nothing', async () => {
    const { saver, writes } = harness()
    await saver.flush()
    expect(writes).toEqual([])
  })

  it('writes never overlap: the second waits for the first', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let active = 0
    let maxActive = 0
    const { saver, writes } = harness(async (v) => {
      active++
      maxActive = Math.max(maxActive, active)
      if (v === 'first') await gate
      active--
    })
    void saver.now('first')
    const second = saver.now('second')
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual(['first'])
    release()
    await second
    expect(writes).toEqual(['first', 'second'])
    expect(maxActive).toBe(1)
  })

  it('a failed write is reported and retried by the next flush', async () => {
    let fail = true
    const { saver, writes, states } = harness(async () => {
      if (fail) throw new Error('quota')
    })
    await saver.now('v')
    expect(states.at(-1)).toBe('error')
    fail = false
    await saver.flush()
    expect(writes).toEqual(['v', 'v'])
    expect(states.at(-1)).toBe('saved')
  })

  it('a failed write does not overwrite a newer pending change', async () => {
    let fail = true
    const { saver, writes } = harness(async () => {
      if (fail) throw new Error('quota')
    })
    const first = saver.now('old')
    saver.schedule('new')
    await first
    fail = false
    await saver.flush()
    expect(writes).toEqual(['old', 'new'])
  })
})

describe('readiness', () => {
  const settings = (patch: (s: Settings) => void): Settings => {
    const s = structuredClone(DEFAULT_SETTINGS)
    patch(s)
    return s
  }

  it('off → no key → no access → ready, in that order', () => {
    expect(readiness(settings(() => {}), 'groq', true)).toBe('off')
    expect(readiness(settings((s) => (s.providers.groq.enabled = true)), 'groq', true)).toBe('no-key')
    const keyed = settings((s) => (s.providers.groq = { enabled: true, apiKey: 'k', model: '' }))
    expect(readiness(keyed, 'groq', false)).toBe('no-access')
    expect(readiness(keyed, 'groq', true)).toBe('ready')
  })

  it('a key of spaces is no key (the draft is untrimmed)', () => {
    expect(readiness(settings((s) => (s.providers.gemini.apiKey = '  ')), 'gemini', true)).toBe('no-key')
  })

  it('Gemma is ready with the Gemini key', () => {
    const s = settings((s) => {
      s.providers.gemini.apiKey = 'g'
      s.providers.gemma.enabled = true
    })
    expect(readiness(s, 'gemma', true)).toBe('ready')
  })
})
