
export function formatDuration(seconds: number, t: (key: string) => string): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h} ${t('units.h')} ${m} ${t('units.m')}`
  return `${m} ${t('units.m')}`
}
