import type { LastChange } from './api'
import { formatDuration } from './utils'
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

  const isOn = lastChange.state?.toLowerCase() === 'on'



  return (
    <section className="card">
      <span className="card-label">{t('lastChange.label')}</span>
      <p className="last-change-time">{formatTime(lastChange.last_changed, locale)}</p>
      <p className="last-change-state" data-state={isOn ? 'on' : 'off'}>
        {t('lastChange.switchedTo')} {isOn ? t('state.on') : t('state.off')}
      </p>
      {lastChange.previous_duration_sec !== undefined && (
        <p className="last-change-duration text-muted" style={{ fontSize: '0.9em', marginTop: 4 }}>
          {t('lastChange.was')} {lastChange.previous_state === 'on' ? t('state.on') : t('state.off')} {t('lastChange.for')} {formatDuration(lastChange.previous_duration_sec, t)}
        </p>
      )}
    </section>
  )
}
