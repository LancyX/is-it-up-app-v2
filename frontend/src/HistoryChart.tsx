import { useMemo } from 'react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'
import type { History } from './api'
import { useTranslations } from './i18n'
import type { Locale } from './i18n'

interface HistoryChartProps {
  history: History | null
  currentState?: string | null
  lastChanged?: string
}

const localeTag = (locale: Locale) => (locale === 'uk' ? 'uk-UA' : 'en')

export function HistoryChart({
  history,
  currentState,
  lastChanged,
  historyHours,
}: HistoryChartProps & { historyHours: number }) {
  const { t, locale } = useTranslations()

  const data = useMemo(() => {
    if (!history?.history?.length) return []
    // Sort logic remains same
    const sorted = [...history.history].sort(
      (a, b) => new Date(a.last_changed).getTime() - new Date(b.last_changed).getTime()
    )

    const points: Array<{ time: number; value: number; state: string }> = []

    // We want the chart to start exactly at (now - historyHours).
    // If the first history point is before that, great.
    // If the first history point is after that, we might want to assume
    // the state was the same as the first point (or unknown).
    // For simplicity, let's just plot what we have, but set the XAxis domain fixed.

    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i]
      const val = cur.state?.toLowerCase() === 'on' ? 1 : 0
      const time = new Date(cur.last_changed).getTime()

      points.push({ time, value: val, state: cur.state ?? 'unknown' })
    }

    // Insert the transition to current state if it's missing from history
    if (currentState != null && lastChanged) {
      const lastChangedTime = new Date(lastChanged).getTime()
      const lastPointIdx = points.length - 1
      const lastPoint = points.length > 0 ? points[lastPointIdx] : null

      // If we have no points, or the last point is before the current state change
      if (!lastPoint || lastPoint.time < lastChangedTime) {
        const val = currentState.toLowerCase() === 'on' ? 1 : 0
        points.push({ time: lastChangedTime, value: val, state: currentState })
      }
    }

    if (currentState != null) {
      const now = Date.now()
      const val = currentState.toLowerCase() === 'on' ? 1 : 0
      points.push({ time: now, value: val, state: currentState })
    }

    return points
  }, [history, currentState, lastChanged, locale]) // removed historyHours dependency as it doesn't affect *data* gen, only axis

  if (data.length === 0) {
    return (
      <div className="chart-empty">
        {t('history.empty')}
      </div>
    )
  }

  const now = Date.now()
  const minTime = now - historyHours * 60 * 60 * 1000
  const yAxisWidth = 36

  const differentDays = new Date(minTime).toDateString() !== new Date(now).toDateString()

  const formatTime = (time: number) => {
    const date = new Date(time)
    if (differentDays) {
      return date.toLocaleTimeString(localeTag(locale), {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    }
    return date.toLocaleTimeString(localeTag(locale), {
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div className="chart-wrap">
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 8 }}>
          <defs>
            <linearGradient id="areaOn" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--on)" stopOpacity={0.4} />
              <stop offset="100%" stopColor="var(--on)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="areaOff" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--off)" stopOpacity={0.2} />
              <stop offset="100%" stopColor="var(--off)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="time"
            type="number"
            domain={[minTime, now]}
            scale="time"
            tickFormatter={formatTime}
            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
            stroke="var(--border)"
          />
          <YAxis
            domain={[0, 1]}
            ticks={[0, 1]}
            tickFormatter={(v) => (v === 1 ? t('state.on_history') : t('state.off_history'))}
            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
            stroke="var(--border)"
            width={yAxisWidth}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}
            labelStyle={{ color: 'var(--text)' }}
            formatter={(value: number) => [value === 1 ? t('state.on') : t('state.off'), t('chart.state')]}
            labelFormatter={(label) => `${t('chart.time')}: ${formatTime(label)}`}
          />
          <Area
            type="stepAfter"
            dataKey="value"
            stroke="var(--on)"
            strokeWidth={2}
            fill="url(#areaOn)"
            animationDuration={300}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
