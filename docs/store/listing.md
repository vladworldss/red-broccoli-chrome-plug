# Chrome Web Store listing — StudHelper 0.1.0

## Basics

- **Name:** StudHelper: Lecture Concept Maps
- **Category:** Education
- **Language:** English
- **Single purpose:** Build study concept maps from lecture videos.

Brand policy: don't use the YouTube logo, don't start the name with
"YouTube", and don't imply it is an official tool. "for YouTube lectures"
in the description is fine. There is no download feature.

## Short description (≤132 chars)

> Turn a lecture video into a study concept map: key terms, definitions, prerequisites, and clickable timestamps.

## Detailed description

> **Study the concepts, not the whole transcript.**
>
> StudHelper builds a concept map of the lecture you're watching on YouTube.
> Click Build map in the side panel to get:
>
> • The key terms of the lecture, each with a one-line definition
> • How they fit together: what is part of what, and what you need to know first
> • A timestamp on every concept. Click it to jump to where it is explained
> • A zoomable mind map view
> • Copy as Markdown (for Obsidian or Notion, with timestamp links) or as a Mermaid diagram
>
> Maps are saved in your browser, so reopening a lecture shows its map instantly.
>
> **Needs a free Google Gemini API key.** StudHelper uses Google Gemini to find
> the concepts. Get a free key at aistudio.google.com and paste it into
> Settings. The video's title and transcript are sent to Gemini only when you
> press Build map. StudHelper has no server and collects no analytics.
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
| Host `https://generativelanguage.googleapis.com/*` | Sends the lecture transcript to Google Gemini with the user's own key, when they press Build map. |
| Content script on `https://www.youtube.com/*` | Reads the captions or transcript of the video being watched and seeks the video when the user clicks a timestamp. |

## Assets still to make

- [ ] Icon 128×128. The current `assets/icon.png` is a generated placeholder
      (`make icon`).
- [ ] 1–5 screenshots at 1280×800: the panel with a map, the mind map, settings.
- [ ] Small promo tile, 440×280.

## Release steps

1. Bump `version` in `package.json` and add a `CHANGELOG.md` section, in the
   same PR.
2. Run `make store-zip` to produce `dist/studhelper-v<version>.zip`.
3. In the Developer Dashboard, create a new item and upload the zip. Fill in
   the listing and the privacy tab.
4. Make the first release **Unlisted** for student testers, then switch it
   to Public.
