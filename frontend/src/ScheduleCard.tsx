import { useEffect, useState } from 'react'
import type { Schedule } from './api'
import { useTranslations } from './i18n'
import type { Locale } from './i18n'
import { formatDuration, parseOutages } from './utils'
import type { Interval } from './utils'

interface ScheduleCardProps {
  schedule: Schedule
}

const localeTag = (locale: Locale) => (locale === 'uk' ? 'uk-UA' : 'en')

const formatClock = (time: number, locale: Locale) =>
  new Date(time).toLocaleTimeString(localeTag(locale), { hour: '2-digit', minute: '2-digit' })

// Keep "1 год 59 хв" on one line when the summary wraps
const noWrap = (text: string) => text.replace(/ /g, '\u00a0')

const HALF_HOUR = 30 * 60 * 1000

// Schedule spans are whole half-hours: "4 год", "4 год 30 хв", "30 хв"
const formatSpan = (ms: number, t: (key: string) => string) => {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  if (h === 0) return `${m} ${t('units.m')}`
  return m === 0 ? `${h} ${t('units.h')}` : `${h} ${t('units.h')} ${m} ${t('units.m')}`
}

interface Slot extends Interval {
  off: boolean
}

// Split a day into half-hour slots (the schedule's resolution), each marked off if it's inside
// a planned outage. Stepping in real time keeps 23/25-hour DST days correct.
function buildSlots(start: number, end: number, outages: Interval[]): Slot[] {
  const slots: Slot[] = []
  for (let t = start; t < end; t += HALF_HOUR) {
    const slotEnd = Math.min(t + HALF_HOUR, end)
    slots.push({ start: t, end: slotEnd, off: outages.some((o) => o.start < slotEnd && o.end > t) })
  }
  return slots
}

export function ScheduleCard({ schedule }: ScheduleCardProps) {
  const { t, locale } = useTranslations()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const outages = parseOutages(schedule)
  // Days that haven't ended; the backend may also send yesterday (for the history chart)
  const days = (schedule.days ?? []).filter((d) => new Date(d.end).getTime() > now)
  const current = outages.find((o) => o.start <= now && now < o.end)
  const next = outages.find((o) => o.start > now)

  // "14:30", or "06:00 tomorrow" when the time is on a later day
  const formatWhen = (time: number) => {
    const clock = formatClock(time, locale)
    return new Date(time).toDateString() === new Date(now).toDateString()
      ? clock
      : t('schedule.time_tomorrow').replace('{time}', clock)
  }

  // What the schedule says about now: outage until X, or next outage at Y
  let summary: string
  if (!schedule.available || !days.some((d) => d.published)) {
    summary = t('schedule.none')
  } else if (current) {
    summary = t('schedule.off_until')
      .replace('{time}', formatWhen(current.end))
      .replace('{left}', noWrap(formatDuration((current.end - now) / 1000, t)))
  } else if (next) {
    summary = t('schedule.next_off')
      .replace('{time}', formatWhen(next.start))
      .replace('{left}', noWrap(formatDuration((next.start - now) / 1000, t)))
  } else {
    // Without tomorrow's schedule we only know about the rest of today
    summary = days[days.length - 1]?.published ? t('schedule.no_more') : t('schedule.no_more_today')
  }

  return (
    <section className="card schedule-card">
      <div className="schedule-header">
        <span className="card-label">{t('schedule.title')}</span>
        {schedule.queue && (
          <span className="schedule-queue">{t('schedule.queue').replace('{queue}', schedule.queue)}</span>
        )}
      </div>

      {schedule.emergency && (
        <p className="schedule-alert" role="status">
          {t('schedule.emergency')}
        </p>
      )}

      <p className="schedule-summary" data-state={current ? 'off' : 'on'}>
        {summary}
      </p>

      {/* Nothing published at all: the summary already says so */}
      {days.some((d) => d.published) && days.map((day) => {
        const start = new Date(day.start).getTime()
        const end = new Date(day.end).getTime()
        const dayName = start <= now ? t('history.today') : t('schedule.tomorrow')
        const dateLabel = new Date(start).toLocaleDateString(localeTag(locale), {
          weekday: 'short',
          day: 'numeric',
          month: 'long',
        })

        if (!day.published) {
          return (
            <div className="schedule-day" key={day.date}>
              <div className="schedule-day-header">
                <span className="schedule-day-label">
                  {dayName}
                  <span className="schedule-day-date">{dateLabel}</span>
                </span>
              </div>
              <p className="schedule-empty">{t('schedule.not_published')}</p>
            </div>
          )
        }

        const slots = buildSlots(start, end, outages)
        const offMs = slots.filter((s) => s.off).reduce((sum, s) => sum + s.end - s.start, 0)
        // Hour cells of two half-hour slots each, like DTEK's table
        const hours: Slot[][] = []
        for (let i = 0; i < slots.length; i += 2) hours.push(slots.slice(i, i + 2))
        const formatEnd = (time: number) => (time === end ? '24:00' : formatClock(time, locale))
        const stateLabel = (off: boolean) => (off ? t('schedule.off') : t('schedule.on'))

        return (
          <div className="schedule-day" key={day.date}>
            <div className="schedule-day-header">
              <span className="schedule-day-label">
                {dayName}
                <span className="schedule-day-date">{dateLabel}</span>
              </span>
              <span className="schedule-day-total">
                {offMs > 0 ? t('schedule.off_total').replace('{total}', formatSpan(offMs, t)) : t('schedule.no_outages')}
              </span>
            </div>

            <div className="schedule-grid">
              {hours.map((halves) => {
                const hourStart = halves[0].start
                const hourEnd = halves[halves.length - 1].end
                const isCurrent = now >= hourStart && now < hourEnd
                return (
                  <div
                    key={hourStart}
                    className="schedule-cell"
                    data-current={isCurrent || undefined}
                    data-past={hourEnd <= now || undefined}
                    title={halves
                      .map((h) => `${formatClock(h.start, locale)}–${formatEnd(h.end)}: ${stateLabel(h.off)}`)
                      .join('\n')}
                  >
                    <span className="schedule-cell-hour">{new Date(hourStart).getHours().toString().padStart(2, '0')}</span>
                    <span className="schedule-cell-box">
                      {halves.map((h) => (
                        <span key={h.start} className="schedule-cell-half" data-off={h.off || undefined} />
                      ))}
                      {isCurrent && (
                        <span
                          className="schedule-cell-now"
                          style={{ left: `${((now - hourStart) / (hourEnd - hourStart)) * 100}%` }}
                        />
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {schedule.updated && (
        <p className="schedule-updated">
          {t('schedule.updated').replace('{time}', formatClock(new Date(schedule.updated).getTime(), locale))}
        </p>
      )}
    </section>
  )
}
