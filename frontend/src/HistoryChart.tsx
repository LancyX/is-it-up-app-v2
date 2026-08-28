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
import { formatDuration } from './utils'

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

  const now = Date.now()
  const minTime = now - historyHours * 60 * 60 * 1000

  // 1. Generate boundary-aligned timeline points
  const data = useMemo(() => {
    const sortedRaw = history?.history
      ? [...history.history]
          .map((h) => ({
            time: new Date(h.last_changed).getTime(),
            state: h.state ?? 'unknown',
          }))
          .sort((a, b) => a.time - b.time)
      : []

    const points: Array<{ time: number; value: number; state: string }> = []

    // Filter points in range to analyze state at minTime
    const pointsBefore = sortedRaw.filter((p) => p.time <= minTime)
    const pointsAfter = sortedRaw.filter((p) => p.time > minTime && p.time < now)

    let stateAtMin = 'unknown'
    if (pointsBefore.length > 0) {
      stateAtMin = pointsBefore[pointsBefore.length - 1].state
    } else if (pointsAfter.length > 0) {
      stateAtMin = pointsAfter[0].state
    } else if (currentState != null) {
      stateAtMin = currentState
    }

    // Prepend point at minTime
    const valAtMin = stateAtMin.toLowerCase() === 'on' ? 1 : 0
    points.push({ time: minTime, value: valAtMin, state: stateAtMin })

    // Add all middle points
    for (const p of pointsAfter) {
      const val = p.state.toLowerCase() === 'on' ? 1 : 0
      points.push({ time: p.time, value: val, state: p.state })
    }

    // Insert current state change if missing
    if (currentState != null && lastChanged) {
      const lastChangedTime = new Date(lastChanged).getTime()
      const lastPoint = points.length > 0 ? points[points.length - 1] : null
      if (lastChangedTime > minTime && lastChangedTime < now && (!lastPoint || lastPoint.time < lastChangedTime)) {
        const val = currentState.toLowerCase() === 'on' ? 1 : 0
        points.push({ time: lastChangedTime, value: val, state: currentState })
      }
    }

    // Append point at now
    const lastVal = currentState != null ? (currentState.toLowerCase() === 'on' ? 1 : 0) : valAtMin
    const lastState = currentState ?? stateAtMin
    points.push({ time: now, value: lastVal, state: lastState })

    return points
  }, [history, currentState, lastChanged, minTime, now])

  // 2. Compute dynamic SVG horizontal gradient stops based on timeline
  const gradientStops = useMemo(() => {
    if (data.length === 0) return []
    const total = now - minTime
    if (total <= 0) return []

    const stops: Array<{ offset: string; color: string }> = []

    for (let i = 0; i < data.length - 1; i++) {
      const cur = data[i]
      const next = data[i + 1]

      const startPct = Math.max(0, Math.min(100, ((cur.time - minTime) / total) * 100))
      const endPct = Math.max(0, Math.min(100, ((next.time - minTime) / total) * 100))

      const color = cur.state.toLowerCase() === 'on' ? 'var(--on)' : 'var(--off)'

      stops.push({ offset: `${startPct.toFixed(2)}%`, color })
      stops.push({ offset: `${endPct.toFixed(2)}%`, color })
    }

    if (data.length > 0) {
      const last = data[data.length - 1]
      const startPct = Math.max(0, Math.min(100, ((last.time - minTime) / total) * 100))
      const color = last.state.toLowerCase() === 'on' ? 'var(--on)' : 'var(--off)'
      stops.push({ offset: `${startPct.toFixed(2)}%`, color })
      stops.push({ offset: '100%', color })
    }

    return stops
  }, [data, minTime, now])

  // 3. Compute statistics
  const stats = useMemo(() => {
    if (data.length < 2) return null

    let totalOnTime = 0
    let totalOffTime = 0
    // An outage already in progress when the visible range starts has no 'on' -> 'off'
    // transition inside `data` to count it, so count that leading segment as one outage too.
    let outageCount = data[0].state.toLowerCase() === 'off' ? 1 : 0

    for (let i = 0; i < data.length - 1; i++) {
      const cur = data[i]
      const next = data[i + 1]
      const duration = next.time - cur.time

      if (cur.state.toLowerCase() === 'on') {
        totalOnTime += duration
      } else if (cur.state.toLowerCase() === 'off') {
        totalOffTime += duration
      }

      if (cur.state.toLowerCase() === 'on' && next.state.toLowerCase() === 'off') {
        outageCount++
      }
    }

    const totalDuration = now - minTime
    const uptimePercentage = totalDuration > 0 ? (totalOnTime / totalDuration) * 100 : 0
    const avgOutageDuration = outageCount > 0 ? totalOffTime / outageCount : 0

    return {
      uptimePercentage,
      totalOnSec: Math.floor(totalOnTime / 1000),
      totalOffSec: Math.floor(totalOffTime / 1000),
      outageCount,
      avgOutageSec: Math.floor(avgOutageDuration / 1000),
    }
  }, [data, minTime, now])

  // `data` always has >= 2 points (boundary points at minTime/now are synthesized above
  // even with no real history), so check the actual source data for the empty state.
  const hasData = (history?.history?.length ?? 0) > 0 || currentState != null

  if (!hasData) {
    return (
      <div className="chart-empty">
        {t('history.empty')}
      </div>
    )
  }

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

  const formatOutages = (count: number) => {
    if (count === 0) return t('stats.count_none')
    if (count === 1) return t('stats.count_singular')
    if (locale === 'uk') {
      const mod10 = count % 10
      const mod100 = count % 100
      if (mod10 === 1 && mod100 !== 11) {
        return t('stats.count_singular')
      }
      if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
        return t('stats.count_few').replace('{count}', count.toString())
      }
      return t('stats.count_plural').replace('{count}', count.toString())
    }
    return t('stats.count_plural').replace('{count}', count.toString())
  }

  const uniqueId = `grad-${historyHours}`

  return (
    <div className="chart-wrap">
      {stats && (
        <div className="stats-grid">
          <div className="stat-badge">
            <span className="stat-label">{t('stats.availability')}</span>
            <span className="stat-val">{stats.uptimePercentage.toFixed(1)}%</span>
            <span className="stat-sub">
              {t('stats.total_online')}: {formatDuration(stats.totalOnSec, t)}
            </span>
          </div>

          <div className="stat-badge">
            <span className="stat-label">{t('stats.offline')}</span>
            <span className="stat-val">{formatDuration(stats.totalOffSec, t)}</span>
            <span className="stat-sub">{t('history.title')}</span>
          </div>

          <div className="stat-badge">
            <span className="stat-label">{t('stats.outages')}</span>
            <span className="stat-val">{formatOutages(stats.outageCount)}</span>
            <span className="stat-sub">
              {stats.outageCount > 0 ? `${t('stats.avg_duration')}: ${formatDuration(stats.avgOutageSec, t)}` : '—'}
            </span>
          </div>
        </div>
      )}

      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 8 }}>
          <defs>
            <linearGradient id={`line-${uniqueId}`} x1="0" y1="0" x2="1" y2="0">
              {gradientStops.map((s, idx) => (
                <stop key={idx} offset={s.offset} stopColor={s.color} />
              ))}
            </linearGradient>
            <linearGradient id={`fill-${uniqueId}`} x1="0" y1="0" x2="1" y2="0">
              {gradientStops.map((s, idx) => {
                const isOn = s.color === 'var(--on)'
                const opacity = isOn ? 0.15 : 0.02
                return (
                  <stop key={idx} offset={s.offset} stopColor={s.color} stopOpacity={opacity} />
                )
              })}
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
            width={40}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (active && payload && payload.length) {
                const dataPoint = payload[0].payload
                const formattedTime = formatTime(dataPoint.time)
                const isPointOn = dataPoint.state.toLowerCase() === 'on'
                return (
                  <div className="custom-tooltip">
                    <p className="tooltip-time">{formattedTime}</p>
                    <div className="tooltip-row">
                      <span className={`tooltip-dot ${isPointOn ? 'on' : 'off'}`} />
                      <span className="tooltip-value">
                        {isPointOn ? t('state.on') : t('state.off')}
                      </span>
                    </div>
                  </div>
                )
              }
              return null
            }}
          />
          <Area
            type="stepAfter"
            dataKey="value"
            stroke={`url(#line-${uniqueId})`}
            strokeWidth={2}
            fill={`url(#fill-${uniqueId})`}
            animationDuration={300}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
