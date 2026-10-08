import { getRangeBounds } from './utils'
import type { HistoryRange } from './utils'

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
  start?: string
  history: Array<{ state: string; last_changed: string }>
}

export interface LastChange {
  state?: string
  last_changed?: string
  friendly_name?: string
  previous_state?: string
  previous_duration_sec?: number
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

export async function fetchHistory(range: HistoryRange): Promise<History> {
  if (typeof range === 'number') return request<History>(`/history?hours=${range}`)
  const { start, end, live } = getRangeBounds(range, Date.now())
  const params = new URLSearchParams({ start: new Date(start).toISOString() })
  if (!live) params.set('end', new Date(end).toISOString())
  return request<History>(`/history?${params}`)
}

export async function fetchLastChange(): Promise<LastChange | null> {
  return request<LastChange | null>('/last-change')
}
