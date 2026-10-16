# Changelog

All notable changes to StudHelper are documented here.
Versions follow the `version` field in [package.json](package.json), which is
what the side panel header shows.

## [0.1.0] — 2026-10-16

### First version: concept maps from YouTube lectures

Open a lecture on YouTube and click **Build map** in the side panel. You get
the lecture's key concepts as a tree, not a summary of the video.

- **Concept tree.** Each term has a short definition taken from the lecture.
  Concepts are grouped by what they are part of, and each one lists what you
  need to know first.
- **Jump to the moment.** Each concept has a timestamp. Click it and the video
  jumps to where that concept is explained.
- **Mind map view.** The same tree as a zoomable mind map.
- **Copy Markdown** (with timestamp links) and **Copy Mermaid** (the full
  concept graph), for Obsidian, Notion, or any Markdown notes.
- **Instant reopen.** Maps are kept in your browser. Reopening a video shows
  its map immediately, without asking Gemini again. **Rebuild** asks again.
- **When captions can't be read** automatically, paste the transcript from
  YouTube's "Show transcript" panel (or any text) and build from that.

Concepts are found by Google Gemini using your own free API key from Google AI
Studio, which you add in Settings. Only the video's title and transcript are
sent, and only when you press Build. There is no StudHelper server and no
analytics.
