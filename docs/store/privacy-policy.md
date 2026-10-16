# StudHelper — Privacy Policy

_Last updated: 2026-10-16 · applies to version 0.1.0 and later_

StudHelper ("the extension") builds study concept maps from lecture videos you
watch on YouTube. This policy explains what data it handles.

## Summary

- StudHelper has **no server** and collects **no analytics or telemetry**.
- When **you** press "Build map", the video's **title and transcript** are sent
  to **Google's Gemini API** using **your own API key**. Nothing is sent before
  you press it.
- Your API key, settings and saved maps stay **in your browser**.

## What data is handled, and where it goes

| Data | Where it goes | Why |
|---|---|---|
| Video title and transcript (captions) of the video in the active tab | Google Gemini API (`generativelanguage.googleapis.com`), only when you press Build map or Rebuild | To find the key concepts |
| Your Gemini API key | Stored in `chrome.storage.local` in your Chrome profile, unencrypted. Sent only to the Gemini API, as an authentication header | So the extension can call Gemini on your behalf |
| Settings (model name, map language) | `chrome.storage.local` | Your preferences |
| Transcripts and finished concept maps | `chrome.storage.local` | So reopening a video is instant; you can clear them in Settings |
| Subtitle files you download (.srt / .txt) | Saved by your browser to your computer; nothing is sent anywhere | So you can keep the transcript |

Your settings and API key are **not** synced to other devices.

Google processes the data you send to the Gemini API under Google's own terms
and privacy policy. On Gemini's free tier, Google may use submitted content to
improve its products. See
[Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms).

## What StudHelper does NOT do

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
| Host access to `https://generativelanguage.googleapis.com/*` | Send the transcript to Google Gemini when you press Build map |

## Your control

- **Settings → Clear cache** deletes all saved transcripts and maps.
- Removing the extension deletes all of its stored data.
- You can delete or rotate your API key at any time in Google AI Studio.

## Contact

Questions: open an issue in the project repository.
