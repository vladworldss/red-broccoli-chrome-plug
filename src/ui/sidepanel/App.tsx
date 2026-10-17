import { useCallback, useEffect, useMemo, useState } from 'react'

import { isOutdatedMap, toMarkdown, toMermaid, toTree, type ConceptMap } from '../../contexts/concept-mapping'
import { watchUrl, type CaptureResult } from '../../contexts/video-capture'
import { extensionVersion } from '../extensionVersion'
import { ConceptTree } from './ConceptTree'
import { MindMap } from './MindMap'
import { TranscriptDownload } from './TranscriptDownload'
import { describeModels } from '../../contexts/llm-gateway'
import { hasAnyProvider } from '../llmChain'
import { usePanel, type BuildFailure, type VideoRef, type View } from './usePanel'

export function App() {
  const { view, settings, build, cancel, seek, getTranscript, refresh } = usePanel()
  const version = useMemo(extensionVersion, [])
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 2200)
    return () => clearTimeout(id)
  }, [toast])

  const onSeek = useCallback(
    async (t: number) => {
      const ok = await seek(t)
      if (!ok) setToast('Could not reach the video tab — is it still open?')
    },
    [seek],
  )

  const hasKey = settings ? hasAnyProvider(settings) : false

  return (
    <div className="sh-app">
      <header className="sh-header">
        <h1>RedBroccoli</h1>
        <span className="sh-version">v{version}</span>
        <button className="sh-btn" onClick={() => chrome.runtime.openOptionsPage()} title="Settings">
          ⚙
        </button>
      </header>

      <main className="sh-body">
        <Body
          view={view}
          hasKey={hasKey}
          onBuild={(v, opts) => void build(v, opts)}
          onCancel={cancel}
          onRefresh={() => void refresh()}
          onSeek={onSeek}
          onToast={setToast}
          getTranscript={getTranscript}
        />
      </main>

      {toast && (
        <div className="sh-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}

type BodyProps = {
  view: View
  /** At least one AI provider has a key. */
  hasKey: boolean
  onBuild: (video: VideoRef, opts?: { force?: boolean; pasted?: string }) => void
  onCancel: () => void
  onRefresh: () => void
  onSeek: (t: number) => void
  onToast: (msg: string) => void
  getTranscript: (video: VideoRef) => Promise<CaptureResult>
}

function Body({ view, hasKey, onBuild, onCancel, onRefresh, onSeek, onToast, getTranscript }: BodyProps) {
  switch (view.kind) {
    case 'loading':
      return <Progress text="Looking for a video…" />

    case 'no-video':
      return (
        <div className="sh-card">
          <p style={{ marginTop: 0 }}>
            <strong>Open a lecture video on YouTube.</strong>
          </p>
          <p className="sh-muted sh-small">
            If a video is already open in this tab, reload the page once — tabs opened before the extension was
            installed don't have it yet.
          </p>
          <button className="sh-btn" onClick={onRefresh}>
            Check again
          </button>
        </div>
      )

    case 'ready':
      return (
        <>
          <VideoHeader video={view.video} />
          {!hasKey && <KeyNotice />}
          <div className="sh-card">
            <p style={{ marginTop: 0 }}>
              Build a concept map of this lecture: the key terms, their definitions, what depends on what, and where
              each one is explained.
            </p>
            <button className="sh-btn sh-btn-primary" disabled={!hasKey} onClick={() => onBuild(view.video)}>
              Build map
            </button>
            <p className="sh-muted sh-small" style={{ marginBottom: 0 }}>
              The transcript is sent to the AI provider you set up in Settings, with your own key.
            </p>
          </div>
          <TranscriptDownload video={view.video} getTranscript={getTranscript} onToast={onToast} />
        </>
      )

    case 'capturing':
      return (
        <>
          <VideoHeader video={view.video} />
          <Progress text="Reading the transcript…" onCancel={onCancel} />
          <p className="sh-muted sh-small">Captions may switch on for a moment while they load.</p>
        </>
      )

    case 'no-captions':
      return (
        <>
          <VideoHeader video={view.video} />
          <PasteFallback
            intro="Couldn't read captions for this video automatically."
            onSubmit={(text) => onBuild(view.video, { pasted: text })}
            onRetry={() => onBuild(view.video)}
            details={view.attempts.map((a) => `${a.provider}: ${a.outcome}${a.message ? ` (${a.message})` : ''}`)}
          />
        </>
      )

    case 'building': {
      const p = view.progress
      const text =
        p === null
          ? 'Sending the transcript…'
          : p.step === 'extract'
            ? p.total > 1
              ? `Finding concepts (part ${p.current} of ${p.total})…`
              : 'Finding concepts…'
            : 'Linking concepts…'
      return (
        <>
          <VideoHeader video={view.video} />
          <Progress text={text} onCancel={onCancel} />
          {view.note && <p className="sh-small sh-muted">{view.note}</p>}
          {view.wait && <PacingNote provider={view.wait.provider} until={view.wait.until} />}
          {/* The transcript is already captured (and cached) by now, so this is
              instant and doesn't toggle captions while Gemini works. */}
          <TranscriptDownload video={view.video} getTranscript={getTranscript} onToast={onToast} />
        </>
      )
    }

    case 'map':
      return (
        <MapView
          video={view.video}
          map={view.map}
          fromCache={view.fromCache}
          outdated={isOutdatedMap(view.map)}
          {...(view.error ? { error: view.error } : {})}
          onRebuild={() => onBuild(view.video, { force: true })}
          onSeek={onSeek}
          onToast={onToast}
          getTranscript={getTranscript}
        />
      )

    case 'error':
      return (
        <>
          <VideoHeader video={view.video} />
          <div className="sh-card sh-error" role="alert">
            <strong>Something went wrong</strong>
            <p style={{ whiteSpace: 'pre-line' }}>{view.message}</p>
            <div className="sh-row">
              {view.action === 'settings' ? (
                <button className="sh-btn sh-btn-primary" onClick={() => chrome.runtime.openOptionsPage()}>
                  Open Settings
                </button>
              ) : (
                <button className="sh-btn" onClick={() => onBuild(view.video)}>
                  Try again
                </button>
              )}
              {view.help && <HelpLink help={view.help} />}
            </div>
          </div>
          {/* Downloads never depend on Gemini or the API key, so a failed build
              (rate limit, overload, bad key) must not take them away. */}
          <TranscriptDownload video={view.video} getTranscript={getTranscript} onToast={onToast} />
        </>
      )
  }
}

function HelpLink({ help }: { help: NonNullable<BuildFailure['help']> }) {
  return (
    <a className="sh-small" href={help.url} target="_blank" rel="noreferrer">
      {help.label} ↗
    </a>
  )
}

function VideoHeader({ video }: { video: VideoRef }) {
  return <p className="sh-video-title">{video.title || video.videoId}</p>
}

function KeyNotice() {
  return (
    <div className="sh-card">
      <strong>One-time setup:</strong> add a free API key (Gemini, Mistral, Groq…).{' '}
      <button className="sh-btn-link" onClick={() => chrome.runtime.openOptionsPage()}>
        Open Settings
      </button>
    </div>
  )
}

/**
 * Free tiers with a small per-minute budget (Groq: 8k tokens) take a long
 * lecture in parts, about a minute apart. Without a countdown that pause
 * looks exactly like a hang.
 */
function PacingNote({ provider, until }: { provider: string; until: number }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [until])
  const left = Math.ceil((until - now) / 1000)
  if (left <= 0) return null
  return (
    <p className="sh-small sh-muted">
      {provider}'s free tier allows only so much text per minute, so long lectures go in parts. Continuing in {left} s…
    </p>
  )
}

function Progress({ text, onCancel }: { text: string; onCancel?: () => void }) {
  return (
    <div className="sh-progress" role="status">
      <span className="sh-spinner" aria-hidden />
      <span style={{ flex: 1 }}>{text}</span>
      {onCancel && (
        <button className="sh-btn" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  )
}

function PasteFallback({
  intro,
  details,
  onSubmit,
  onRetry,
}: {
  intro: string
  details: string[]
  onSubmit: (text: string) => void
  onRetry: () => void
}) {
  const [text, setText] = useState('')
  return (
    <div className="sh-card">
      <p style={{ marginTop: 0 }}>
        <strong>{intro}</strong>
      </p>
      <ol className="sh-small" style={{ paddingLeft: 18 }}>
        <li>Make sure the video has subtitles (the CC button), then try again, or</li>
        <li>
          open <em>…more → Show transcript</em> under the video, select all of it, copy, and paste below.
        </li>
      </ol>
      <textarea
        className="sh-input"
        placeholder={'0:00\nToday we talk about limits…\n0:12\n…'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="sh-row" style={{ marginTop: 8 }}>
        <button className="sh-btn sh-btn-primary" disabled={!text.trim()} onClick={() => onSubmit(text)}>
          Build from pasted text
        </button>
        <button className="sh-btn" onClick={onRetry}>
          Try again
        </button>
      </div>
      {details.length > 0 && (
        <details className="sh-small sh-muted" style={{ marginTop: 8 }}>
          <summary>Details</summary>
          <ul>
            {details.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function MapView({
  video,
  map,
  fromCache,
  outdated,
  error,
  onRebuild,
  onSeek,
  onToast,
  getTranscript,
}: {
  video: VideoRef
  map: ConceptMap
  fromCache: boolean
  outdated: boolean
  /** A build failed; this map is the previous one, kept on screen. */
  error?: BuildFailure
  onRebuild: () => void
  onSeek: (t: number) => void
  onToast: (msg: string) => void
  getTranscript: (video: VideoRef) => Promise<CaptureResult>
}) {
  const [tab, setTab] = useState<'tree' | 'mindmap'>('tree')
  const tree = useMemo(() => toTree(map), [map])

  const copy = async (kind: 'md' | 'mermaid') => {
    const text =
      kind === 'md' ? toMarkdown(map, tree, { linkFor: (t) => watchUrl(map.videoId, t) }) : toMermaid(map)
    try {
      await navigator.clipboard.writeText(text)
      onToast(kind === 'md' ? 'Markdown copied' : 'Mermaid copied')
    } catch {
      onToast('Copy failed — click inside the panel and try again')
    }
  }

  return (
    <>
      {error && (
        <div className="sh-card sh-error" role="alert">
          <strong>Couldn't build a new map</strong>
          <p style={{ whiteSpace: 'pre-line' }}>{error.message}</p>
          <p className="sh-small sh-muted">Showing the {outdated ? 'older' : 'previous'} saved map below.</p>
          <div className="sh-row">
            {error.action === 'settings' ? (
              <button className="sh-btn sh-btn-primary" onClick={() => chrome.runtime.openOptionsPage()}>
                Open Settings
              </button>
            ) : (
              <button className="sh-btn" onClick={onRebuild}>
                Try again
              </button>
            )}
            {error.help && <HelpLink help={error.help} />}
          </div>
        </div>
      )}

      <div>
        <p className="sh-video-title">{tree.topic || video.title}</p>
        <div className="sh-row sh-small sh-muted">
          <span>{map.concepts.length} concepts</span>
          {fromCache && <span className="sh-badge">cached</span>}
          <span className="sh-badge" title={`Prompt ${map.promptVersion}`}>
            {describeModels(map.model)}
          </span>
          {outdated && (
            <span className="sh-badge" title={`Built with prompt ${map.promptVersion}. Rebuild for the current version.`}>
              older version
            </span>
          )}
          {!map.timed && <span className="sh-badge">no timestamps</span>}
        </div>
      </div>

      <div className="sh-row">
        <button className="sh-btn" onClick={() => void copy('md')}>
          Copy Markdown
        </button>
        <button className="sh-btn" onClick={() => void copy('mermaid')}>
          Copy Mermaid
        </button>
        <button className="sh-btn" onClick={onRebuild} title="Ask Gemini again, ignoring the cache">
          Rebuild
        </button>
      </div>
      <TranscriptDownload video={video} getTranscript={getTranscript} onToast={onToast} />

      <div className="sh-tabs" role="tablist">
        <button className="sh-tab" role="tab" aria-selected={tab === 'tree'} onClick={() => setTab('tree')}>
          Tree
        </button>
        <button className="sh-tab" role="tab" aria-selected={tab === 'mindmap'} onClick={() => setTab('mindmap')}>
          Mind map
        </button>
      </div>

      {tab === 'tree' ? <ConceptTree tree={tree} onSeek={onSeek} /> : <MindMap tree={tree} onSeek={onSeek} />}
    </>
  )
}
