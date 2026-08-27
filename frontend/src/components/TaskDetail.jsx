import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { PRIORITY, STATUSES, fromDateInput, toDateInput, toMinutes } from '../lib/format.js'
import { Notice, Working } from './ui.jsx'

/**
 * Right-hand drawer: edit one task, and run subtask breakdown on it.
 * Edits save on blur so there's no separate save button to forget.
 */
export default function TaskDetail({ task, aiEnabled, onClose, onChanged, notify }) {
  const [draft, setDraft] = useState(task)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [guidance, setGuidance] = useState('')
  const [approach, setApproach] = useState(null)
  const [newStep, setNewStep] = useState('')

  // Reset only when a *different* task is selected. The parent derives `task`
  // from the tasks array, so its object identity changes on every background
  // refresh — depending on the object itself wiped whatever was half-typed
  // each time a refresh landed.
  useEffect(() => {
    setDraft(task)
    setApproach(null)
    setGuidance('')
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id])

  const save = async (patch) => {
    setDraft((d) => ({ ...d, ...patch }))
    try {
      const updated = await api.updateTask(task.id, patch)
      setDraft(updated)
      onChanged(updated)
    } catch (err) {
      setError(err)
    }
  }

  const runBreakdown = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.breakdown({
        task_id: task.id,
        max_steps: 6,
        guidance: guidance.trim() || null,
        autosave: true,
      })
      setApproach(res.approach)
      setGuidance('')
      notify(`Added ${res.steps.length} steps`)
      onChanged(null, { refetch: true })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const toggleStep = async (sub) => {
    try {
      await api.updateSubtask(task.id, sub.id, { done: !sub.done })
      onChanged(null, { refetch: true })
    } catch (err) {
      setError(err)
    }
  }

  const addStep = async () => {
    const title = newStep.trim()
    if (!title) return
    try {
      await api.addSubtask(task.id, { title, done: false, position: task.subtasks?.length || 0 })
      setNewStep('')
      onChanged(null, { refetch: true })
    } catch (err) {
      setError(err)
    }
  }

  const removeStep = async (sub) => {
    try {
      await api.deleteSubtask(task.id, sub.id)
      onChanged(null, { refetch: true })
    } catch (err) {
      setError(err)
    }
  }

  const remove = async () => {
    try {
      await api.deleteTask(task.id)
      notify('Task deleted')
      onClose()
      onChanged(null, { refetch: true })
    } catch (err) {
      setError(err)
    }
  }

  // Server-owned fields are read straight from the prop, not the draft, so a
  // refresh or an AI run shows up immediately. The draft holds only the fields
  // the user types into.
  const steps = task.subtasks || []
  const doneSteps = steps.filter((s) => s.done).length

  return (
    <aside className="flex h-full flex-col border-l border-line-soft bg-panel">
      <header className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
        <span className="legend text-[12px]">
          Task <span className="font-mono text-ink-dim">#{task.id}</span>
        </span>
        <button onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="Close panel">
          ×
        </button>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {error && (
          <Notice title="Something went wrong" onDismiss={() => setError(null)}>
            {error.message}
            {error.fix && <div className="mt-1 text-ink-dim">{error.fix}</div>}
          </Notice>
        )}

        <div>
          <label className="legend mb-1 block text-[10px]">Title</label>
          <textarea
            value={draft.title}
            rows={2}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            onBlur={() => draft.title.trim() && draft.title !== task.title && save({ title: draft.title.trim() })}
            className="field resize-none text-[15px]"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="legend mb-1 block text-[10px]">Status</span>
            <select
              value={draft.status}
              onChange={(e) => save({ status: e.target.value })}
              className="field"
            >
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="legend mb-1 block text-[10px]">Priority</span>
            <select
              value={draft.priority}
              onChange={(e) => save({ priority: Number(e.target.value) })}
              className="field"
            >
              {[1, 2, 3, 4].map((p) => (
                <option key={p} value={p}>
                  {PRIORITY[p].short} — {PRIORITY[p].label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="legend mb-1 block text-[10px]">Est. minutes</span>
            <input
              type="number"
              min="1"
              step="1"
              value={draft.effort_minutes ?? ''}
              onChange={(e) => setDraft({ ...draft, effort_minutes: e.target.value })}
              onBlur={() => {
                // The field holds a string while being typed, and '0' is
                // truthy — a falsy check sent 0 to an API that requires >= 1.
                const next = toMinutes(draft.effort_minutes)
                if (next !== (task.effort_minutes ?? null)) save({ effort_minutes: next })
                else setDraft((d) => ({ ...d, effort_minutes: next }))
              }}
              className="field font-mono"
            />
          </label>

          <label className="block">
            <span className="legend mb-1 block text-[10px]">Due</span>
            <input
              type="date"
              value={toDateInput(draft.due_date)}
              onChange={(e) => save({ due_date: fromDateInput(e.target.value) })}
              className="field font-mono"
            />
          </label>
        </div>

        <div>
          <label className="legend mb-1 block text-[10px]">Tags — comma separated</label>
          <input
            value={(draft.tags || []).join(', ')}
            onChange={(e) => setDraft({ ...draft, tags: e.target.value.split(',') })}
            onBlur={() =>
              save({ tags: (draft.tags || []).map((t) => t.trim()).filter(Boolean) })
            }
            className="field font-mono text-[12px]"
            placeholder="design, launch"
          />
        </div>

        <div>
          <label className="legend mb-1 block text-[10px]">Notes</label>
          <textarea
            value={draft.notes || ''}
            rows={3}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            onBlur={() => (draft.notes || '') !== (task.notes || '') && save({ notes: draft.notes })}
            className="field resize-none text-[13px]"
            placeholder="Anything you'll want when you pick this up."
          />
        </div>

        {task.ai_reasoning && (
          <div className="rounded border border-amber/25 bg-amber/5 px-3 py-2">
            <div className="legend text-[10px] text-amber/80">Why Claude scored it this way</div>
            <p className="mt-1 text-[13px] text-ink">{task.ai_reasoning}</p>
            {task.ai_urgency != null && (
              <p className="mt-1.5 font-mono text-[11px] text-ink-faint">
                urgency {task.ai_urgency}/5 · importance {task.ai_importance}/5
              </p>
            )}
          </div>
        )}

        {/* ---- Steps ---- */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="legend text-[10px]">
              Steps {steps.length > 0 && <span className="font-mono">{doneSteps}/{steps.length}</span>}
            </span>
            {busy && <Working label="Breaking down" />}
          </div>

          {steps.length > 0 && (
            <ul className="mb-3 space-y-1">
              {steps.map((s) => (
                <li key={s.id} className="group flex items-start gap-2">
                  <button
                    onClick={() => toggleStep(s)}
                    aria-label={s.done ? `Reopen step: ${s.title}` : `Complete step: ${s.title}`}
                    className={`mt-[3px] grid h-[15px] w-[15px] shrink-0 place-items-center rounded-sm border text-[10px] transition-colors ${
                      s.done
                        ? 'border-signal bg-signal/20 text-signal'
                        : 'border-line hover:border-signal'
                    }`}
                  >
                    {s.done ? '✓' : ''}
                  </button>
                  <span className={`flex-1 text-[13px] ${s.done ? 'text-ink-faint line-through' : ''}`}>
                    {s.title}
                  </span>
                  <button
                    onClick={() => removeStep(s)}
                    className="shrink-0 text-ink-faint opacity-0 transition-opacity hover:text-alert group-hover:opacity-100"
                    aria-label={`Delete step: ${s.title}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2">
            <input
              value={newStep}
              onChange={(e) => setNewStep(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addStep()}
              placeholder="Add a step"
              className="field py-1.5 text-[13px]"
            />
            <button onClick={addStep} disabled={!newStep.trim()} className="btn-ghost shrink-0">
              Add
            </button>
          </div>

          {aiEnabled && (
            <div className="mt-3 rounded border border-line-soft bg-panel-inset p-2.5">
              <input
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
                placeholder="Optional direction, e.g. “assume I'm starting from scratch”"
                className="field py-1.5 text-[12px]"
              />
              <button
                onClick={runBreakdown}
                disabled={busy}
                className="btn-primary mt-2 w-full"
              >
                Break into steps
              </button>
              {approach && (
                <p className="mt-2 text-[11px] italic text-amber/80">Approach: {approach}</p>
              )}
            </div>
          )}
        </div>
      </div>

      <footer className="border-t border-line-soft p-3">
        <button onClick={remove} className="btn-danger w-full">
          Delete task
        </button>
      </footer>
    </aside>
  )
}
