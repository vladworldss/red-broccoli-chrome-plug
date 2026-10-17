# 🥦 RedBroccoli

> “Don't look at the whole forest. Just look at the Red Broccoli.”

**RedBroccoli** is a fun and clever extension that instantly “grows” a
knowledge graph of any YouTube lecture. It cuts out the fluff and leaves you
with the juicy essence.

A Chrome extension for students. Open a lecture on YouTube, click **Build map**,
and the side panel shows the lecture's **key concepts** as a tree:

- each term with a one-line definition, as this lecture explains it;
- what it is part of (the hierarchy) and what you need to know first (`needs: …`);
- a timestamp chip on each term — click it and the video jumps to where the
  concept is explained;
- a **Mind map** tab with the same tree as a zoomable map;
- **Copy Markdown** (Obsidian/Notion-ready, with timestamp links) and
  **Copy Mermaid** (the full concept graph — paste it into
  [mermaid.live](https://mermaid.live), or a ```` ```mermaid ```` block in
  GitHub/Obsidian/Notion);
- **Download .srt / .txt**: the lecture's subtitles as a file. This works
  without an API key, and the .txt can be pasted back to rebuild a map.

It is not a summary of the video. It is a map of the concepts.

```
Calculus: limits and derivatives
 ├─ Limit  [0:15]
 └─ Derivative  [1:05]        needs: Limit, Difference quotient
     ├─ Chain rule  [2:10]
     └─ Product rule  [2:10]
```

## How it works

1. **Transcript.** The extension reads the captions the YouTube player itself
   loads. If that fails, it falls back to YouTube's "Show transcript" panel.
   If that fails too, you can paste the transcript yourself. Captions may
   switch on for a moment while they load.
2. **Concepts.** The transcript goes to an AI provider using **your own API
   key**. Two calls are made: one extracts the concepts, the other links
   them. Supported providers are Gemini, Mistral, Groq, OpenRouter, Gemma and
   DeepSeek, tried in the order you set. When one runs out of quota or fails,
   the next one takes over automatically.
3. **Cache.** The map is stored in your browser, so reopening the video
   shows it instantly and makes no API calls. Use **Rebuild** to build it again.

There is no RedBroccoli server and no analytics. See
[docs/store/privacy-policy.md](docs/store/privacy-policy.md).

## Install (developer mode)

```bash
make install        # npm ci
make build          # → build/chrome-mv3-prod
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `build/chrome-mv3-prod`.
3. Click the extension icon → ⚙ (Settings), then add at least one key
   (each provider row has a "Get a key ↗" link). For example, a Gemini key from
   [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
   Press **Test key**, then **Save**.
4. Open a YouTube lecture and click the extension icon to open the side panel.

YouTube tabs that were open **before** you installed or reloaded the extension
don't have it yet. Reload them once.

After each rebuild, press ↻ on the extension card and reload the YouTube tab.
The panel header shows the loaded version.

## Develop

```bash
make dev            # Plasmo dev server with hot reload
make check          # typecheck + tests (run before committing)
make smoke-live     # real round trip per provider whose key is in .env.local (see .env.example)
make store-zip      # hermetic prod build + manifest/secret/remote-code checks → dist/*.zip
make help           # all targets
```

Debugging:

- **Side panel:** right-click inside it → Inspect.
- **Content scripts:** in the YouTube tab, open DevTools → Console and pick the
  extension's context.
- **Service worker:** the "service worker" link on the extension card.

## Layout

The code is split into three DDD bounded contexts. Details are in
[docs/architecture.md](docs/architecture.md).

| Context | Role |
|---|---|
| `src/contexts/video-capture` | YouTube: transcript capture (intercept → DOM panel → paste), metadata, seeking |
| `src/contexts/concept-mapping` | **Core**: extract → merge → relate → tree, exporters, map cache |
| `src/contexts/llm-gateway` | `LlmPort`; Gemini and OpenAI-compatible adapters; provider presets; fallback chain, pacing, error taxonomy |
| `src/ui/` | Side panel and options pages (composition root) |

## Status

This is the MVP described in [studhelper.md](studhelper.md): cloud Gemini with
your own key, concepts with `part-of` and `requires` links, a tree and mind
map, and a cache. The v2 ideas (local Gemini Nano, course-wide graphs across
a playlist, Anki export, quizzes) are listed there.

YouTube changes its page often. If capture breaks, start with
`src/contexts/video-capture/infrastructure/youtube/selectors.ts`.
