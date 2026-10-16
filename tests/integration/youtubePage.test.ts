// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PAGE_FROM_MAIN } from '../../src/contexts/video-capture/infrastructure/messages'
import { installPageHooks } from '../../src/contexts/video-capture/infrastructure/youtube/pageHooks'
import {
  readTranscriptRows,
  scrapeTranscriptPanel,
} from '../../src/contexts/video-capture/infrastructure/youtube/transcriptPanel'
import { fixture } from '../unit/helpers/fixtures'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('transcript panel scraper', () => {
  it('reads rows from the panel markup', () => {
    document.body.innerHTML = fixture('transcript-panel.html')
    expect(readTranscriptRows(document)).toEqual([
      { timestamp: '0:00', text: 'Today we talk about limits.' },
      { timestamp: '0:04', text: 'A limit describes where a function is heading.' },
      { timestamp: '12:14', text: 'The derivative is the limit of the difference quotient.' },
      { timestamp: '1:02:05', text: '' },
    ])
  })

  it('opens the panel via "Show transcript", waits for rows, then hides it again', async () => {
    document.body.innerHTML = `
      <ytd-video-description-transcript-section-renderer><button>Show transcript</button></ytd-video-description-transcript-section-renderer>
      <div id="panel-host"></div>`
    const button = document.querySelector('button')!
    button.addEventListener('click', () => {
      // YouTube renders the panel asynchronously after the click.
      setTimeout(() => {
        document.getElementById('panel-host')!.innerHTML = fixture('transcript-panel.html')
      }, 0)
    })

    const segments = await scrapeTranscriptPanel(document, {
      pollMs: 1,
      timeoutMs: 200,
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    })
    expect(segments.map((s) => s.start)).toEqual([0, 4, 734]) // empty row dropped
    expect(
      document.querySelector('ytd-engagement-panel-section-list-renderer')!.getAttribute('visibility'),
    ).toBe('ENGAGEMENT_PANEL_VISIBILITY_HIDDEN')
  })

  it('no button and no panel → empty, quickly', async () => {
    expect(await scrapeTranscriptPanel(document, { timeoutMs: 10, pollMs: 5 })).toEqual([])
  })
})

describe('MAIN-world page hooks', () => {
  it('passes responses through untouched and forwards timedtext bodies to the bridge', async () => {
    const body = '{"events":[{"tStartMs":0,"dDurationMs":1000,"segs":[{"utf8":"hi"}]}]}'
    const origFetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('timedtext') ? new Response(body) : new Response('other'),
    )
    window.fetch = origFetch as unknown as typeof fetch

    const posted: unknown[] = []
    const onMessage = (e: MessageEvent) => posted.push(e.data)
    window.addEventListener('message', onMessage)

    installPageHooks()
    installPageHooks() // idempotent: must not double-wrap

    const res = await window.fetch('https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&pot=TOKEN')
    expect(await res.text()).toBe(body) // the page still gets the full body
    expect(await (await window.fetch('https://www.youtube.com/youtubei/v1/next')).text()).toBe('other')

    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual({
      source: PAGE_FROM_MAIN,
      kind: 'timedtext',
      url: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&pot=TOKEN',
      body,
    })
    expect(origFetch).toHaveBeenCalledTimes(2)
    window.removeEventListener('message', onMessage)
  })
})
