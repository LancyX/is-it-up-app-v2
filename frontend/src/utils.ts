
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

// Rolling window of N hours ending now, or a calendar day in the browser's timezone
export type HistoryRange = number | 'today' | 'yesterday'

// `live` = the range ends now, so the current state applies at its end
export function getRangeBounds(range: HistoryRange, now: number): { start: number; end: number; live: boolean } {
  if (typeof range === 'number') return { start: now - range * 60 * 60 * 1000, end: now, live: true }
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  if (range === 'today') return { start: midnight.getTime(), end: now, live: true }
  const yesterday = new Date(midnight)
  yesterday.setDate(yesterday.getDate() - 1) // not -24h: a DST-change day is 23 or 25 hours
  return { start: yesterday.getTime(), end: midnight.getTime(), live: false }
}
