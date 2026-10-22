import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  LlmError,
  PROVIDERS,
  createAdapter,
  describeLlmError,
  isProviderId,
  type ProviderId,
} from '../../contexts/llm-gateway'
import { cacheUsage, clearCache, type CacheUsage } from '../../shared/storage/cacheAdmin'
import { chromeLocalStorage } from '../../shared/storage/kv'
import { DEFAULT_SETTINGS, readSettings, writeSettings, type Settings } from '../../shared/storage/settings'
import { extensionVersion } from '../extensionVersion'
import { LANGUAGES } from '../languages'
import { hasHostAccess, keyFor } from '../llmChain'


type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; text: string } | { kind: 'err'; text: string }

/** Settings ids are plain strings; the presets are typed. They are kept equal by a unit test. */
const ids = (s: Settings): ProviderId[] => s.order.filter(isProviderId)

export function Options() {
  const storage = useMemo(() => chromeLocalStorage(), [])
  const version = useMemo(extensionVersion, [])
  const [draft, setDraft] = useState<Settings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [access, setAccess] = useState<Partial<Record<ProviderId, boolean>>>({})
  const [saveStatus, setSaveStatus] = useState<Status>({ kind: 'idle' })
  const [testStatus, setTestStatus] = useState<Partial<Record<ProviderId, Status>>>({})
  const [usage, setUsage] = useState<CacheUsage | null>(null)

  const refreshUsage = useCallback(async () => {
    if (storage) setUsage(await cacheUsage(storage).catch(() => null))
  }, [storage])

  const refreshAccess = useCallback(async () => {
    const next: Partial<Record<ProviderId, boolean>> = {}
    for (const id of Object.keys(PROVIDERS) as ProviderId[]) next[id] = await hasHostAccess(id)
    setAccess(next)
  }, [])

  useEffect(() => {
    void readSettings(storage).then((s) => {
      setDraft(s)
      setLoaded(true)
    })
    void refreshUsage()
    void refreshAccess()
  }, [storage, refreshUsage, refreshAccess])

  const patchProvider = (id: ProviderId, patch: Partial<Settings['providers'][ProviderId]>) => {
    setSaveStatus({ kind: 'idle' })
    setDraft((d) => {
      const prev = d.providers[id]
      const next = { ...prev, ...patch }
      // Typing a key into a provider turns it on — the obvious intent.
      if (patch.apiKey !== undefined && !prev.apiKey && patch.apiKey.trim()) next.enabled = true
      return { ...d, providers: { ...d.providers, [id]: next } }
    })
  }

  const move = (id: ProviderId, delta: -1 | 1) => {
    setSaveStatus({ kind: 'idle' })
    setDraft((d) => {
      const order = [...d.order]
      const i = order.indexOf(id)
      const j = i + delta
      if (i < 0 || j < 0 || j >= order.length) return d
      ;[order[i], order[j]] = [order[j]!, order[i]!]
      return { ...d, order }
    })
  }

  /**
   * Save also asks Chrome for access to every enabled provider that doesn't
   * have it yet — in ONE prompt, and inside this click, as Chrome requires.
   */
  const save = async () => {
    setSaveStatus({ kind: 'busy' })
    const missing = ids(draft).filter(
      (id) => PROVIDERS[id].optionalHost && draft.providers[id].enabled && !access[id],
    )
    let denied: string[] = []
    if (missing.length > 0) {
      try {
        const granted = await chrome.permissions.request({ origins: missing.map((id) => PROVIDERS[id].host) })
        if (!granted) denied = missing.map((id) => PROVIDERS[id].label)
      } catch {
        denied = missing.map((id) => PROVIDERS[id].label)
      }
    }
    try {
      const next = await writeSettings(storage, {
        providers: draft.providers,
        order: draft.order,
        outputLanguage: draft.outputLanguage,
      })
      setDraft(next)
      await refreshAccess()
      setSaveStatus(
        denied.length > 0
          ? { kind: 'err', text: `Saved, but access was not allowed for ${denied.join(', ')} — they will be skipped.` }
          : { kind: 'ok', text: 'Saved' },
      )
    } catch (err) {
      setSaveStatus({ kind: 'err', text: err instanceof Error ? err.message : 'Could not save' })
    }
  }

  const test = async (id: ProviderId) => {
    setTestStatus((t) => ({ ...t, [id]: { kind: 'busy' } }))
    try {
      if (PROVIDERS[id].optionalHost && !access[id]) {
        const granted = await chrome.permissions.request({ origins: [PROVIDERS[id].host] })
        await refreshAccess()
        if (!granted) throw new Error('Access to this provider was not allowed.')
      }
      const adapter = createAdapter(id, { apiKey: keyFor(draft, id), model: draft.providers[id].model })
      await adapter.testKey()
      setTestStatus((t) => ({ ...t, [id]: { kind: 'ok', text: `Works with ${adapter.model}` } }))
    } catch (err) {
      setTestStatus((t) => ({
        ...t,
        [id]: { kind: 'err', text: err instanceof LlmError ? describeLlmError(err) : String(err instanceof Error ? err.message : err) },
      }))
    }
  }

  const clear = async () => {
    if (!storage) return
    await clearCache(storage).catch(() => 0)
    await refreshUsage()
  }

  const order = ids(draft)

  return (
    <main className="sh-options">
      <h1>RedBroccoli settings</h1>
      <p className="sh-muted">Version {version}</p>

      <section>
        <h2>AI providers</h2>
        <p className="sh-small">
          RedBroccoli uses an AI model to find the concepts in a lecture. Add a free key for one or more providers. When
          one runs out of quota or fails, the next one in this list builds the map automatically.
        </p>

        <ol className="sh-providers">
          {order.map((id, i) => (
            <ProviderRow
              key={id}
              id={id}
              position={i}
              last={i === order.length - 1}
              settings={draft}
              disabled={!loaded}
              access={access[id] ?? !PROVIDERS[id].optionalHost}
              status={testStatus[id] ?? { kind: 'idle' }}
              onPatch={(patch) => patchProvider(id, patch)}
              onMove={(delta) => move(id, delta)}
              onTest={() => void test(id)}
            />
          ))}
        </ol>

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
          <button
            className="sh-btn sh-btn-primary"
            disabled={!loaded || saveStatus.kind === 'busy'}
            onClick={() => void save()}
          >
            Save
          </button>
          <StatusText status={saveStatus} />
        </div>
        <p className="sh-small sh-muted">
          Keys are stored unencrypted in this Chrome profile only (not synced). Only this extension's pages read them —
          they are never given to YouTube or any web page.
        </p>
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
          <li>
            When you press “Build map”, the video's title and transcript are sent to the first provider in your list that
            is enabled and has a key — and, only if it fails, to the next ones, in order.
          </li>
          <li>Nothing is sent anywhere else. RedBroccoli has no server and collects no analytics.</li>
          <li>
            Free tiers may let the provider use submitted content to improve its products (Google and Mistral say so
            for their free plans). Check each provider's terms.
          </li>
        </ul>
      </section>
    </main>
  )
}

