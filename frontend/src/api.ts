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
  // Schedule as recorded by the backend before today (null if no schedule is configured)
  schedule_history?: {
    covered: Array<{ start: string; end: string }>
    outages: Array<{ start: string; end: string }>
  } | null
}

export interface LastChange {
  state?: string
  last_changed?: string
  friendly_name?: string
  previous_state?: string
  previous_duration_sec?: number
}

export interface Schedule {
  enabled: boolean
  queue?: string
  region?: string
  available?: boolean
  // Emergency outages in effect in the region: the schedule may not be followed
  emergency?: boolean
  updated?: string
  // Days of the schedule (Kyiv calendar days); `published: false` = no schedule for that day yet
  days?: Array<{ date: string; start: string; end: string; published: boolean }>
  // Planned outages, merged across days
  outages?: Array<{ start: string; end: string }>
}

// What DTEK reports for the address (DTEK Monitor integration in HA)
export interface AddressStatus {
  enabled: boolean
  // ok / emergency / planned / stabilization; null = unknown
  status?: string | null
  description?: string | null
  start?: string | null
  // Estimated restoration
  end?: string | null
  // Its last request to DTEK went through (otherwise the status may be stale)
  connected?: boolean
  checked_at?: string | null
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
  const { start, end, live } = getRangeBounds(range, Date.now())
  const params = new URLSearchParams({ start: new Date(start).toISOString() })
  if (!live) params.set('end', new Date(end).toISOString())
  return request<History>(`/history?${params}`)
}

export async function fetchLastChange(): Promise<LastChange | null> {
  return request<LastChange | null>('/last-change')
}

export async function fetchSchedule(): Promise<Schedule> {
  return request<Schedule>('/schedule')
}

export async function fetchAddress(): Promise<AddressStatus> {
  return request<AddressStatus>('/address')
}
