import type { State } from './api'
import { useTranslations } from './i18n'

interface StateCardProps {
  state: State
}

export function StateCard({ state }: StateCardProps) {
  const { t } = useTranslations()
  const isOn = state.state?.toLowerCase() === 'on'
  const rawLabel = state.attributes?.friendly_name ?? state.entity_id ?? 'Grid'
  const label = typeof rawLabel === 'string' ? rawLabel : 'Grid'

  return (
    <section className="card state-card">
      <span className="card-label">{t('state.current')}</span>
      <p className="state-value" data-state={isOn ? 'on' : 'off'}>
        {isOn ? t('state.on') : t('state.off')}
      </p>
      <p className="state-entity">{label}</p>
    </section>
  )
}
