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
  /** Current state so we can extend the chart to "now" (e.g. off since 19:03 → show off until 21:21) */
  currentState?: string | null
}

const localeTag = (locale: Locale) => (locale === 'uk' ? 'uk-UA' : 'en')

// Turn state changes into time series: each point has time and numeric value (1=on, 0=off)
// so we get a step-like area chart. Extends to "now" with currentState so the last segment is visible.
function historyToChartData(
  history: History | null,
  currentState: string | null | undefined,
  locale: Locale
): Array<{ time: string; value: number; state: string }> {
  if (!history?.history?.length) return []

  const tag = localeTag(locale)
  const sorted = [...history.history].sort(
    (a, b) => new Date(a.last_changed).getTime() - new Date(b.last_changed).getTime()
  )

  const points: Array<{ time: string; value: number; state: string }> = []
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]
    const value = cur.state?.toLowerCase() === 'on' ? 1 : 0
    const time = new Date(cur.last_changed).toLocaleTimeString(tag, {
      hour: '2-digit',
      minute: '2-digit',
    })
    points.push({ time, value, state: cur.state ?? 'unknown' })
    if (i < sorted.length - 1) {
      const next = sorted[i + 1]
      const nextTime = new Date(next.last_changed).toLocaleTimeString(tag, {
        hour: '2-digit',
        minute: '2-digit',
      })
      points.push({ time: nextTime, value, state: cur.state ?? 'unknown' })
    }
  }

  if (currentState != null) {
    const now = new Date()
    const nowLabel = now.toLocaleTimeString(tag, { hour: '2-digit', minute: '2-digit' })
    const value = currentState.toLowerCase() === 'on' ? 1 : 0
    points.push({ time: nowLabel, value, state: currentState })
  }

  return points
}

export function HistoryChart({ history, currentState }: HistoryChartProps) {
  const { t, locale } = useTranslations()
  const data = useMemo(
    () => historyToChartData(history, currentState, locale),
    [history, currentState, locale]
  )

  if (data.length === 0) {
    return (
      <div className="chart-empty">
        {t('history.empty')}
      </div>
    )
  }

  const yAxisWidth = 36

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
            labelFormatter={(label) => `${t('chart.time')}: ${label}`}
          />
          <Area
            type="stepAfter"
            dataKey="value"
            stroke="var(--on)"
            strokeWidth={2}
            fill="url(#areaOn)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
