import type { PlasmoCSConfig } from 'plasmo'

import { installPageHooks } from '../contexts/video-capture/infrastructure/youtube/pageHooks'

// MAIN world + document_start: the fetch/XHR wrappers must be in place before
// YouTube's player script makes its first caption request. See pageHooks.ts.
export const config: PlasmoCSConfig = {
  matches: ['https://www.youtube.com/*'],
  world: 'MAIN',
  run_at: 'document_start',
}

installPageHooks()
