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
  // Where this schedule comes from, and the sources that have this region/queue
  source?: ScheduleSource
  sources?: ScheduleSource[]
  queue?: string
  region?: string
  emergency?: boolean
  available?: boolean
  updated?: string
  // Days of the schedule (Kyiv calendar days); `published: false` = no schedule for that day yet
  days?: Array<{ date: string; start: string; end: string; published: boolean }>
  // Planned outages, merged across days
  outages?: Array<{ start: string; end: string }>
}

export type ScheduleSource = 'dtek' | 'svitlo'

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

// `scheduleSource`: whose past schedule to include (null = the backend's default)
export async function fetchHistory(range: HistoryRange, scheduleSource: ScheduleSource | null): Promise<History> {
  const params = new URLSearchParams()
  if (typeof range === 'number') {
    params.set('hours', String(range))
  } else {
    const { start, end, live } = getRangeBounds(range, Date.now())
    params.set('start', new Date(start).toISOString())
    if (!live) params.set('end', new Date(end).toISOString())
  }
  if (scheduleSource) params.set('schedule_source', scheduleSource)
  return request<History>(`/history?${params}`)
}

export async function fetchLastChange(): Promise<LastChange | null> {
  return request<LastChange | null>('/last-change')
}

export async function fetchSchedule(source: ScheduleSource | null): Promise<Schedule> {
  return request<Schedule>(source ? `/schedule?source=${source}` : '/schedule')
}
