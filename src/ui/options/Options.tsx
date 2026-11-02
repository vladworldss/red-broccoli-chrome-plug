import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
import { ChevronIcon } from '../icons'
import { LANGUAGES } from '../languages'
import { hasAnyProvider, hasHostAccess, keyFor, readiness, requestHostAccess, type Readiness } from '../llmChain'
import { createAutosaver, type SaveState } from './autosave'

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; text: string } | { kind: 'err'; text: string }

/** What the last change touched, so its save state shows where the user is looking. */
type SaveScope = ProviderId | 'language'

/** Long enough to cover a burst of typing, short enough that closing the tab rarely beats it. */
const TYPING_DEBOUNCE_MS = 400
/** "Saved" is a confirmation, not a state to keep on screen. */
const SAVED_VISIBLE_MS = 2000

/** Settings ids are plain strings; the presets are typed. They are kept equal by a unit test. */
const ids = (s: Settings): ProviderId[] => s.order.filter(isProviderId)

export function Options() {
  const storage = useMemo(() => chromeLocalStorage(), [])
  const version = useMemo(extensionVersion, [])
  const [draft, setDraft] = useState<Settings>(DEFAULT_SETTINGS)
  // Handlers read the latest draft from here; setState callbacks must stay pure.
  const draftRef = useRef<Settings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [access, setAccess] = useState<Partial<Record<ProviderId, boolean>>>({})
  const [open, setOpen] = useState<ReadonlySet<ProviderId>>(new Set())
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveScope, setSaveScope] = useState<SaveScope | null>(null)
  const [testStatus, setTestStatus] = useState<Partial<Record<ProviderId, Status>>>({})
  const [usage, setUsage] = useState<CacheUsage | null>(null)

  const saver = useMemo(
    () =>
      createAutosaver<Settings>(
        (s) => writeSettings(storage, { providers: s.providers, order: s.order, outputLanguage: s.outputLanguage }),
        { delayMs: TYPING_DEBOUNCE_MS, onState: setSaveState },
      ),
    [storage],
  )

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
      draftRef.current = s
      setDraft(s)
      setLoaded(true)
      // First visit: open the first enabled provider so its key field is right there.
      const first = hasAnyProvider(s) ? undefined : ids(s).find((id) => s.providers[id].enabled)
      if (first) setOpen(new Set([first]))
    })
    void refreshUsage()
    void refreshAccess()
  }, [storage, refreshUsage, refreshAccess])

  // A debounced change must not be lost when the tab is closed or switched away from.
  useEffect(() => {
    const flush = () => void saver.flush()
    const onVisibility = () => document.visibilityState === 'hidden' && flush()
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [saver])

  useEffect(() => {
    if (saveState !== 'saved') return
    const t = setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), SAVED_VISIBLE_MS)
    return () => clearTimeout(t)
  }, [saveState])

  const commit = (next: Settings, scope: SaveScope, when: 'typing' | 'now') => {
    draftRef.current = next
    setDraft(next)
    setSaveScope(scope)
    if (when === 'typing') saver.schedule(next)
    else void saver.now(next)
  }

  const toggleOpen = (id: ProviderId, force?: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (force ?? !next.has(id)) next.add(id)
      else next.delete(id)
      return next
    })

  const patchProvider = (id: ProviderId, patch: Partial<Settings['providers'][ProviderId]>) => {
    const d = draftRef.current
    const prev = d.providers[id]
    const cfg = { ...prev, ...patch }
    // Typing a key into a provider turns it on — the obvious intent.
    if (patch.apiKey !== undefined && !prev.apiKey && patch.apiKey.trim()) cfg.enabled = true
    if (patch.enabled) toggleOpen(id, true)
    // "Works with …" said nothing about the key or model now in the field.
    if (patch.apiKey !== undefined || patch.model !== undefined) setTestStatus((t) => ({ ...t, [id]: { kind: 'idle' } }))
    commit({ ...d, providers: { ...d.providers, [id]: cfg } }, id, patch.enabled === undefined ? 'typing' : 'now')
  }

  const move = (id: ProviderId, delta: -1 | 1) => {
    const d = draftRef.current
    const order = [...d.order]
    const i = order.indexOf(id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j]!, order[i]!]
    commit({ ...d, order }, id, 'now')
  }

  /**
   * Asks Chrome for host access first: it must happen inside this click, and an
   * `await` before it could spend the user gesture. The key is already saved.
   */
  const test = async (id: ProviderId) => {
    setTestStatus((t) => ({ ...t, [id]: { kind: 'busy' } }))
    try {
      if (PROVIDERS[id].optionalHost && !access[id]) {
        const granted = await requestHostAccess(id)
        await refreshAccess()
        if (!granted) throw new Error('Access was not allowed, so RedBroccoli will skip this provider.')
      }
      void saver.flush()
      const d = draftRef.current
      const adapter = createAdapter(id, { apiKey: keyFor(d, id).trim(), model: d.providers[id].model.trim() })
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
  const saveFor = (scope: SaveScope) => (saveScope === scope ? saveState : 'idle')

  return (
    <main className="sh-options">
      <header className="sh-options-head">
        <h1>RedBroccoli settings</h1>
        <p className="sh-small sh-muted">Changes save automatically.</p>
      </header>

      <section className="sh-section">
        <h2>AI providers</h2>
        <p className="sh-hint">
          Add a key for at least one provider. If one fails or runs out of quota, the next one in the list takes over.
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
              open={open.has(id)}
              readiness={readiness(draft, id, access[id] ?? !PROVIDERS[id].optionalHost)}
              saveState={saveFor(id)}
              status={testStatus[id] ?? { kind: 'idle' }}
              onToggle={() => toggleOpen(id)}
              onOpenKeySource={() => toggleOpen(PROVIDERS[id].keySource, true)}
              onPatch={(patch) => patchProvider(id, patch)}
              onFieldBlur={() => void saver.flush()}
              onMove={(delta) => move(id, delta)}
              onTest={() => void test(id)}
              onRetrySave={() => void saver.flush()}
            />
          ))}
        </ol>
        <p className="sh-hint">
          Keys stay in this Chrome profile, unencrypted and not synced. Only RedBroccoli's own pages read them, never
          YouTube or any web page.
        </p>
      </section>

      <section className="sh-section">
        <div className="sh-field">
          <div className="sh-field-head">
            <label htmlFor="lang">Map language</label>
            <SaveIndicator state={saveFor('language')} onRetry={() => void saver.flush()} />
          </div>
          <select
            id="lang"
            className="sh-input"
            value={LANGUAGES.includes(draft.outputLanguage) ? draft.outputLanguage : 'auto'}
            disabled={!loaded}
            onChange={(e) => commit({ ...draftRef.current, outputLanguage: e.target.value }, 'language', 'now')}
          >
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l === 'auto' ? 'Same as the lecture' : l}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="sh-section">
        <h2>Cache</h2>
        <p className="sh-hint">
          Transcripts and maps stay in this browser, so reopening a video is instant and uses no quota.
        </p>
        <div className="sh-row">
          <button className="sh-btn" onClick={() => void clear()}>
            Clear cache
          </button>
          <span className="sh-small sh-muted">
            {usage ? `${usage.videos} video(s), ${(usage.bytes / 1024).toFixed(0)} KB` : '—'}
          </span>
        </div>
      </section>

      <section className="sh-section">
        <h2>Where your data goes</h2>
        <ul className="sh-hint sh-list">
          <li>
            When you press “Build map”, the video's title and transcript go to the first provider in your list that is
            on and has a key — and, only if it fails, to the next ones, in order.
          </li>
          <li>Nothing goes anywhere else. RedBroccoli has no server and collects no analytics.</li>
          <li>
            Free tiers may let the provider use what you send to improve its products (Google and Mistral say so for
            their free plans). Check each provider's terms.
          </li>
        </ul>
      </section>

      {/* The loaded build's version: the panel no longer shows it (Chrome's own
          side-panel bar already names the extension). */}
      <footer className="sh-options-footer sh-small sh-muted">RedBroccoli v{version}</footer>
    </main>
  )
}

