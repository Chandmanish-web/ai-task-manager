import { useState } from 'react'
import { api } from '../lib/api.js'
import { PRIORITY, toDateInput, fromDateInput, toMinutes } from '../lib/format.js'
import { Modal, Notice, Working } from './ui.jsx'

const EXAMPLE =
  'finish the investor deck before Friday, call the vendor about pricing, ' +
  'and I keep forgetting to renew the domain'

/**
 * Quick capture. Two paths from one box: Enter adds the line verbatim, the
 * Parse button sends it to Claude and opens a review sheet so nothing lands in
 * the list without the person seeing it first.
 */
export default function QuickCapture({ aiEnabled, onChanged, notify }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [drafts, setDrafts] = useState(null)

  const addVerbatim = async () => {
    const title = text.trim()
    if (!title) return
    setBusy(true)
    setError(null)
    try {
      await api.createTask({ title, status: 'inbox', priority: 3, tags: [] })
      setText('')
      notify('Task added')
      onChanged()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const parse = async () => {
    const source = text.trim()
    if (!source) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.capture({ text: source, autosave: false })
      if (!res.tasks?.length) {
        setError({ message: res.note || 'No tasks found in that text.' })
        return
      }
      setDrafts(res.tasks.map((t) => ({ ...t, keep: true })))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const saveDrafts = async () => {
    const keeping = drafts.filter((d) => d.keep)
    if (!keeping.length) {
      setDrafts(null)
      return
    }
    setBusy(true)
    try {
      await api.captureConfirm(
        keeping.map((d) => ({
          title: d.title,
          notes: d.notes || null,
          status: 'inbox',
          priority: Number(d.priority) || 3,
          // The field holds a string while being edited, and '0' is truthy —
          // a falsy check would send 0 to an API that requires >= 1.
          effort_minutes: toMinutes(d.effort_minutes),
          due_date: d.due_date || null,
          tags: d.tags || [],
        })),
      )
      setDrafts(null)
      setText('')
      notify(`Added ${keeping.length} task${keeping.length > 1 ? 's' : ''}`)
      onChanged()
    } catch (err) {
      setError(err)
      setDrafts(null)
    } finally {
      setBusy(false)
    }
  }

  const patchDraft = (i, patch) =>
    setDrafts((ds) => ds.map((d, idx) => (idx === i ? { ...d, ...patch } : d)))

  const keepCount = drafts?.filter((d) => d.keep).length || 0

  return (
    <div className="panel p-3">
      <div className="flex items-start gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              addVerbatim()
            }
          }}
          rows={2}
          placeholder={aiEnabled ? `Type a task, or dump everything: ${EXAMPLE}` : 'Type a task and press Enter'}
          className="field resize-none"
          aria-label="Quick capture"
        />
        <div className="flex w-[124px] shrink-0 flex-col gap-2">
          <button onClick={addVerbatim} disabled={busy || !text.trim()} className="btn-ghost">
            Add as-is
          </button>
          <button
            onClick={parse}
            disabled={busy || !text.trim() || !aiEnabled}
            className="btn-primary"
            title={aiEnabled ? 'Split into structured tasks' : 'Needs an API key'}
          >
            Parse
          </button>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between">
        <p className="text-[11px] text-ink-faint">
          Enter adds one task. Parse splits a brain-dump into several, with dates and estimates.
        </p>
        {busy && <Working label="Reading" />}
      </div>

      {error && (
        <div className="mt-2">
          <Notice title="Couldn’t capture that" onDismiss={() => setError(null)}>
            {error.message}
            {error.fix && <div className="mt-1 text-ink-dim">{error.fix}</div>}
          </Notice>
        </div>
      )}

      <Modal
        open={Boolean(drafts)}
        onClose={() => setDrafts(null)}
        legend={`Review ${drafts?.length || 0} extracted task${drafts?.length === 1 ? '' : 's'}`}
        wide
        footer={
          <>
            <button onClick={() => setDrafts(null)} className="btn-ghost">
              Discard
            </button>
            <button onClick={saveDrafts} disabled={busy || !keepCount} className="btn-primary">
              Add {keepCount || ''} task{keepCount === 1 ? '' : 's'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          {drafts?.map((d, i) => (
            <div
              key={i}
              className={`rounded border px-3 py-2.5 transition-opacity ${
                d.keep ? 'border-line-soft bg-panel-inset' : 'border-line-soft/40 opacity-40'
              }`}
            >
              <div className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={d.keep}
                  onChange={(e) => patchDraft(i, { keep: e.target.checked })}
                  className="mt-1.5 h-4 w-4 shrink-0 accent-amber"
                  aria-label={`Keep ${d.title}`}
                />
                <div className="min-w-0 flex-1 space-y-2">
                  <input
                    value={d.title}
                    onChange={(e) => patchDraft(i, { title: e.target.value })}
                    className="field py-1.5"
                    aria-label="Title"
                  />
                  {d.notes && <p className="text-[12px] text-ink-dim">{d.notes}</p>}

                  <div className="flex flex-wrap items-end gap-2">
                    <label className="block">
                      <span className="legend block text-[9px]">Priority</span>
                      <select
                        value={d.priority}
                        onChange={(e) => patchDraft(i, { priority: Number(e.target.value) })}
                        className="field w-36 py-1"
                      >
                        {[1, 2, 3, 4].map((p) => (
                          <option key={p} value={p}>
                            {PRIORITY[p].short} — {PRIORITY[p].label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="legend block text-[9px]">Est. minutes</span>
                      <input
                        type="number"
                        min="1"
                        value={d.effort_minutes ?? ''}
                        onChange={(e) =>
                          patchDraft(i, { effort_minutes: e.target.value || null })
                        }
                        className="field w-24 py-1 font-mono"
                      />
                    </label>
                    <label className="block">
                      <span className="legend block text-[9px]">Due</span>
                      <input
                        type="date"
                        value={toDateInput(d.due_date)}
                        onChange={(e) =>
                          patchDraft(i, { due_date: fromDateInput(e.target.value) })
                        }
                        className="field w-40 py-1 font-mono"
                      />
                    </label>
                  </div>

                  {d.reason && (
                    <p className="text-[11px] italic text-amber/80">Claude: {d.reason}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  )
}
