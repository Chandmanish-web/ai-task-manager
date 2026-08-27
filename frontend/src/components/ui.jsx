import { useCallback, useEffect, useId, useRef, useState } from 'react'

/* ------------------------------------------------------------------ *
 * Panel — a rack unit. Legend sits on the top rail, like a real one.
 * ------------------------------------------------------------------ */
export function Panel({ legend, right, children, className = '', bodyClass = '' }) {
  return (
    <section className={`panel ${className}`}>
      {(legend || right) && (
        <header className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
          {legend && <h2 className="legend text-[12px]">{legend}</h2>}
          {right}
        </header>
      )}
      <div className={bodyClass || 'p-4'}>{children}</div>
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * PriorityMeter — the signature element.
 *
 * A four-segment LED ladder, read bottom-up like a channel meter. P1 lights
 * all four in alert red; P4 lights one in grey. When the AI rescores a task the
 * segments animate up, so triage is something you see happen.
 * ------------------------------------------------------------------ */
const METER_TONE = {
  1: 'bg-alert',
  2: 'bg-amber',
  3: 'bg-ink-dim',
  4: 'bg-ink-faint',
}

export function PriorityMeter({ priority = 3, animate = false, title }) {
  const lit = 5 - Math.max(1, Math.min(4, priority))
  const tone = METER_TONE[priority] || 'bg-ink-faint'

  return (
    <div
      className="flex h-7 w-3 shrink-0 flex-col-reverse justify-start gap-[2px]"
      title={title || `Priority ${priority}`}
      aria-hidden="true"
    >
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          style={animate ? { animationDelay: `${i * 55}ms` } : undefined}
          className={[
            'h-1.5 w-full rounded-[1px] origin-bottom transition-colors',
            i < lit ? tone : 'bg-line-soft',
            animate && i < lit ? 'animate-meter-in' : '',
          ].join(' ')}
        />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Working — the "signal present" indicator during an AI call.
 * ------------------------------------------------------------------ */
export function Working({ label = 'Working' }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="relative h-[3px] w-10 overflow-hidden rounded-full bg-line-soft">
        <span className="absolute inset-y-0 w-1/3 rounded-full bg-amber animate-sweep" />
      </span>
      <span className="legend text-[11px] text-amber">{label}</span>
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * Readout — mono numeric value with its unit label. Used for all data.
 * ------------------------------------------------------------------ */
export function Readout({ label, value, tone = 'ink' }) {
  const toneClass =
    { amber: 'text-amber', alert: 'text-alert', signal: 'text-signal', dim: 'text-ink-dim' }[
      tone
    ] || 'text-ink'
  return (
    <div className="text-right leading-tight">
      <div className={`font-mono text-[13px] ${toneClass}`}>{value}</div>
      {label && <div className="legend text-[9px]">{label}</div>}
    </div>
  )
}

export function Tag({ children }) {
  return (
    <span className="rounded-sm border border-line-soft px-1.5 py-px font-mono text-[10px] text-ink-dim">
      {children}
    </span>
  )
}

export function Empty({ title, children }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="font-legend text-lg uppercase tracking-legend text-ink-dim">{title}</p>
      {children && <p className="mx-auto mt-2 max-w-sm text-sm text-ink-faint">{children}</p>}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Notice — errors and AI-unavailable states. Says what happened and the fix.
 * ------------------------------------------------------------------ */
export function Notice({ tone = 'alert', title, children, onDismiss }) {
  const tones = {
    alert: 'border-alert/40 bg-alert/10 text-alert',
    amber: 'border-amber/40 bg-amber/10 text-amber',
    signal: 'border-signal/40 bg-signal/10 text-signal',
  }
  return (
    // Errors need "alert" so screen readers interrupt; the softer tones are
    // status updates and should wait their turn.
    <div
      className={`rounded border px-3 py-2 text-sm ${tones[tone]}`}
      role={tone === 'alert' ? 'alert' : 'status'}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          {title && <div className="legend text-[11px]">{title}</div>}
          <div className="mt-0.5 text-ink">{children}</div>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="shrink-0 text-ink-faint hover:text-ink"
            aria-label="Dismiss"
          >
            ×
          </button>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */
export function useToasts() {
  const [toasts, setToasts] = useState([])
  const timers = useRef(new Map())

  useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach(clearTimeout)
      pending.clear()
    }
  }, [])

  // Stable identity: callers pass this straight into child props and effect
  // deps, so a new function each render would retrigger their effects.
  const push = useCallback((message, tone = 'signal') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    setToasts((t) => [...t, { id, message, tone }])
    // Keyed by id and deleted on fire, so the map cannot grow without bound
    // over a long session.
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id)
        setToasts((t) => t.filter((x) => x.id !== id))
      }, 4200),
    )
  }, [])

  return { toasts, push }
}

export function ToastHost({ toasts }) {
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`animate-fade-up rounded border px-3 py-2 text-sm shadow-lift ${
            t.tone === 'alert'
              ? 'border-alert/50 bg-panel-raised text-alert'
              : 'border-signal/40 bg-panel-raised text-signal'
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Modal — used for the capture review step.
 * ------------------------------------------------------------------ */
export function Modal({ open, onClose, legend, children, footer, wide = false }) {
  const titleId = useId()
  const panelRef = useRef(null)

  // onClose is nearly always an inline arrow, so keeping it in a ref means the
  // key listener is attached once per open instead of on every parent render.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return

    const onKey = (e) => {
      if (e.key === 'Escape') closeRef.current?.()
    }
    window.addEventListener('keydown', onKey)

    // Flag the open modal so App's global Escape handler stands down —
    // otherwise one keypress closes the modal *and* the task drawer behind it.
    document.body.dataset.modalOpen = '1'
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // Move focus in so the dialog is reachable by keyboard immediately.
    const previouslyFocused = document.activeElement
    panelRef.current?.focus()

    return () => {
      window.removeEventListener('keydown', onKey)
      delete document.body.dataset.modalOpen
      document.body.style.overflow = previousOverflow
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8">
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`animate-fade-up w-full ${wide ? 'max-w-3xl' : 'max-w-xl'} panel shadow-lift outline-none`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="flex items-center justify-between border-b border-line-soft px-4 py-3">
          <h2 id={titleId} className="legend text-[12px]">
            {legend}
          </h2>
          <button onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="Close">
            ×
          </button>
        </header>
        <div className="max-h-[60vh] overflow-y-auto p-4">{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-line-soft px-4 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}
