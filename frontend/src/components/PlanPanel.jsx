import { useState } from 'react'
import { api } from '../lib/api.js'
import { formatMinutes } from '../lib/format.js'
import { Empty, Notice, Panel, Working } from './ui.jsx'

const ENERGY = [
  { value: 'low', label: 'Low', hint: 'short, mechanical work' },
  { value: 'medium', label: 'Medium', hint: 'a normal working stretch' },
  { value: 'high', label: 'High', hint: 'hardest thing first' },
]

const PRESETS = [60, 120, 240, 480]

/**
 * Session planner. Claude fills the available time from the open list and says
 * what it deliberately left out — the deferred list is the honest half.
 */
export default function PlanPanel({ aiEnabled, onOpenTask, notify }) {
  const [minutes, setMinutes] = useState(240)
  const [energy, setEnergy] = useState('medium')
  const [context, setContext] = useState('')
  const [plan, setPlan] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const build = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.plan({
        available_minutes: Number(minutes),
        energy,
        context: context.trim() || null,
      })
      setPlan(res)
      if (res.note) notify(res.note, 'alert')
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const fillPct = plan ? Math.min(100, Math.round((plan.total_minutes / minutes) * 100)) : 0

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Panel legend="Plan this session" right={busy && <Working label="Planning" />}>
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="legend text-[10px]">Time available</span>
              <span className="font-mono text-[13px] text-amber">{formatMinutes(Number(minutes))}</span>
            </div>
            <input
              type="range"
              min="15"
              max="600"
              step="15"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              className="w-full accent-amber"
              aria-label="Minutes available"
            />
            <div className="mt-1.5 flex gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setMinutes(p)}
                  className={`rounded border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                    Number(minutes) === p
                      ? 'border-amber/60 bg-amber/15 text-amber'
                      : 'border-line-soft text-ink-faint hover:text-ink'
                  }`}
                >
                  {formatMinutes(p)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="legend mb-1.5 block text-[10px]">Energy</span>
            <div className="grid grid-cols-3 gap-2">
              {ENERGY.map((e) => (
                <button
                  key={e.value}
                  onClick={() => setEnergy(e.value)}
                  className={`rounded border px-2 py-2 text-left transition-colors ${
                    energy === e.value
                      ? 'border-amber/60 bg-amber/10'
                      : 'border-line-soft hover:border-line'
                  }`}
                >
                  <div className="font-legend text-[13px] uppercase tracking-legend">{e.label}</div>
                  <div className="mt-0.5 text-[11px] text-ink-faint">{e.hint}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="legend mb-1.5 block text-[10px]">Anything Claude should know</span>
            <input
              value={context}
              onChange={(e) => setContext(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && aiEnabled && build()}
              placeholder="Board meeting at 4, so nothing heavy after 3"
              className="field"
            />
          </div>

          <button onClick={build} disabled={busy || !aiEnabled} className="btn-primary w-full py-2">
            {plan ? 'Rebuild plan' : 'Build my plan'}
          </button>

          {error && (
            <Notice title="Couldn’t build a plan" onDismiss={() => setError(null)}>
              {error.message}
              {error.fix && <div className="mt-1 text-ink-dim">{error.fix}</div>}
            </Notice>
          )}
        </div>
      </Panel>

      {plan && (
        <Panel
          legend="Your session"
          right={
            <span className="font-mono text-[12px] text-ink-dim">
              {formatMinutes(plan.total_minutes)} / {formatMinutes(Number(minutes))}
            </span>
          }
          bodyClass="p-0"
        >
          <div className="border-b border-line-soft px-4 py-3">
            <p className="text-[15px]">{plan.headline}</p>
            <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-line-soft">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  fillPct > 100 ? 'bg-alert' : 'bg-amber'
                }`}
                style={{ width: `${fillPct}%` }}
              />
            </div>
          </div>

          {plan.blocks.length === 0 ? (
            <Empty title="Nothing scheduled">
              Add some tasks first, then build the plan again.
            </Empty>
          ) : (
            <ol className="divide-y divide-line-soft/70">
              {plan.blocks.map((b, i) => (
                <li key={i} className="flex gap-3 px-4 py-3">
                  <span className="mt-0.5 w-6 shrink-0 font-mono text-[13px] text-amber">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0 flex-1">
                    {b.task_id ? (
                      <button
                        onClick={() => onOpenTask(b.task_id)}
                        className="text-left text-[15px] hover:text-amber"
                      >
                        {b.title}
                      </button>
                    ) : (
                      <span className="text-[15px]">{b.title}</span>
                    )}
                    <p className="mt-0.5 text-[12px] text-ink-dim">{b.why}</p>
                  </div>
                  <span className="shrink-0 font-mono text-[13px] text-ink-dim">
                    {formatMinutes(b.minutes)}
                  </span>
                </li>
              ))}
            </ol>
          )}

          {plan.deferred?.length > 0 && (
            <div className="border-t border-line-soft bg-panel-inset px-4 py-3">
              <div className="legend text-[10px]">Left out on purpose</div>
              <ul className="mt-1.5 space-y-1">
                {plan.deferred.map((d, i) => (
                  <li key={i} className="text-[12px] text-ink-faint">
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      )}
    </div>
  )
}
