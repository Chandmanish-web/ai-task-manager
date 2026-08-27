import { useState } from 'react'
import { PRIORITY, dueLabel, formatMinutes, isOverdue } from '../lib/format.js'
import { PriorityMeter, Readout, Tag } from './ui.jsx'

/**
 * One task, laid out as a channel strip: meter, then identity, then readouts.
 * Everything on this row is one glance wide — detail lives in the drawer.
 */
export default function TaskRow({ task, active, justScored, onOpen, onToggleDone, onStatus }) {
  const [hover, setHover] = useState(false)
  const overdue = isOverdue(task)
  const done = task.status === 'done'
  const openSubtasks = task.subtasks?.filter((s) => !s.done).length || 0

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={[
        'group flex items-center gap-3 border-b border-line-soft/70 px-3 py-2.5 transition-colors',
        active ? 'bg-panel-hover' : 'hover:bg-panel-raised',
        done ? 'opacity-45' : '',
      ].join(' ')}
    >
      <button
        onClick={() => onToggleDone(task)}
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        className={[
          'grid h-[18px] w-[18px] shrink-0 place-items-center rounded-sm border transition-colors',
          done
            ? 'border-signal bg-signal/20 text-signal'
            : 'border-line hover:border-signal hover:bg-signal/10',
        ].join(' ')}
      >
        {done && (
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M2.5 6.5 5 9l4.5-5.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      <PriorityMeter
        priority={task.priority}
        animate={justScored}
        title={PRIORITY[task.priority]?.label}
      />

      <button onClick={() => onOpen(task)} className="min-w-0 flex-1 text-left">
        <div className="flex items-baseline gap-2">
          <span className={`truncate text-[15px] ${done ? 'line-through' : ''}`}>{task.title}</span>
          {task.source !== 'manual' && (
            <span className="legend shrink-0 text-[9px] text-amber/70">ai</span>
          )}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-ink-faint">
          <span className="legend text-[10px]">{PRIORITY[task.priority]?.short}</span>
          {task.due_date && (
            <span className={`font-mono ${overdue ? 'text-alert' : ''}`}>
              {dueLabel(task.due_date)}
            </span>
          )}
          {openSubtasks > 0 && <span className="font-mono">{openSubtasks} steps</span>}
          {task.tags?.slice(0, 3).map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
          {task.ai_reasoning && (
            <span className="hidden truncate text-ink-faint/80 italic sm:inline">
              {task.ai_reasoning}
            </span>
          )}
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-3">
        {hover && !done ? (
          <select
            value={task.status}
            onChange={(e) => onStatus(task, e.target.value)}
            aria-label={`Status for ${task.title}`}
            className="rounded border border-line-soft bg-panel-inset px-1.5 py-1 font-legend text-[11px] uppercase tracking-legend text-ink-dim"
          >
            <option value="inbox">Inbox</option>
            <option value="todo">To do</option>
            <option value="doing">Doing</option>
            <option value="done">Done</option>
            <option value="archived">Archive</option>
          </select>
        ) : (
          <Readout
            label="est"
            value={formatMinutes(task.effort_minutes)}
            tone={task.effort_minutes ? 'ink' : 'dim'}
          />
        )}
      </div>
    </div>
  )
}
