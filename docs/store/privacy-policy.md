# RedBroccoli — Privacy Policy

_Last updated: 2026-10-17 · applies to version 0.1.0 and later_

RedBroccoli ("the extension") builds study concept maps from lecture videos you
watch on YouTube. This policy explains what data it handles.

## Summary

- RedBroccoli has **no server** and collects **no analytics or telemetry**.
- When **you** press "Build map", the video's **title and transcript** are sent
  to the **AI provider you set up** (Google Gemini by default; also Mistral,
  Groq, OpenRouter or DeepSeek if you enable them) using **your own API key**.
  Nothing is sent before you press it.
- Your API key, settings and saved maps stay **in your browser**.

## What data is handled, and where it goes

| Data | Where it goes | Why |
|---|---|---|
| Video title and transcript (captions) of the video in the active tab | The first AI provider in your list that is enabled and has a key, and the next ones only if it fails: Google Gemini/Gemma (`generativelanguage.googleapis.com`), Mistral (`api.mistral.ai`), Groq (`api.groq.com`), OpenRouter (`openrouter.ai`), DeepSeek (`api.deepseek.com`). Only when you press Build map or Rebuild | To find the key concepts |
| Your API keys | Stored in `chrome.storage.local` in your Chrome profile, unencrypted. Each key is sent only to its own provider, as an authentication header | So the extension can call the provider on your behalf |
| Settings (providers, their order, models, map language) | `chrome.storage.local` | Your preferences |
| Transcripts and finished concept maps | `chrome.storage.local` | So reopening a video is instant; you can clear them in Settings |
| Subtitle files you download (.srt / .txt) | Saved by your browser to your computer; nothing is sent anywhere | So you can keep the transcript |

Your settings and API key are **not** synced to other devices.

Each provider processes the data you send it under its own terms and privacy
policy. On free tiers, providers may use submitted content to improve their
products. Google states this for the free Gemini API
([Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms)), and
Mistral for its free plan. Check the terms of the providers you enable.

## What RedBroccoli does NOT do

- It does not read pages other than YouTube video pages.
- It does not collect browsing history, personal information, or account data.
- It does not sell or transfer data to third parties, and does not use data
  for advertising or creditworthiness.
- It does not download or redistribute videos or audio.

## Permissions

| Permission | Used for |
|---|---|
| Content scripts on `https://www.youtube.com/*` | Read the captions the YouTube player loads, open the transcript panel if needed, and move the video to a timestamp you click |
| `scripting` | Register the part of the content script that must run inside the YouTube page to see the player's caption request |
| `sidePanel` | Show the concept map next to the video |
| `storage` | Save your settings, API key and cached maps locally |
| Host access to `https://generativelanguage.googleapis.com/*` | Send the transcript to Google Gemini (or Gemma) when you press Build map |
| Optional host access to `api.mistral.ai`, `api.groq.com`, `openrouter.ai`, `api.deepseek.com` | Requested only when you enable that provider in Settings; used only to send the transcript to it |

## Your control

- **Settings → Clear cache** deletes all saved transcripts and maps.
- Removing the extension deletes all of its stored data.
- You can delete or rotate your API key at any time in Google AI Studio.

## Contact

Questions: open an issue in the project repository.
