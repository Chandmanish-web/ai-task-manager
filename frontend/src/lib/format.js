// Display helpers. Kept out of components so formatting stays consistent.

export const PRIORITY = {
  1: { label: 'Urgent + important', short: 'P1', tone: 'alert' },
  2: { label: 'Important', short: 'P2', tone: 'amber' },
  3: { label: 'Urgent only', short: 'P3', tone: 'ink' },
  4: { label: 'Neither', short: 'P4', tone: 'faint' },
}

export const STATUSES = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'todo', label: 'To do' },
  { value: 'doing', label: 'Doing' },
  { value: 'done', label: 'Done' },
  { value: 'archived', label: 'Archived' },
]

export const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.value, s.label]))

export function formatMinutes(minutes) {
  if (!minutes) return '—'
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

/**
 * Coerce a minutes field to what the API accepts: a positive integer, or null.
 *
 * Number inputs hand back strings, and '0' is truthy — so `value ? Number(value)
 * : null` happily sends 0 to an endpoint that requires >= 1 and gets a 422 back.
 * Anything unparseable or below 1 becomes null, i.e. "not estimated".
 */
export function toMinutes(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : null
}

// ---------------------------------------------------------------------------
// Due dates
//
// A due date is a calendar date, not an instant. The backend stores it as
// midnight UTC, so it must be read back in UTC too — reading it in local time
// shifts the day for every user west of UTC (pick "Aug 28", get back "Aug 27",
// and the drift compounds on each save). These helpers reduce a date to a day
// number so all comparisons happen in whole days and never on clock times.
//
// One deliberate asymmetry: the due date is read in UTC, but "today" is the
// user's own local day. That keeps "Today" honest for someone in Auckland or
// Honolulu, at the cost of the badge disagreeing with the server's UTC-based
// overdue count by a few hours near midnight. Both places the UI shows
// lateness use these same helpers, so at least the UI never contradicts
// itself — which was the visible bug.
// ---------------------------------------------------------------------------
const MS_PER_DAY = 86400000

function dueDayNumber(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / MS_PER_DAY)
}

function todayDayNumber() {
  const n = new Date()
  return Math.floor(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / MS_PER_DAY)
}

/** Whole days from today until the due date. Negative means late. */
export function daysUntilDue(iso) {
  if (!iso) return null
  const due = dueDayNumber(iso)
  return due === null ? null : due - todayDayNumber()
}

/** Relative due date, e.g. "Today", "3d late", "in 5d". */
export function dueLabel(iso) {
  const days = daysUntilDue(iso)
  if (days === null) return null

  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return '1d late'
  if (days < 0) return `${Math.abs(days)}d late`
  if (days <= 7) return `in ${days}d`

  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function isOverdue(task) {
  if (!task?.due_date || task.status === 'done' || task.status === 'archived') return false
  const days = daysUntilDue(task.due_date)
  return days !== null && days < 0
}

/** <input type="date"> wants YYYY-MM-DD. Read in UTC to match how it was stored. */
export function toDateInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** Anchor at midnight UTC so the day survives the round trip unchanged. */
export function fromDateInput(value) {
  if (!value) return null
  const d = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function timeOfDay(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
