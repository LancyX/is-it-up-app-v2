import type { AddressStatus } from './api'
import { useTranslations } from './i18n'

interface DtekNoticesProps {
  address: AddressStatus | null
  // Emergency outages in effect in the region (from the schedule)
  emergency: boolean
}

const KNOWN_STATUSES = ['emergency', 'planned']
// DTEK's address status during an ordinary scheduled outage ("Стабілізаційне відключення (Згідно
// графіку погодинних відключень)"): the schedule card already shows it, so it's not an alert
const SCHEDULED = ['ok', 'stabilization']

// What DTEK reports, only when it reports something; the two happen independently:
// - emergency outages in the region (the schedule may not be followed);
// - an outage registered for the address other than the scheduled one, with its estimated
//   restoration (nothing when the integration can't reach DTEK: the status may be stale then).
export function DtekNotices({ address, emergency }: DtekNoticesProps) {
  const { t, locale } = useTranslations()
  const status = address?.enabled && address.connected && address.status && !SCHEDULED.includes(address.status)
      ? address.status
      : null
  if (!emergency && !status) return null

  const formatTime = (iso: string) => {
    const time = new Date(iso)
    const sameDay = time.toDateString() === new Date().toDateString()
    return time.toLocaleString(locale === 'uk' ? 'uk-UA' : 'en', {
      ...(sameDay ? {} : { day: 'numeric', month: 'short' }),
      hour: '2-digit',
      minute: '2-digit',
    })
  }
  const details = status
    ? [
        address?.description,
        address?.start && t('address.since').replace('{time}', formatTime(address.start)),
        address?.end && t('address.until').replace('{time}', formatTime(address.end)),
      ].filter(Boolean)
    : []

  return (
    <>
      {emergency && (
        <p className="dtek-notice" role="status">
          <strong>{t('region.emergency')}</strong>
        </p>
      )}
      {status && (
        <p className="dtek-notice" role="status">
          <strong>{t(`address.${KNOWN_STATUSES.includes(status) ? status : 'other'}`)}</strong>
          {details.length > 0 && <span className="dtek-notice-details">{details.join(' · ')}</span>}
        </p>
      )}
    </>
  )
}
