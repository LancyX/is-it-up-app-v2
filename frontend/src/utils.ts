import type { Schedule } from './api'



export function formatDuration(seconds: number, t: (key: string) => string): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (seconds > 0 && seconds < 60) return `${Math.floor(seconds)} ${t('units.s')}`
  if (h > 0) return `${h} ${t('units.h')} ${m} ${t('units.m')}`
  return `${m} ${t('units.m')}`
}

export type GridState = 'on' | 'off' | 'unknown'

// HA can also report 'unavailable' / 'unknown' (e.g. while a template entity reloads);
// those must not be shown or counted as an outage.
export function normalizeState(state: string | null | undefined): GridState {
  const s = state?.toLowerCase()
  return s === 'on' || s === 'off' ? s : 'unknown'
}

// A calendar day in the browser's timezone, as days back from today: 0 = today, 1 = yesterday, …
export type HistoryRange = number
// Days to pick from (today included); HA keeps 10 days by default (purge_keep_days)
export const HISTORY_DAYS = 7

// `live` = the range ends now (today), so the current state applies at its end
export function getRangeBounds(daysAgo: HistoryRange, now: number): { start: number; end: number; live: boolean } {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - daysAgo) // not -24h: a DST-change day is 23 or 25 hours
  if (daysAgo === 0) return { start: start.getTime(), end: now, live: true }
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start: start.getTime(), end: end.getTime(), live: false }
}

export interface Interval {
  start: number
  end: number
}

// ISO start/end pairs from the API as epoch-ms intervals
export function parseIntervals(list: Array<{ start: string; end: string }> | null | undefined): Interval[] {
  return (list ?? []).map((o) => ({ start: new Date(o.start).getTime(), end: new Date(o.end).getTime() }))
}

// Planned outages from /api/schedule
export function parseOutages(schedule: Schedule | null | undefined): Interval[] {
  return parseIntervals(schedule?.outages)
}

// Sort and join overlapping or touching intervals
export function mergeIntervals(list: Interval[]): Interval[] {
  const merged: Interval[] = []
  for (const i of [...list].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1]
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end)
    else merged.push({ ...i })
  }
  return merged
}
