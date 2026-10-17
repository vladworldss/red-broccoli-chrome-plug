# Changelog

All notable changes to RedBroccoli (called StudHelper up to 0.3.0) are
documented here. Versions follow the `version` field in
[package.json](package.json), which is what the side panel header shows.

## [0.4.0] — 2026-10-17

### StudHelper is now RedBroccoli 🥦

- **New name and logo.** In Chrome and the Web Store the extension is now
  "RedBroccoli: Lecture Concept Maps", with a red broccoli icon.
- **Nothing to set up again.** Your API keys, provider order and saved maps
  carry over as they are.

## [0.3.0] — 2026-10-16

### More AI providers, with automatic fallback

Gemini's free tier only covers a handful of lectures a day. StudHelper can
now use several AI providers, and when one runs out it moves on to the next
by itself.

- **Providers:** Gemini, Mistral, Groq, OpenRouter, Gemma and DeepSeek.
  Add a free key for any of them in Settings; each row has a **Get a key ↗**
  link and a **Test** button.
  - Groq's free tier is the most generous (about 1,000 requests a day), and
    it also offers free Qwen models.
  - Gemma reuses your Gemini key with its own quota, but it's very slow.
  - DeepSeek is paid, at about $0.003 per lecture.
- **Fallback chain:** providers are tried in the order you set (↑ ↓ in
  Settings). If one hits its limit or fails, the next one builds the map, and
  the panel says so ("Gemini: daily quota used up — trying Mistral…"). A
  provider that just ran out is skipped for a while instead of being asked
  again for every lecture.
- **The map says who built it.** A badge shows the provider and model, for
  example "Groq · openai/gpt-oss-120b".
- **When everyone fails,** the error lists each provider's reason on its own
  line.
- **Long lectures on small free tiers:** providers with a small per-minute
  budget (Groq) get the transcript in parts, with pauses in between, instead
  of failing. The panel counts down each pause ("Continuing in 34 s…"), so a
  pause no longer looks like a hang. A one-hour lecture on Groq's free tier
  takes about 2½ minutes.
- **Switching tabs or videos no longer cancels a build.** It keeps running;
  come back to the video to see its progress or the finished map.
- **Pasting a subtitle file (.srt or .vtt)** into the paste box now works:
  cue numbers and timing lines are no longer sent to the AI as text. Sound
  labels like "[Music]" are left out too.
- **A provider that hangs** is abandoned after a few minutes, and the next one
  takes over.
- **Your Gemini key and model carry over** from the previous version
  automatically.

Access to the extra providers is requested only when you enable them (Chrome
asks once on **Save**). The transcript goes only to the first provider in
your list that works, and to the next ones only if it fails.

## [0.2.0] — 2026-10-16

### Download the lecture's subtitles

The side panel now has **Download .srt** and **Download .txt** buttons, both
on the map and before you build one.

- **.srt** is a standard subtitle file with the original timing. It opens in
  VLC, any video editor, or a subtitle tool.
- **.txt** is readable text, one sentence-like line per entry, each starting
  with its timestamp (`12:14 The derivative is…`). Paste it back into the
  panel's paste box to rebuild a map, after editing it if you like.
- **No API key needed.** Downloading never contacts Gemini. Once a map has
  been built, the subtitles come from the browser's cache, so captions don't
  flicker again.
- **Always available.** The buttons stay while a map is being built and when
  building fails (rate limit, Gemini overloaded, missing or wrong key).
- File names follow the video: `1. Algorithms and Computation [ZA-tUyM_y7s].en.srt`.

Only the transcript text is saved. There is no video or audio download.

### A failed rebuild keeps your map

If Gemini fails (rate limit, overload, a wrong or missing key), the panel
used to replace the map with an error. Now the map stays on screen, with
the error shown above it and a **Try again** button. If this version has
never built a map for the video, the newest older one is shown instead,
marked **older version** (built with another model or an earlier prompt).
You only see a plain error when the video has no map at all.

### Clear messages when you hit a Gemini limit

Every limit used to say "Wait a minute and try again", even when the
daily quota was used up and waiting a minute could not help. Now:

- **Per-minute limit:** the message says whether requests or tokens ran
  out and how many seconds Google asks you to wait.
- **Daily limit:** the message names the model and its daily limit and says
  how long until it resets (midnight Pacific time). It offers **Open
  Settings** to switch to another model, which has its own quota.
- **Less waiting on a lost cause:** a daily limit is no longer retried for
  half a minute before the error appears, and neither is a per-minute wait
  longer than 30 seconds.
- **See your limits in AI Studio ↗** links to the page that shows your
  key's limits and usage. Gemini offers no way to check the remaining quota
  before a request.

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
