// API client. Paths are relative so the same bundle works behind the Vite dev
// proxy and when FastAPI serves the built files itself.

const BASE = '/api'

export class ApiError extends Error {
  constructor(message, { status, fix } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.fix = fix
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let res
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError('Can’t reach the backend.', {
      fix: 'Start it with: uvicorn app.main:app --reload (from the backend folder)',
    })
  }

  if (res.status === 204) return null

  const text = await res.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }

  if (!res.ok) {
    // FastAPI puts our structured errors in `detail`; validation errors put an
    // array of field problems there instead.
    const detail = payload?.detail
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      throw new ApiError(detail.error || 'Request failed', {
        status: res.status,
        fix: detail.fix,
      })
    }
    if (Array.isArray(detail)) {
      const first = detail[0]
      const field = first?.loc?.slice(1).join('.') || 'input'
      throw new ApiError(`${field}: ${first?.msg || 'invalid value'}`, { status: res.status })
    }
    throw new ApiError(
      typeof detail === 'string' ? detail : `Request failed (${res.status})`,
      { status: res.status },
    )
  }

  return payload
}

const qs = (params) => {
  const usable = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== '' && v !== false,
  )
  return usable.length ? `?${new URLSearchParams(Object.fromEntries(usable))}` : ''
}

export const api = {
  health: () => request('/health'),

  // --- tasks ---
  listTasks: (params = {}) => request(`/tasks${qs(params)}`),
  taskStats: () => request('/tasks/stats'),
  listTags: () => request('/tasks/tags'),
  createTask: (body) => request('/tasks', { method: 'POST', body }),
  updateTask: (id, body) => request(`/tasks/${id}`, { method: 'PATCH', body }),
  deleteTask: (id) => request(`/tasks/${id}`, { method: 'DELETE' }),
  addSubtask: (taskId, body) => request(`/tasks/${taskId}/subtasks`, { method: 'POST', body }),
  updateSubtask: (taskId, id, body) =>
    request(`/tasks/${taskId}/subtasks/${id}`, { method: 'PATCH', body }),
  deleteSubtask: (taskId, id) =>
    request(`/tasks/${taskId}/subtasks/${id}`, { method: 'DELETE' }),

  // --- ai ---
  aiStatus: () => request('/ai/status'),
  capture: (body) => request('/ai/capture', { method: 'POST', body }),
  captureConfirm: (tasks) => request('/ai/capture/confirm', { method: 'POST', body: { tasks } }),
  score: (body = {}) => request('/ai/score', { method: 'POST', body }),
  breakdown: (body) => request('/ai/breakdown', { method: 'POST', body }),
  plan: (body) => request('/ai/plan', { method: 'POST', body }),
  chatHistory: () => request('/ai/chat'),
  chat: (message) => request('/ai/chat', { method: 'POST', body: { message } }),
  clearChat: () => request('/ai/chat', { method: 'DELETE' }),

  // --- studio ---
  listGenerations: () => request('/studio'),
  getGeneration: (id) => request(`/studio/${id}`),
  generate: (body) => request('/studio/generate', { method: 'POST', body }),
  saveGeneration: (id) => request(`/studio/${id}/save`, { method: 'POST' }),
  deleteGeneration: (id) => request(`/studio/${id}`, { method: 'DELETE' }),
  rawUrl: (id) => `${BASE}/studio/${id}/raw`,
}
