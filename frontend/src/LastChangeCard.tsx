import type { LastChange } from './api'
import { formatDuration, normalizeState } from './utils'
import { useTranslations } from './i18n'
import type { Locale } from './i18n'

interface LastChangeCardProps {
  lastChange: LastChange | null
}

function formatTime(iso: string, locale: Locale): string {
  try {
    const d = new Date(iso)
    const localeTag = locale === 'uk' ? 'uk-UA' : 'en'
    return d.toLocaleString(localeTag, {
      dateStyle: 'short',
      timeStyle: 'short',
    })
  } catch {
    return iso
  }
}

export function LastChangeCard({ lastChange }: LastChangeCardProps) {
  const { t, locale } = useTranslations()

  if (!lastChange?.last_changed) {
    return (
      <section className="card">
        <span className="card-label">{t('lastChange.label')}</span>
        <p className="text-muted">—</p>
      </section>
    )
  }

  // The new state isn't repeated here: it's the current state shown next to this card
  const previousState = normalizeState(lastChange.previous_state)

  return (
    <section className="card">
      <span className="card-label">{t('lastChange.label')}</span>
      <p className="last-change-time">{formatTime(lastChange.last_changed, locale)}</p>
      {lastChange.previous_duration_sec !== undefined && (
        <p className="last-change-duration text-muted">
          {t('lastChange.was')}{' '}
          <span className="last-change-state" data-state={previousState}>
            {t(`state.${previousState}`)}
          </span>{' '}
          {t('lastChange.for')} {formatDuration(lastChange.previous_duration_sec, t)}
        </p>
      )}
    </section>
  )
}
