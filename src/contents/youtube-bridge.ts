import type { PlasmoCSConfig } from 'plasmo'

import { startBridge } from '../contexts/video-capture/infrastructure/youtube/bridge'

// ISOLATED world (the default) so it can use chrome.runtime. document_start so
// it is already listening when the MAIN-world hooks post the first captions.
export const config: PlasmoCSConfig = {
  matches: ['https://www.youtube.com/*'],
  run_at: 'document_start',
}

startBridge()
