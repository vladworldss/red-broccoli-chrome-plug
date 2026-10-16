import { useCallback, useEffect, useMemo, useState } from 'react'

import { DEFAULT_GEMINI_MODEL, GeminiApiAdapter, LlmError, describeLlmError } from '../../contexts/llm-gateway'
import { cacheUsage, clearCache, type CacheUsage } from '../../shared/storage/cacheAdmin'
import { chromeLocalStorage } from '../../shared/storage/kv'
import { DEFAULT_SETTINGS, readSettings, writeSettings, type Settings } from '../../shared/storage/settings'
import { extensionVersion } from '../extensionVersion'

const LANGUAGES = ['auto', 'English', 'Russian', 'Ukrainian', 'German', 'French', 'Spanish', 'Portuguese', 'Chinese']

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; text: string } | { kind: 'err'; text: string }

export function Options() {
  const storage = useMemo(() => chromeLocalStorage(), [])
  const version = useMemo(extensionVersion, [])
  const [draft, setDraft] = useState<Settings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [saveStatus, setSaveStatus] = useState<Status>({ kind: 'idle' })
  const [testStatus, setTestStatus] = useState<Status>({ kind: 'idle' })
  const [usage, setUsage] = useState<CacheUsage | null>(null)

  const refreshUsage = useCallback(async () => {
    if (storage) setUsage(await cacheUsage(storage).catch(() => null))
  }, [storage])

  useEffect(() => {
    void readSettings(storage).then((s) => {
      setDraft(s)
      setLoaded(true)
    })
    void refreshUsage()
  }, [storage, refreshUsage])

  const save = async () => {
    setSaveStatus({ kind: 'busy' })
    try {
      const next = await writeSettings(storage, draft)
      setDraft(next)
      setSaveStatus({ kind: 'ok', text: 'Saved' })
    } catch (err) {
      setSaveStatus({ kind: 'err', text: err instanceof Error ? err.message : 'Could not save' })
    }
  }

  const test = async () => {
    setTestStatus({ kind: 'busy' })
    try {
      await new GeminiApiAdapter({ apiKey: draft.apiKey, model: draft.model }).testKey()
      setTestStatus({ kind: 'ok', text: `Key works with ${draft.model || DEFAULT_GEMINI_MODEL}` })
    } catch (err) {
      setTestStatus({
        kind: 'err',
        text: err instanceof LlmError ? describeLlmError(err) : String(err),
      })
    }
  }

  const clear = async () => {
    if (!storage) return
    await clearCache(storage).catch(() => 0)
    await refreshUsage()
  }

  return (
    <main className="sh-options">
      <h1>StudHelper settings</h1>
      <p className="sh-muted">Version {version}</p>

      <section>
        <h2>Gemini API key</h2>
        <p className="sh-small">
          StudHelper uses Google Gemini to find the concepts in a lecture. Get a free key at{' '}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            aistudio.google.com/apikey
          </a>{' '}
          and paste it here.
        </p>

        <div className="sh-field">
          <label htmlFor="key">API key</label>
          <div className="sh-row" style={{ flexWrap: 'nowrap' }}>
            <input
              id="key"
              className="sh-input"
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={draft.apiKey}
              disabled={!loaded}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            />
            <button className="sh-btn" onClick={() => setShowKey((v) => !v)}>
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <span className="sh-small sh-muted">
            Stored unencrypted in this Chrome profile only (not synced). Only this extension's pages read it — it is
            never given to YouTube or any web page.
          </span>
        </div>

        <div className="sh-field">
          <label htmlFor="model">Model</label>
          <input
            id="model"
            className="sh-input"
            placeholder={DEFAULT_GEMINI_MODEL}
            spellCheck={false}
            value={draft.model}
            disabled={!loaded}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          />
          <span className="sh-small sh-muted">
            Leave empty for the latest Flash model. Any model id from AI Studio works, e.g. a specific Flash or Pro
            version.
          </span>
        </div>

        <div className="sh-field">
          <label htmlFor="lang">Map language</label>
          <select
            id="lang"
            className="sh-input"
            value={LANGUAGES.includes(draft.outputLanguage) ? draft.outputLanguage : 'auto'}
            disabled={!loaded}
            onChange={(e) => setDraft({ ...draft, outputLanguage: e.target.value })}
          >
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l === 'auto' ? 'Same as the lecture' : l}
              </option>
            ))}
          </select>
        </div>

        <div className="sh-row">
          <button className="sh-btn sh-btn-primary" disabled={!loaded || saveStatus.kind === 'busy'} onClick={() => void save()}>
            Save
          </button>
          <button className="sh-btn" disabled={!draft.apiKey || testStatus.kind === 'busy'} onClick={() => void test()}>
            {testStatus.kind === 'busy' ? 'Testing…' : 'Test key'}
          </button>
          <StatusText status={saveStatus} />
          <StatusText status={testStatus} />
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>Cache</h2>
        <p className="sh-small">
          Transcripts and maps are kept in this browser so reopening a video is instant and costs no API calls.
        </p>
        <p className="sh-small sh-muted">
          {usage ? `${usage.videos} video(s), ${(usage.bytes / 1024).toFixed(0)} KB used` : '—'}
        </p>
        <button className="sh-btn" onClick={() => void clear()}>
          Clear cache
        </button>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>Where your data goes</h2>
        <ul className="sh-small">
          <li>When you press “Build map”, the video's title and transcript are sent to Google's Gemini API using your key.</li>
          <li>Nothing is sent anywhere else. StudHelper has no server and collects no analytics.</li>
          <li>On Gemini's free tier, Google may use submitted content to improve its products.</li>
        </ul>
      </section>
    </main>
  )
}

function StatusText({ status }: { status: Status }) {
  if (status.kind === 'ok') return <span className="sh-small sh-status-ok">{status.text}</span>
  if (status.kind === 'err') return <span className="sh-small sh-status-err">{status.text}</span>
  return null
}
