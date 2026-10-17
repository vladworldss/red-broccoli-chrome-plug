# Architecture

This is a condensed arc42 view.

## Runtime view

```
YouTube tab
 ├─ youtube-main      MAIN world, document_start (registered via chrome.scripting)
 │   wraps fetch/XHR → copies the player's own /api/timedtext responses
 │   answers get-meta (player response) / enable-captions / restore-captions
 │        ⇅ window.postMessage (validated; nothing secret crosses)
 └─ youtube-bridge    ISOLATED world, document_start
     parses + keeps captures per video, scrapes "Show transcript" as fallback,
     seeks <video>, announces SPA navigation (yt-navigate-finish)
          ⇅ chrome.tabs.sendMessage / chrome.runtime.sendMessage
Side panel (extension page): composition root, src/ui/sidepanel/usePanel.ts
 ├─ captureTranscript: cache → intercept → DOM panel → (user paste)
 ├─ buildConceptMap:   cache → chunk → extract → merge → relate → map → cache
 │     └─ LlmPort = FallbackLlm(order from Settings)
 │          Gemini ─▶ Mistral ─▶ Groq ─▶ OpenRouter ─▶ Gemma ─▶ DeepSeek
 │          (each: retries, timeout, pacing; on failure the next one, with a cooldown)
 └─ render: ConceptTree (list) | MindMap (markmap-view) ; Copy Markdown/Mermaid
Service worker: only setPanelBehavior({openPanelOnActionClick: true})
```

The pipeline runs in the **side panel**, not the service worker. The panel
lives as long as the user is looking at it, while MV3 can shut down an idle
worker in the middle of a 20–60 s Gemini call. The video plays in another
process, so playback is never affected.

## Bounded contexts

| Context | Domain | Application (ports) | Infrastructure |
|---|---|---|---|
| **video-capture** | `Transcript`, `VideoMeta`; parsers for json3 / srv1 / srv3 / DOM rows / pasted text; `mergeIntoLines`, `parseChapters`, `chooseCaptionTrack` | `TranscriptProvider`, `TranscriptCache`; `captureTranscript`, `manualTranscript`, `transcriptToLines` | `pageHooks` (MAIN), `bridge` (ISOLATED), `transcriptPanel`, `selectors`, `YouTubeTabClient`, `ChromeTranscriptCache` |
| **concept-mapping** (core) | `Concept`, `Relation`, `ConceptMap` (invariants in `createConceptMap`); `normalizeTerm`, `mergeConcepts`, `validateExtraction/Relations`, `toTree`, `toMarkdown`, `toMermaid`, `chunkLines` | `ConceptMapCache`; `buildConceptMap`, `loadCachedConceptMap`; `prompts.ts` + `PROMPT_VERSION` | `ChromeConceptMapCache` |
| **llm-gateway** | `LlmError` taxonomy and `classifyHttpError` (Google and OpenAI error shapes), `PROVIDERS` presets, `RateLimiter`, `toStandardJsonSchema`, `extractJson` | `LlmPort`; `FallbackLlm` (provider chain, cooldowns, `InputTooLargeError`) | `GeminiApiAdapter` (Gemini, Gemma), `OpenAiCompatibleAdapter` (Mistral, Groq, OpenRouter, DeepSeek), `createAdapter`; shared retries and timeouts in `http.ts` |

concept-mapping depends on llm-gateway only through `LlmPort`. It consumes
`TranscriptLine` (`{start, text}`), its own type, so it never sees a YouTube
type. The UI maps `Transcript` to lines with `transcriptToLines`.

## Key decisions

| Decision | Why |
|---|---|
| Read the player's caption request instead of fetching timedtext | Since 2025, timedtext needs a PO token and returns an empty 200 without one; the player's own request carries a valid token |
| Fallback chain: intercept → DOM panel → paste | YouTube breaks each method from time to time; paste keeps the product usable |
| Two LLM calls (extract, then relate) | Relating needs the merged concept list. Extraction can be chunked for long lectures or a small local model |
| Model copies `[seconds]` back as `t` | More reliable than asking it to convert mm:ss |
| The concept graph is a DAG, shown as a tree | Each concept gets one "strongest" part-of parent; cycles are cut at the most important node; `requires` is shown as annotations |
| Map cache key = video + lang + `PROMPT_VERSION` + model | Reproducible: the same inputs give the same map. Changing a prompt re-runs only the LLM step; transcripts are cached separately |
| `gemini-flash-latest` default | A rolling alias, so a model retirement doesn't silently break installs |
| markmap-view without markmap-lib | We build markmap's node tree directly. That avoids Markdown parsing, and markmap-lib's CDN plugin loaders that would trip store review |
| All LLM text is HTML-escaped before markmap | markmap renders node content as HTML |

## Data model (`chrome.storage.local`)

| Key | Value |
|---|---|
| `sh:settings` | `{apiKey, model, outputLanguage}` (local, not synced) |
| `sh:transcript:{videoId}` | the most recent `Transcript` |
| `sh:map:{videoId}:{lang}:{promptVersion}:{model}` | `ConceptMap` |
| `sh:mapidx:{videoId}` | index of which maps exist, used by `findLatest` |

When a build fails, the panel keeps the map that was on screen. If there was
none, it shows the cached map for the current version (`findLatest`), then
any older map of the video (`findLatestAny`, marked "older version"). Old
maps are kept in the cache until "Clear cache" removes them.

"Clear cache" removes the `sh:transcript:`, `sh:map:` and `sh:mapidx:` keys,
never `sh:settings`. There is no automatic eviction yet. Storage usage is
shown in Settings; `unlimitedStorage` gets added only if real usage
approaches the 10 MB quota.

## Risks

- **YouTube UI or caption changes** break capture. Mitigations: the provider
  chain, centralized selectors, the paste fallback, and `make smoke-live` for
  the LLM side.
- **Gemini free-tier overload or limits** cause 503/429 errors. Mitigations:
  backoff with server hints, Cancel, clear messages, and a configurable model.
- **Auto-generated captions** mishear terms. The prompt tells the model to
  correct them from context.
