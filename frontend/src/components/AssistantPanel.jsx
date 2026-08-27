import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { timeOfDay } from '../lib/format.js'
import { Empty, Notice, Working } from './ui.jsx'

const SUGGESTIONS = [
  'What should I do first today?',
  'Mark the SSL renewal done',
  'What’s overdue?',
  'Add: draft the changelog by Thursday, 30 minutes',
]

/**
 * Chat assistant. The model has real tools against the task database, so every
 * turn lists which ones it ran — the panel shows its work rather than asking
 * you to trust it.
 */
export default function AssistantPanel({ aiEnabled, onChanged, notify }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const endRef = useRef(null)

  useEffect(() => {
    api
      .chatHistory()
      .then((rows) => setMessages(rows || []))
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, busy])

  const send = async (text) => {
    const message = (text ?? input).trim()
    if (!message || busy) return

    setInput('')
    setError(null)
    setBusy(true)
    // Optimistic echo so the panel responds immediately.
    setMessages((m) => [
      ...m,
      { id: `local-${Date.now()}`, role: 'user', content: message, actions: [], created_at: new Date().toISOString() },
    ])

    try {
      const res = await api.chat(message)
      setMessages((m) => [
        ...m,
        {
          id: `reply-${Date.now()}`,
          role: 'assistant',
          content: res.reply,
          actions: res.actions || [],
          created_at: new Date().toISOString(),
        },
      ])
      // Any tool call may have changed the list.
      if (res.actions?.length) onChanged()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    try {
      await api.clearChat()
      setMessages([])
      notify('Conversation cleared')
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <div className="panel flex min-h-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
          <h2 className="legend text-[12px]">Assistant</h2>
          <div className="flex items-center gap-3">
            {busy && <Working label="Thinking" />}
            {messages.length > 0 && (
              <button onClick={clear} className="legend text-[10px] hover:text-ink">
                Clear
              </button>
            )}
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {loaded && messages.length === 0 && (
            <Empty title="Ask for anything on your list">
              It can read your tasks, add them, change them, and complete them. It will
              check with you before deleting anything.
            </Empty>
          )}

          {messages.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
              <div className={m.role === 'user' ? 'max-w-[85%]' : 'w-full'}>
                {m.role === 'assistant' && m.actions?.length > 0 && (
                  <ul className="mb-1.5 space-y-1">
                    {m.actions.map((a, i) => (
                      <li
                        key={i}
                        className="flex items-center gap-2 font-mono text-[11px] text-signal"
                      >
                        <span className="h-1 w-1 shrink-0 rounded-full bg-signal" />
                        {a.summary}
                      </li>
                    ))}
                  </ul>
                )}
                <div
                  className={
                    m.role === 'user'
                      ? 'rounded-md rounded-br-sm border border-line-soft bg-panel-raised px-3 py-2 text-[14px]'
                      : 'text-[14px] leading-relaxed'
                  }
                >
                  {m.content.split('\n').map((line, i) => (
                    <p key={i} className={i > 0 ? 'mt-1' : ''}>
                      {line}
                    </p>
                  ))}
                </div>
                <div className="mt-1 text-right font-mono text-[10px] text-ink-faint">
                  {timeOfDay(m.created_at)}
                </div>
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {messages.length === 0 && loaded && (
          <div className="flex flex-wrap gap-1.5 border-t border-line-soft px-4 py-2.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                disabled={!aiEnabled}
                className="rounded border border-line-soft px-2 py-1 text-[12px] text-ink-dim transition-colors hover:border-amber/50 hover:text-amber disabled:opacity-40"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="border-t border-line-soft p-3">
            <Notice title="Assistant unavailable" onDismiss={() => setError(null)}>
              {error.message}
              {error.fix && <div className="mt-1 text-ink-dim">{error.fix}</div>}
            </Notice>
          </div>
        )}

        <footer className="border-t border-line-soft p-3">
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              disabled={!aiEnabled}
              placeholder={aiEnabled ? 'Ask, or tell it what to change' : 'Add an API key to use the assistant'}
              className="field"
              aria-label="Message the assistant"
            />
            <button
              onClick={() => send()}
              disabled={busy || !input.trim() || !aiEnabled}
              className="btn-primary shrink-0"
            >
              Send
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