type RowProps = {
  id: ProviderId
  position: number
  last: boolean
  settings: Settings
  disabled: boolean
  access: boolean
  status: Status
  onPatch: (patch: Partial<Settings['providers'][ProviderId]>) => void
  onMove: (delta: -1 | 1) => void
  onTest: () => void
}

function ProviderRow({ id, position, last, settings, disabled, access, status, onPatch, onMove, onTest }: RowProps) {
  const preset = PROVIDERS[id]
  const cfg = settings.providers[id]
  const sharesKey = preset.keySource !== id
  const key = keyFor(settings, id)
  const [showKey, setShowKey] = useState(false)

  return (
    <li className="sh-provider sh-card">
      <div className="sh-row">
        <label className="sh-row" style={{ gap: 6, flex: 1 }}>
          <input
            type="checkbox"
            checked={cfg.enabled}
            disabled={disabled}
            onChange={(e) => onPatch({ enabled: e.target.checked })}
          />
          <strong>{preset.label}</strong>
          {preset.paid && <span className="sh-badge">paid</span>}
          {preset.optionalHost && cfg.enabled && !access && <span className="sh-badge">access on Save</span>}
        </label>
        <button className="sh-btn" disabled={disabled || position === 0} onClick={() => onMove(-1)} title="Earlier in the chain">
          ↑
        </button>
        <button className="sh-btn" disabled={disabled || last} onClick={() => onMove(1)} title="Later in the chain">
          ↓
        </button>
      </div>
      <p className="sh-small sh-muted" style={{ margin: '4px 0 8px' }}>
        {preset.note}
      </p>

      {sharesKey ? (
        <p className="sh-small">Uses your {PROVIDERS[preset.keySource].label} key{key ? '' : ' (not set yet)'}.</p>
      ) : (
        <div className="sh-field">
          <div className="sh-row" style={{ flexWrap: 'nowrap' }}>
            <input
              className="sh-input"
              type={showKey ? 'text' : 'password'}
              placeholder="API key"
              autoComplete="off"
              spellCheck={false}
              value={cfg.apiKey}
              disabled={disabled}
              onChange={(e) => onPatch({ apiKey: e.target.value })}
              aria-label={`${preset.label} API key`}
            />
            <button className="sh-btn" onClick={() => setShowKey((v) => !v)}>
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <a className="sh-small" href={preset.keyUrl} target="_blank" rel="noreferrer">
            Get a {preset.label} key ↗
          </a>
        </div>
      )}

      <div className="sh-row" style={{ flexWrap: 'nowrap' }}>
        <input
          className="sh-input"
          placeholder={preset.defaultModel}
          spellCheck={false}
          value={cfg.model}
          disabled={disabled}
          onChange={(e) => onPatch({ model: e.target.value })}
          aria-label={`${preset.label} model`}
        />
        <button className="sh-btn" disabled={disabled || !key || status.kind === 'busy'} onClick={onTest}>
          {status.kind === 'busy' ? 'Testing…' : 'Test'}
        </button>
      </div>
      <StatusText status={status} />
    </li>
  )
}

function StatusText({ status }: { status: Status }) {
  if (status.kind === 'ok') return <span className="sh-small sh-status-ok">{status.text}</span>
  if (status.kind === 'err') return <span className="sh-small sh-status-err">{status.text}</span>
  return null
}
