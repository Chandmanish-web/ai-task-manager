import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { Notice, Panel, Working } from './ui.jsx'

const KINDS = [
  { value: 'page', label: 'Page', hint: 'Layout, type and copy do the work' },
  { value: 'scene3d', label: '3D scene', hint: 'Live three.js geometry and lighting' },
  { value: 'animation', label: 'Animation', hint: 'Timed GSAP sequence' },
]

const EXAMPLES = {
  page: 'A landing page for a small-batch coffee roaster in Kyoto — origin stories, tasting notes, a subscription pitch',
  scene3d:
    'A hero with a slowly rotating wireframe globe made of glowing points, arcs connecting cities, drifting on mouse move',
  animation:
    'A product launch page where the headline assembles letter by letter, then three feature cards deal in on scroll',
}

// Matches the backend's min_length on StudioRequest.prompt. Enforced here so a
// one-character prompt is a disabled button rather than a 422 from the API.
const MIN_PROMPT = 3

/**
 * AI Studio. Describe a page, get a complete single-file HTML document back,
 * preview it in a sandboxed iframe, then refine it in place or save it to disk.
 */
export default function StudioPanel({ aiEnabled, notify }) {
  const [kind, setKind] = useState('page')
  const [prompt, setPrompt] = useState('')
  const [palette, setPalette] = useState('')
  const [current, setCurrent] = useState(null)
  const [history, setHistory] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [warning, setWarning] = useState(null)
  const [refining, setRefining] = useState(false)
  const [showCode, setShowCode] = useState(false)

  const loadHistory = () =>
    api
      .listGenerations()
      .then((rows) => setHistory(rows || []))
      .catch(() => {})

  useEffect(() => {
    loadHistory()
  }, [])

  const run = async () => {
    const text = prompt.trim()
    if (busy || text.length < MIN_PROMPT) return
    setBusy(true)
    setError(null)
    setWarning(null)
    try {
      const res = await api.generate({
        prompt: text,
        kind,
        palette: palette.trim() || null,
        refine_id: refining && current ? current.id : null,
      })
      setCurrent(res.generation)
      setWarning(res.note || null)
      setShowCode(false)
      if (refining) {
        setPrompt('')
        setRefining(false)
      }
      notify(refining ? 'Page updated' : 'Page generated')
      loadHistory()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const open = async (id) => {
    try {
      setCurrent(await api.getGeneration(id))
      setWarning(null)
      setShowCode(false)
    } catch (err) {
      setError(err)
    }
  }

  const saveFile = async () => {
    try {
      const updated = await api.saveGeneration(current.id)
      setCurrent(updated)
      notify('Saved to backend/generated/')
      loadHistory()
    } catch (err) {
      setError(err)
    }
  }

  const remove = async (id) => {
    try {
      await api.deleteGeneration(id)
      if (current?.id === id) setCurrent(null)
      loadHistory()
    } catch (err) {
      setError(err)
    }
  }

  const download = () => {
    const blob = new Blob([current.html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${current.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'page'}.html`
    // Safari and Firefox need the anchor in the document for a synthetic click
    // to count, and revoking the URL in the same tick can cancel the download
    // before it starts — so append, click, then clean up on the next frame.
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    setTimeout(() => {
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }, 0)
  }

  return (
    <div className="grid h-full grid-cols-1 gap-4 lg:grid-cols-[340px_1fr]">
      {/* ---- Controls ---- */}
      <div className="min-h-0 space-y-4 overflow-y-auto">
        <Panel legend="Build a page" right={busy && <Working label="Building" />}>
          <div className="space-y-3.5">
            <div className="grid grid-cols-3 gap-1.5">
              {KINDS.map((k) => (
                <button
                  key={k.value}
                  onClick={() => setKind(k.value)}
                  className={`rounded border px-2 py-2 text-left transition-colors ${
                    kind === k.value
                      ? 'border-amber/60 bg-amber/10'
                      : 'border-line-soft hover:border-line'
                  }`}
                >
                  <div className="font-legend text-[12px] uppercase tracking-legend">{k.label}</div>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-ink-faint">{KINDS.find((k) => k.value === kind)?.hint}</p>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="legend text-[10px]">
                  {refining ? 'What to change' : 'What to build'}
                </span>
                {!refining && (
                  <button
                    onClick={() => setPrompt(EXAMPLES[kind])}
                    className="legend text-[10px] text-amber/70 hover:text-amber"
                  >
                    Use example
                  </button>
                )}
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={5}
                placeholder={
                  refining
                    ? 'Make the headline larger and switch the accent to deep green'
                    : EXAMPLES[kind]
                }
                className="field resize-none text-[13px]"
              />
            </div>

            {!refining && (
              <div>
                <span className="legend mb-1 block text-[10px]">Colour and type direction</span>
                <input
                  value={palette}
                  onChange={(e) => setPalette(e.target.value)}
                  placeholder="Optional — muted olive, cream, a heavy serif"
                  className="field text-[12px]"
                />
              </div>
            )}

            <button onClick={run} disabled={busy || prompt.trim().length < MIN_PROMPT || !aiEnabled} className="btn-primary w-full py-2">
              {refining ? 'Apply changes' : 'Generate page'}
            </button>

            {current && !refining && (
              <button onClick={() => setRefining(true)} className="btn-ghost w-full">
                Refine this page
              </button>
            )}
            {refining && (
              <button onClick={() => setRefining(false)} className="btn-ghost w-full">
                Cancel refine
              </button>
            )}

            {!aiEnabled && (
              <Notice tone="amber" title="Needs an API key">
                Add ANTHROPIC_API_KEY to backend/.env and restart the server.
              </Notice>
            )}
            {error && (
              <Notice title="Generation failed" onDismiss={() => setError(null)}>
                {error.message}
                {error.fix && <div className="mt-1 text-ink-dim">{error.fix}</div>}
              </Notice>
            )}
          </div>
        </Panel>

        {history.length > 0 && (
          <Panel legend={`Recent — ${history.length}`} bodyClass="p-0">
            <ul className="divide-y divide-line-soft/70">
              {history.map((g) => (
                <li
                  key={g.id}
                  className={`group flex items-center gap-2 px-3 py-2 ${
                    current?.id === g.id ? 'bg-panel-hover' : 'hover:bg-panel-raised'
                  }`}
                >
                  <button onClick={() => open(g.id)} className="min-w-0 flex-1 text-left">
                    <div className="truncate text-[13px]">{g.title}</div>
                    <div className="legend text-[9px]">
                      {g.kind}
                      {g.saved_path ? ' · saved' : ''}
                    </div>
                  </button>
                  <button
                    onClick={() => remove(g.id)}
                    className="shrink-0 text-ink-faint opacity-0 transition-opacity hover:text-alert group-hover:opacity-100"
                    aria-label={`Delete ${g.title}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>

      {/* ---- Preview ---- */}
      <div className="flex min-h-0 flex-col">
        {!current ? (
          <div className="panel flex flex-1 items-center justify-center">
            <div className="max-w-sm px-6 text-center">
              <p className="font-legend text-xl uppercase tracking-legend text-ink-dim">
                Nothing built yet
              </p>
              <p className="mt-2 text-sm text-ink-faint">
                Describe a page on the left. You get one complete HTML file — no build step,
                no dependencies to install — previewed here and ready to save.
              </p>
            </div>
          </div>
        ) : (
          <div className="panel flex min-h-0 flex-1 flex-col">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-4 py-2.5">
              <div className="min-w-0">
                <h2 className="truncate text-[14px]">{current.title}</h2>
                <span className="legend text-[9px]">{current.kind}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button onClick={() => setShowCode((s) => !s)} className="btn-ghost">
                  {showCode ? 'Preview' : 'Code'}
                </button>
                <a
                  href={api.rawUrl(current.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-ghost"
                >
                  Open tab
                </a>
                <button onClick={download} className="btn-ghost">
                  Download
                </button>
                <button onClick={saveFile} className="btn-primary">
                  {current.saved_path ? 'Save again' : 'Save file'}
                </button>
              </div>
            </header>

            {(warning || current.notes) && (
              <div className="space-y-2 border-b border-line-soft px-4 py-2.5">
                {current.notes && <p className="text-[12px] text-ink-dim">{current.notes}</p>}
                {warning && (
                  <Notice tone="amber" title="Worth knowing" onDismiss={() => setWarning(null)}>
                    {warning}
                  </Notice>
                )}
              </div>
            )}

            <div className="min-h-0 flex-1 bg-panel-inset">
              {showCode ? (
                <pre className="h-full overflow-auto p-4 font-mono text-[11px] leading-relaxed text-ink-dim">
                  {current.html}
                </pre>
              ) : (
                <iframe
                  key={current.id}
                  title={`Preview of ${current.title}`}
                  srcDoc={current.html}
                  sandbox="allow-scripts"
                  className="h-full w-full border-0 bg-white"
                />
              )}
            </div>

            {current.saved_path && (
              <footer className="border-t border-line-soft px-4 py-2">
                <p className="truncate font-mono text-[10px] text-ink-faint">
                  {current.saved_path}
                </p>
              </footer>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