type RowProps = {
  id: ProviderId
  position: number
  last: boolean
  settings: Settings
  disabled: boolean
  open: boolean
  readiness: Readiness
  saveState: SaveState
  status: Status
  onToggle: () => void
  onOpenKeySource: () => void
  onPatch: (patch: Partial<Settings['providers'][ProviderId]>) => void
  onFieldBlur: () => void
  onMove: (delta: -1 | 1) => void
  onTest: () => void
  onRetrySave: () => void
}

/**
 * Collapsed: checkbox, name, one status, reorder. Expanded: key, model, Test.
 * The checkbox sits outside the expand button: no nested interactive controls.
 */
function ProviderRow(props: RowProps) {
  const { id, position, last, settings, disabled, open, readiness, saveState, status } = props
  const preset = PROVIDERS[id]
  const cfg = settings.providers[id]
  const sharesKey = preset.keySource !== id
  const key = keyFor(settings, id).trim()
  const [showKey, setShowKey] = useState(false)
  const bodyId = `sh-provider-${id}`

  return (
    <li className={`sh-provider${open ? ' sh-provider-open' : ''}`}>
      <div className="sh-provider-head">
        <input
          type="checkbox"
          checked={cfg.enabled}
          disabled={disabled}
          onChange={(e) => props.onPatch({ enabled: e.target.checked })}
          aria-label={`Use ${preset.label}`}
        />
        <button
          type="button"
          className="sh-provider-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={props.onToggle}
        >
          <span className="sh-provider-name">{preset.label}</span>
          <span className="sh-chevron" aria-hidden="true">
            <ChevronIcon size={14} />
          </span>
        </button>
        <SaveIndicator state={saveState} onRetry={props.onRetrySave} />
        <ReadinessText readiness={readiness} keySource={sharesKey ? PROVIDERS[preset.keySource].label : null} />
        <div className="sh-reorder">
          <button
            type="button"
            className="sh-btn-ghost"
            disabled={disabled || position === 0}
            onClick={() => props.onMove(-1)}
            aria-label={`Move ${preset.label} up`}
            title="Try earlier"
          >
            ↑
          </button>
          <button
            type="button"
            className="sh-btn-ghost"
            disabled={disabled || last}
            onClick={() => props.onMove(1)}
            aria-label={`Move ${preset.label} down`}
            title="Try later"
          >
            ↓
          </button>
        </div>
      </div>

      {open && (
        <div className="sh-provider-body" id={bodyId}>
          <p className="sh-hint">{preset.note}</p>

          {sharesKey ? (
            <p className="sh-small">
              Uses your {PROVIDERS[preset.keySource].label} key.{' '}
              {!key && (
                <button type="button" className="sh-btn-link" onClick={props.onOpenKeySource}>
                  Add it under {PROVIDERS[preset.keySource].label}
                </button>
              )}
            </p>
          ) : (
            <div className="sh-field">
              <div className="sh-field-head">
                <label htmlFor={`${bodyId}-key`}>API key</label>
                <a className="sh-quiet-link" href={preset.keyUrl} target="_blank" rel="noreferrer">
                  Get a key ↗
                </a>
              </div>
              <div className="sh-input-group">
                <input
                  id={`${bodyId}-key`}
                  className="sh-input"
                  type={showKey ? 'text' : 'password'}
                  placeholder={`Paste your ${preset.label} key`}
                  autoComplete="off"
                  spellCheck={false}
                  value={cfg.apiKey}
                  disabled={disabled}
                  onChange={(e) => props.onPatch({ apiKey: e.target.value })}
                  onBlur={props.onFieldBlur}
                />
                <button
                  type="button"
                  className="sh-btn-ghost"
                  onClick={() => setShowKey((v) => !v)}
                  aria-pressed={showKey}
                >
                  {showKey ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
          )}

          <div className="sh-field">
            <div className="sh-field-head">
              <label htmlFor={`${bodyId}-model`}>Model</label>
              <span className="sh-small sh-muted">optional</span>
            </div>
            <input
              id={`${bodyId}-model`}
              className="sh-input"
              placeholder={preset.defaultModel}
              spellCheck={false}
              value={cfg.model}
              disabled={disabled}
              onChange={(e) => props.onPatch({ model: e.target.value })}
              onBlur={props.onFieldBlur}
            />
          </div>

          <div className="sh-row">
            <button
              type="button"
              className="sh-btn"
              disabled={disabled || !key || status.kind === 'busy'}
              onClick={props.onTest}
            >
              {status.kind === 'busy' ? 'Testing…' : readiness === 'no-access' ? 'Allow access & test' : 'Test'}
            </button>
            <StatusText status={status} />
          </div>
        </div>
      )}
    </li>
  )
}

const READINESS_TEXT: Record<Readiness, string> = {
  ready: 'Active',
  'no-key': 'Key missing',
  'no-access': 'Needs access',
  off: 'Off',
}

function ReadinessText({ readiness, keySource }: { readiness: Readiness; keySource: string | null }) {
  const text = readiness === 'no-key' && keySource ? `Needs ${keySource} key` : READINESS_TEXT[readiness]
  return <span className={`sh-readiness sh-readiness-${readiness}`}>{text}</span>
}

/** Quiet by design: nothing while idle, a short "Saved" after a write. */
function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state === 'idle') return null
  if (state === 'error')
    return (
      <span className="sh-save sh-status-err" role="alert">
        Not saved ·{' '}
        <button type="button" className="sh-btn-link" onClick={onRetry}>
          Retry
        </button>
      </span>
    )
  return (
    <span className="sh-save" role="status">
      {state === 'saving' ? 'Saving…' : 'Saved'}
    </span>
  )
}

function StatusText({ status }: { status: Status }) {
  if (status.kind === 'ok') return <span className="sh-small sh-status-ok">{status.text}</span>
  if (status.kind === 'err') return <span className="sh-small sh-status-err">{status.text}</span>
  return null
}
