import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './lib/api.js'
import { STATUS_LABEL, formatMinutes } from './lib/format.js'
import AssistantPanel from './components/AssistantPanel.jsx'
import PlanPanel from './components/PlanPanel.jsx'
import QuickCapture from './components/QuickCapture.jsx'
import StudioPanel from './components/StudioPanel.jsx'
import TaskDetail from './components/TaskDetail.jsx'
import TaskRow from './components/TaskRow.jsx'
import { Empty, Notice, Readout, ToastHost, Working, useToasts } from './components/ui.jsx'

const MODULES = [
  { id: 'tasks', label: 'List', hint: 'Everything on your plate' },
  { id: 'plan', label: 'Plan', hint: 'Fill the time you have' },
  { id: 'assistant', label: 'Ask', hint: 'Change things by talking' },
  { id: 'studio', label: 'Studio', hint: 'Generate a web page' },
]

const FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'doing', label: 'Doing' },
  { id: 'overdue', label: 'Late' },
  { id: 'done', label: 'Done' },
]

export default function App() {
  const [view, setView] = useState('tasks')
  const [tasks, setTasks] = useState([])
  const [stats, setStats] = useState(null)
  const [ai, setAi] = useState({ ai_enabled: false, detail: '', model: '' })
  const [aiChecked, setAiChecked] = useState(false)
  const [filter, setFilter] = useState('open')
  const [search, setSearch] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [scoring, setScoring] = useState(false)
  const [error, setError] = useState(null)
  const [justScored, setJustScored] = useState([])
  const { toasts, push } = useToasts()

  // Every refresh is tagged; only the newest one is allowed to write state.
  // Without this, a slow response for "ema" can land after a fast one for
  // "email" and repopulate the list with stale rows.
  const requestId = useRef(0)

  const notify = useCallback((message, tone = 'signal') => push(message, tone), [push])

  // Typing is not a reason to hit the API. Wait for a pause, and compare the
  // trimmed value so whitespace alone never triggers a fetch.
  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(search.trim()), 250)
    return () => clearTimeout(timer)
  }, [search])

  const refresh = useCallback(async () => {
    const id = ++requestId.current
    try {
      const params =
        filter === 'overdue'
          ? { status: 'open', overdue_only: true }
          : filter === 'open'
            ? { status: 'open' }
            : { status: filter }

      const [taskRows, statRow] = await Promise.all([
        api.listTasks({ ...params, q: searchTerm || undefined }),
        api.taskStats(),
      ])
      if (id !== requestId.current) return
      setTasks(taskRows)
      setStats(statRow)
      setError(null)
    } catch (err) {
      if (id !== requestId.current) return
      setError(err)
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [filter, searchTerm])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    api
      .aiStatus()
      .then(setAi)
      // A failed status call means the backend is unreachable, which is a
      // different problem from a missing key — say so rather than blaming
      // the API key.
      .catch(() => setAi({ ai_enabled: false, unreachable: true, detail: '', model: '' }))
      .finally(() => setAiChecked(true))
  }, [])

  // Cmd/Ctrl+K focuses capture; 1-4 switch modules when not typing.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setView('tasks')
        setTimeout(() => document.querySelector('[aria-label="Quick capture"]')?.focus(), 0)
        return
      }
      // Escape is handled before the typing guard on purpose: closing the
      // panel is exactly what you want while your cursor is still in one of
      // its fields. A Modal claims Escape for itself while it is open, so one
      // keypress does not also dismiss the drawer behind it.
      if (e.key === 'Escape') {
        if (!document.body.dataset.modalOpen) setSelectedId(null)
        return
      }
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return
      const idx = ['1', '2', '3', '4'].indexOf(e.key)
      if (idx >= 0) setView(MODULES[idx].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const selected = useMemo(() => tasks.find((t) => t.id === selectedId) || null, [tasks, selectedId])

  const toggleDone = async (task) => {
    const next = task.status === 'done' ? 'todo' : 'done'
    setTasks((ts) => ts.map((t) => (t.id === task.id ? { ...t, status: next } : t)))
    try {
      await api.updateTask(task.id, { status: next })
      refresh()
    } catch (err) {
      setError(err)
      refresh()
    }
  }

  const setStatus = async (task, status) => {
    try {
      await api.updateTask(task.id, { status })
      refresh()
    } catch (err) {
      setError(err)
    }
  }

  const runScoring = async () => {
    setScoring(true)
    try {
      const res = await api.score({})
      if (!res.scored.length) {
        notify(res.note || 'Everything is already scored')
      } else {
        setJustScored(res.scored.map((s) => s.id))
        notify(`Triaged ${res.scored.length} task${res.scored.length > 1 ? 's' : ''}`)
        setTimeout(() => setJustScored([]), 1400)
      }
      refresh()
    } catch (err) {
      setError(err)
    } finally {
      setScoring(false)
    }
  }

  const openTaskById = async (id) => {
    setView('tasks')
    setFilter('open')
    setSelectedId(id)
  }

  const showAiBanner = aiChecked && !ai.ai_enabled
  // Ask and Studio are single-panel views that should own the viewport rather
  // than scroll the page. Everything else scrolls normally.
  const fillsViewport = view === 'assistant' || view === 'studio'

  return (
    <div className="flex h-full">
      <nav className="flex w-[220px] shrink-0 flex-col border-r border-line-soft bg-panel">
        <div className="border-b border-line-soft px-5 py-5">
          <div className="font-legend text-2xl tracking-legend text-ink">Task Manager</div>
          <div className="mt-1 text-xs text-ink-faint">Keep work clear and moving.</div>
        </div>

        <div className="flex flex-1 flex-col gap-1 p-4">
          {MODULES.map((m, i) => (
            <button
              key={m.id}
              onClick={() => setView(m.id)}
              title={`${m.hint}  (${i + 1})`}
              className={`relative rounded-md px-3 py-2.5 text-left transition-colors ${
                view === m.id
                  ? 'bg-panel-hover text-ink'
                  : 'text-ink-faint hover:bg-panel-raised hover:text-ink-dim'
              }`}
            >
              {view === m.id && (
                <span className="absolute left-0 top-1/2 h-6 w-[2px] -translate-y-1/2 rounded-r bg-amber" />
              )}
              <span className="font-legend text-[15px] tracking-legend">{m.label}</span>
            </button>
          ))}
        </div>

        {stats && (
          <div className="space-y-2 border-t border-line-soft px-2 py-3">
            <Readout label="open" value={stats.inbox + stats.todo + stats.doing} />
            {stats.overdue > 0 && <Readout label="late" value={stats.overdue} tone="alert" />}
            <Readout label="est" value={formatMinutes(stats.minutes_open)} tone="dim" />
          </div>
        )}
      </nav>

      {/* ---- Main ---- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-line-soft bg-panel px-5 py-2.5">
          <div>
            <h1 className="font-legend text-2xl tracking-legend">
              {MODULES.find((m) => m.id === view)?.label}
            </h1>
            <p className="text-[11px] text-ink-faint">
              {MODULES.find((m) => m.id === view)?.hint}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {ai.ai_enabled && (
              <span className="hidden font-mono text-[10px] text-ink-faint md:inline">
                {ai.model}
              </span>
            )}
            <span
              className={`h-2 w-2 rounded-full ${ai.ai_enabled ? 'bg-signal' : 'bg-ink-faint'}`}
              title={ai.detail}
            />
          </div>
        </header>

        <main
          className={`flex min-h-0 flex-1 flex-col p-5 ${
            fillsViewport ? 'overflow-hidden' : 'overflow-y-auto'
          }`}
        >
          {showAiBanner && (
            <div className="mb-4 shrink-0">
              {ai.unreachable ? (
                <Notice tone="alert" title="Can't reach the backend">
                  Nothing will load until the API is running.
                  <div className="mt-1 font-mono text-[11px] text-ink-dim">
                    start-backend.bat → http://127.0.0.1:8000
                  </div>
                </Notice>
              ) : (
                <Notice tone="amber" title="AI features are off">
                  {ai.detail || 'No API key found.'}
                  <div className="mt-1 font-mono text-[11px] text-ink-dim">
                    backend/.env → ANTHROPIC_API_KEY=sk-ant-…
                  </div>
                </Notice>
              )}
            </div>
          )}

          {error && (
            <div className="mb-4 shrink-0">
              <Notice title="Request failed" onDismiss={() => setError(null)}>
                {error.message}
                {error.fix && <div className="mt-1 font-mono text-[11px] text-ink-dim">{error.fix}</div>}
              </Notice>
            </div>
          )}

          {view === 'tasks' && (
            <div className="flex gap-4">
              <div className="min-w-0 flex-1 space-y-4">
                <QuickCapture aiEnabled={ai.ai_enabled} onChanged={refresh} notify={notify} />

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-1">
                    {FILTERS.map((f) => (
                      <button
                        key={f.id}
                        onClick={() => setFilter(f.id)}
                        className={`rounded border px-2.5 py-1 font-legend text-[12px] uppercase tracking-legend transition-colors ${
                          filter === f.id
                            ? 'border-amber/60 bg-amber/10 text-amber'
                            : 'border-line-soft text-ink-faint hover:text-ink'
                        }`}
                      >
                        {f.label}
                        {f.id === 'overdue' && stats?.overdue > 0 && (
                          <span className="ml-1.5 font-mono text-[11px] text-alert">
                            {stats.overdue}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search"
                      className="field w-40 py-1 text-[13px]"
                      aria-label="Search tasks"
                    />
                    {scoring ? (
                      <Working label="Triaging" />
                    ) : (
                      <button
                        onClick={runScoring}
                        disabled={!ai.ai_enabled || !stats?.unscored}
                        className="btn-primary"
                        title={
                          stats?.unscored
                            ? `Score ${stats.unscored} unscored task(s)`
                            : 'Nothing new to score'
                        }
                      >
                        Triage {stats?.unscored ? stats.unscored : ''}
                      </button>
                    )}
                  </div>
                </div>

                <div className="panel overflow-hidden">
                  {loading ? (
                    <div className="px-4 py-10 text-center">
                      <Working label="Loading" />
                    </div>
                  ) : tasks.length === 0 ? (
                    // Suppress the empty state when a request failed — an
                    // error notice plus "Nothing here" reads as two unrelated
                    // problems when it is really one.
                    error ? null : (
                      <Empty title={search ? 'No matches' : 'Nothing here'}>
                        {search
                          ? 'Try a different word, or clear the search.'
                          : filter === 'open'
                            ? 'Type something in the box above to start.'
                            : `No tasks with status “${STATUS_LABEL[filter] || filter}”.`}
                      </Empty>
                    )
                  ) : (
                    tasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        active={task.id === selectedId}
                        justScored={justScored.includes(task.id)}
                        onOpen={(t) => setSelectedId(t.id === selectedId ? null : t.id)}
                        onToggleDone={toggleDone}
                        onStatus={setStatus}
                      />
                    ))
                  )}
                </div>

                <p className="text-center font-mono text-[10px] text-ink-faint">
                  ⌘K capture · 1–4 switch panels · esc close
                </p>
              </div>

              {selected && (
                <>
                  {/* Wide screens: docked beside the list. */}
                  <div className="hidden w-[380px] shrink-0 lg:block">
                    <div className="sticky top-0 max-h-[calc(100vh-6.5rem)]">
                      <TaskDetail
                        task={selected}
                        aiEnabled={ai.ai_enabled}
                        onClose={() => setSelectedId(null)}
                        onChanged={() => refresh()}
                        notify={notify}
                      />
                    </div>
                  </div>

                  {/* Narrow screens: there is no room to dock, so slide over
                      the list. Previously this was `hidden lg:block` only,
                      which meant tapping a row on a laptop or phone appeared
                      to do nothing at all. */}
                  <div
                    className="fixed inset-0 z-40 flex lg:hidden"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Task detail"
                  >
                    <button
                      type="button"
                      aria-label="Close task detail"
                      onClick={() => setSelectedId(null)}
                      className="flex-1 bg-black/60"
                    />
                    <div className="w-full max-w-[420px] overflow-y-auto border-l border-line bg-panel-inset">
                      <TaskDetail
                        task={selected}
                        aiEnabled={ai.ai_enabled}
                        onClose={() => setSelectedId(null)}
                        onChanged={() => refresh()}
                        notify={notify}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {view === 'plan' && (
            <PlanPanel aiEnabled={ai.ai_enabled} onOpenTask={openTaskById} notify={notify} />
          )}

          {view === 'assistant' && (
            <div className="min-h-0 flex-1">
              <AssistantPanel aiEnabled={ai.ai_enabled} onChanged={refresh} notify={notify} />
            </div>
          )}

          {view === 'studio' && (
            <div className="min-h-0 flex-1">
              <StudioPanel aiEnabled={ai.ai_enabled} notify={notify} />
            </div>
          )}
        </main>
      </div>

      <ToastHost toasts={toasts} />
    </div>
  )
}
