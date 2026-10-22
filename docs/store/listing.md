# Chrome Web Store listing — RedBroccoli 0.5.0

## Basics

- **Name:** RedBroccoli: Lecture Concept Maps
- **Category:** Education
- **Language:** English
- **Single purpose:** Build study concept maps from lecture videos.

Brand policy: don't use the YouTube logo, don't start the name with
"YouTube", and don't imply it is an official tool. "for YouTube lectures"
in the description is fine. There is no video or audio download feature;
downloader extensions get rejected. The subtitle download (.srt/.txt) saves
only the transcript text already loaded for the map. Describe it as study
notes, never as "download from YouTube".

## Short description (≤132 chars)

> Turn a lecture video into a study concept map: key terms, definitions, prerequisites, and clickable timestamps.

## Detailed description

> **Study the concepts, not the whole transcript.**
>
> RedBroccoli builds a concept map of the lecture you're watching on YouTube.
> Click Build map in the side panel to get:
>
> • The key terms of the lecture, each with a one-line definition
> • How they fit together: what is part of what, and what you need to know first
> • A timestamp on every concept. Click it to jump to where it is explained
> • A zoomable mind map view
> • Download plain-language lecture notes (.md): one chapter per concept, with timestamps and links for self-study
> • Read-more links for every concept: Wikipedia, YouTube explainers, Khan Academy and more
> • Copy as Markdown (for Obsidian or Notion, with timestamp links) or as a Mermaid diagram
> • Save the lecture's subtitles as .srt (with timing) or readable .txt
>
> Maps are saved in your browser, so reopening a lecture shows its map instantly.
>
> **Needs a free API key from an AI provider.** RedBroccoli works with Google
> Gemini, Mistral, Groq, OpenRouter or DeepSeek. Add one or more keys in
> Settings; when one provider runs out of free quota, the next one takes
> over. The video's title and transcript are sent to the provider only when
> you press Build map. RedBroccoli has no server and collects no analytics.
>
> Works with videos that have captions (auto-generated captions are fine). If
> captions can't be read automatically, you can paste the transcript yourself.

## Privacy tab

- **Privacy policy URL:** publish [privacy-policy.md](privacy-policy.md), for
  example on GitHub Pages.
- **Data usage:** "Website content" (the video title and transcript). It is
  transmitted to Google Gemini at the user's request. It is not sold, not used
  for unrelated purposes, and not used for creditworthiness.
- **Remote code:** None. All JavaScript is bundled. LLM output is treated as
  data and HTML-escaped before rendering.

### Permission justifications

| Permission | Justification |
|---|---|
| `sidePanel` | The concept map is displayed in Chrome's side panel next to the video. |
| `storage` | Stores the user's settings, their Gemini API key, and cached maps locally. |
| `scripting` | Registers the content script that must run in the YouTube page's main world at document start to read the captions the player loads. Without it, captions can't be read. |
| Host `https://generativelanguage.googleapis.com/*` | Sends the lecture transcript to Google Gemini (the default provider) with the user's own key, when they press Build map. |
| Optional hosts `https://api.mistral.ai/*`, `https://api.groq.com/*`, `https://openrouter.ai/*`, `https://api.deepseek.com/*` | Requested at runtime only for the AI providers the user enables in Settings; used only to send the transcript to that provider with the user's own key. |
| Content script on `https://www.youtube.com/*` | Reads the captions or transcript of the video being watched and seeks the video when the user clicks a timestamp. |

## Assets still to make

- [x] Icon 128×128: `docs/store/images/icon-128.png`, made from the logo
      `assets/icon.png` (`sips -z 128 128 assets/icon.png --out …`). Upload it
      by hand in the listing form; it is not inside the zip.
- [ ] 1–5 screenshots at 1280×800: the panel with a map, the mind map, settings.
- [ ] Small promo tile, 440×280.

## Release steps

1. Bump `version` in `package.json` and add a `CHANGELOG.md` section, in the
   same PR.
2. Run `make store-zip` to produce `dist/red-broccoli-v<version>.zip`.
3. In the Developer Dashboard, create a new item and upload the zip. Fill in
   the listing and the privacy tab.
4. Make the first release **Unlisted** for student testers, then switch it
   to Public.
