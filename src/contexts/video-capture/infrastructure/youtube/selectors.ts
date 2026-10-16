/**
 * Every YouTube DOM selector in one place. YouTube ships UI changes often;
 * when capture breaks, this file is the first thing to check. Each list is
 * tried in order — newest known markup first, older kept as fallback.
 */

export const VIDEO_ELEMENT = ['#movie_player video', 'video.html5-main-video', 'video']

export const PLAYER = '#movie_player'

export const SUBTITLES_BUTTON = '.ytp-subtitles-button'

/** "Show transcript" button in the (possibly collapsed) description. */
export const SHOW_TRANSCRIPT_BUTTON = [
  'ytd-video-description-transcript-section-renderer button',
  '#primary-button ytd-button-renderer button[aria-label*="ranscript"]',
  'button[aria-label*="ranscript"]',
]

export const TRANSCRIPT_PANEL = [
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]',
  'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]',
]

/** Segment row variants: [row, timestamp-within-row, text-within-row]. */
export const TRANSCRIPT_ROWS: ReadonlyArray<readonly [string, string, string]> = [
  ['ytd-transcript-segment-renderer', '.segment-timestamp', '.segment-text'],
  [
    'transcript-segment-view-model',
    '[class*="Timestamp"], .ytwTranscriptSegmentViewModelTimestamp',
    '[role="text"], .yt-core-attributed-string',
  ],
]

export const PANEL_HIDDEN = 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'
