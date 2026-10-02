
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
