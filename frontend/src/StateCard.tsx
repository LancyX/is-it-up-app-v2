import type { State } from './api'
import { useState, useEffect } from 'react'
import { formatDuration } from './utils'
import { useTranslations } from './i18n'

interface StateCardProps {
  state: State
}

export function StateCard({ state }: StateCardProps) {
  const { t } = useTranslations()
  const [duration, setDuration] = useState<string>('')

  useEffect(() => {
    const updateDuration = () => {
      if (!state.last_changed) {
        setDuration('')
        return
      }
      const lastChanged = new Date(state.last_changed).getTime()
      const now = Date.now()
      const seconds = Math.max(0, Math.floor((now - lastChanged) / 1000))
      setDuration(formatDuration(seconds, t))
    }

    updateDuration()
    const interval = setInterval(updateDuration, 60000) // Update every minute
    return () => clearInterval(interval)
  }, [state.last_changed, t])

  const isOn = state.state?.toLowerCase() === 'on'
  // const rawLabel = state.attributes?.friendly_name ?? state.entity_id ?? 'Grid'
  // const label = typeof rawLabel === 'string' ? rawLabel : 'Grid'

  return (
    <section className="card state-card">
      <span className="card-label">{t('state.current')}</span>
      <p className="state-value" data-state={isOn ? 'on' : 'off'}>
        {isOn ? t('state.on') : t('state.off')}
      </p>
      {duration && (
        <p className="state-duration text-muted" style={{ fontSize: '0.9em', marginTop: 4 }}>
          {t('lastChange.for')} {duration}
        </p>
      )}
      {/* <p className="state-entity">{label}</p> */}
    </section>
  )
}
