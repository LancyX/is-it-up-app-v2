// Same host: use path only; Nginx Proxy Manager routes /api to backend
const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

export interface State {
  entity_id?: string
  state: string
  last_changed?: string
  last_updated?: string
  attributes?: Record<string, unknown>
}

export interface History {
  entity_id?: string
  history: Array<{ state: string; last_changed: string }>
}

export interface LastChange {
  state?: string
  last_changed?: string
  friendly_name?: string
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function fetchState(): Promise<State> {
  return request<State>('/state')
}

export async function fetchHistory(hours: number): Promise<History> {
  return request<History>(`/history?hours=${hours}`)
}

export async function fetchLastChange(): Promise<LastChange | null> {
  return request<LastChange | null>('/last-change')
}
