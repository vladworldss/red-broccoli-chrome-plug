// Public surface of the video-capture context. Other contexts and the UI import
// from here, never from domain/ or infrastructure/ directly.
export * from './application/captureTranscript'
export type {
  CaptionTrack,
  Chapter,
  Segment,
  TimedLine,
  Transcript,
  TranscriptSource,
  VideoMeta,
} from './domain'
export { parseManualTranscript, subtitleFileName, toSrt, toTimestampedText, videoIdFromUrl } from './domain'
export { ChromeTranscriptCache } from './infrastructure/ChromeTranscriptCache'
export type { TabState } from './infrastructure/messages'
export {
  YouTubeTabClient,
  activeTabId,
  subscribeTabChanges,
  watchUrl,
} from './infrastructure/YouTubeTabClient'
