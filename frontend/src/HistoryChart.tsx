import { useMemo } from 'react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceArea,
  Customized,
} from 'recharts'
import type { History } from './api'
import { useTranslations } from './i18n'
import type { Locale } from './i18n'
import { formatDuration, getRangeBounds, normalizeState } from './utils'
import type { GridState, HistoryRange } from './utils'

const stateColor = (state: GridState) =>
  state === 'on' ? 'var(--on)' : state === 'off' ? 'var(--off)' : 'var(--text-muted)'

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
  historyRange,
}: HistoryChartProps & { historyRange: HistoryRange }) {
  const { t, locale } = useTranslations()

  // `now` is the end of the visible range: the real current time, or midnight for 'yesterday'
  const { start: minTime, end: now, live } = getRangeBounds(historyRange, Date.now())

  // 1. Generate boundary-aligned timeline: each point starts a segment lasting until the next point
  const timeline = useMemo(() => {
    const sortedRaw = history?.history
      ? [...history.history]
          .map((h) => ({
            time: new Date(h.last_changed).getTime(),
            state: normalizeState(h.state),
          }))
          .sort((a, b) => a.time - b.time)
      : []

    const points: Array<{ time: number; state: GridState }> = []

    // HA returns the state at the requested start as the first item, stamped exactly at that
    // start. Use the server's start too, so client clock skew can't push that item into range.
    const serverStart = history?.start ? new Date(history.start).getTime() : NaN
    const startCutoff = Number.isNaN(serverStart) ? minTime : Math.max(minTime, serverStart)

    // Filter points in range to analyze state at minTime
    const pointsBefore = sortedRaw.filter((p) => p.time <= startCutoff)
    const pointsAfter = sortedRaw.filter((p) => p.time > startCutoff && p.time < now)
    const lastChangedTime = lastChanged ? new Date(lastChanged).getTime() : NaN

    // If HA has no record that old (e.g. the entity was recreated), keep that stretch as
    // 'unknown' rather than guessing it from the first later point.
    let stateAtMin: GridState = 'unknown'
    if (pointsBefore.length > 0) {
      stateAtMin = pointsBefore[pointsBefore.length - 1].state
    } else if (currentState != null && lastChangedTime <= startCutoff) {
      stateAtMin = normalizeState(currentState)
    }

    // Prepend point at minTime
    points.push({ time: minTime, state: stateAtMin })

    // Add all middle points
    points.push(...pointsAfter)

    // Insert current state change if missing
    if (live && currentState != null && lastChanged) {
      const lastPoint = points[points.length - 1]
      if (lastChangedTime > minTime && lastChangedTime < now && lastPoint.time < lastChangedTime) {
        points.push({ time: lastChangedTime, state: normalizeState(currentState) })
      }
    }

    // Append point at now (the current state applies only if the range ends now)
    const lastState =
      live && currentState != null ? normalizeState(currentState) : points[points.length - 1].state
    points.push({ time: now, state: lastState })

    // 'unavailable'/'unknown' carries the last known state forward, so off -> unavailable -> off
    // is one continuous outage. Only a stretch with no known state before it stays 'unknown'.
    let lastKnown: GridState = 'unknown'
    return points.map((p) => {
      if (p.state !== 'unknown') lastKnown = p.state
      return { ...p, state: lastKnown }
    })
  }, [history, currentState, lastChanged, minTime, now, live])

  // 'unknown' is plotted at 0 but made invisible via the gradient (zero stop opacity)
  const data = useMemo(
    () => timeline.map((p) => ({ ...p, value: p.state === 'on' ? 1 : 0 })),
    [timeline],
  )

  const unknownRanges = useMemo(() => {
    const ranges: Array<{ x1: number; x2: number }> = []
    for (let i = 0; i < timeline.length - 1; i++) {
      if (timeline[i].state !== 'unknown') continue
      const last = ranges[ranges.length - 1]
      if (last && last.x2 === timeline[i].time) last.x2 = timeline[i + 1].time
      else ranges.push({ x1: timeline[i].time, x2: timeline[i + 1].time })
    }
    return ranges
  }, [timeline])

  // 2. Compute dynamic SVG horizontal gradient stops based on timeline
  const gradientStops = useMemo(() => {
    if (timeline.length === 0) return []
    const total = now - minTime
    if (total <= 0) return []

    const stops: Array<{ offset: string; color: string; state: GridState }> = []

    for (let i = 0; i < timeline.length - 1; i++) {
      const cur = timeline[i]
      const next = timeline[i + 1]

      const startPct = Math.max(0, Math.min(100, ((cur.time - minTime) / total) * 100))
      const endPct = Math.max(0, Math.min(100, ((next.time - minTime) / total) * 100))

      const color = stateColor(cur.state)

      stops.push({ offset: `${startPct.toFixed(2)}%`, color, state: cur.state })
      stops.push({ offset: `${endPct.toFixed(2)}%`, color, state: cur.state })
    }

    const last = timeline[timeline.length - 1]
    const startPct = Math.max(0, Math.min(100, ((last.time - minTime) / total) * 100))
    const color = stateColor(last.state)
    stops.push({ offset: `${startPct.toFixed(2)}%`, color, state: last.state })
    stops.push({ offset: '100%', color, state: last.state })

    return stops
  }, [timeline, minTime, now])

  // 3. Compute statistics (only over time with known state)
  const stats = useMemo(() => {
    if (timeline.length < 2) return null

    let totalOnTime = 0
    let totalOffTime = 0
    let totalUnknownTime = 0
    let outageCount = 0
    // Count an outage whenever 'off' starts after a known non-'off' state, or as the first known
    // state (an outage already in progress). Brief 'unavailable' blips inside an outage
    // (off -> unavailable -> off) must not count it twice.
    let prevKnown: GridState | null = null

    for (let i = 0; i < timeline.length; i++) {
      const cur = timeline[i]
      const next = timeline[i + 1]
      const duration = next ? next.time - cur.time : 0

      if (cur.state === 'on') totalOnTime += duration
      else if (cur.state === 'off') totalOffTime += duration
      else totalUnknownTime += duration

      if (cur.state === 'off' && prevKnown !== 'off') outageCount++
      if (cur.state !== 'unknown') prevKnown = cur.state
    }

    const knownDuration = totalOnTime + totalOffTime
    if (knownDuration <= 0) return null
    const uptimePercentage = (totalOnTime / knownDuration) * 100
    const avgOutageDuration = outageCount > 0 ? totalOffTime / outageCount : 0

    return {
      uptimePercentage,
      totalOnSec: Math.floor(totalOnTime / 1000),
      totalOffSec: Math.floor(totalOffTime / 1000),
      totalUnknownSec: Math.floor(totalUnknownTime / 1000),
      outageCount,
      avgOutageSec: Math.floor(avgOutageDuration / 1000),
    }
  }, [timeline])

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

  // `now - 1`: 'yesterday' ends exactly at midnight, which is still the same day
  const differentDays = new Date(minTime).toDateString() !== new Date(now - 1).toDateString()

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

  const uniqueId = `grad-${historyRange}`

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
            <span className="stat-sub">
              {stats.totalUnknownSec >= 60
                ? `${t('history.no_data')}: ${formatDuration(stats.totalUnknownSec, t)}`
                : t('history.title')}
            </span>
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
          {/* Gradients span the plot area in pixels (userSpaceOnUse). The default objectBoundingBox
              would follow the line's own bounds, and a flat line (no change in range) has zero
              height, so SVG wouldn't paint it at all. `offset` is the plot area from Recharts. */}
          <Customized
            component={({ offset }: { offset?: { left: number; width: number } }) =>
              offset ? (
                <defs>
                  <linearGradient
                    id={`line-${uniqueId}`}
                    gradientUnits="userSpaceOnUse"
                    x1={offset.left}
                    y1="0"
                    x2={offset.left + offset.width}
                    y2="0"
                  >
                    {gradientStops.map((s, idx) => (
                      <stop
                        key={idx}
                        offset={s.offset}
                        stopColor={s.color}
                        stopOpacity={s.state === 'unknown' ? 0 : 1}
                      />
                    ))}
                  </linearGradient>
                  <linearGradient
                    id={`fill-${uniqueId}`}
                    gradientUnits="userSpaceOnUse"
                    x1={offset.left}
                    y1="0"
                    x2={offset.left + offset.width}
                    y2="0"
                  >
                    {gradientStops.map((s, idx) => {
                      const opacity = s.state === 'on' ? 0.15 : s.state === 'off' ? 0.02 : 0
                      return (
                        <stop key={idx} offset={s.offset} stopColor={s.color} stopOpacity={opacity} />
                      )
                    })}
                  </linearGradient>
                </defs>
              ) : null
            }
          />
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          {unknownRanges.map((r) => (
            <ReferenceArea
              key={r.x1}
              x1={r.x1}
              x2={r.x2}
              fill="var(--text-muted)"
              fillOpacity={0.08}
              stroke="none"
              ifOverflow="hidden"
              label={
                r.x2 - r.x1 >= (now - minTime) * 0.15
                  ? { value: t('history.no_data'), fill: 'var(--text-muted)', fontSize: 11 }
                  : undefined
              }
            />
          ))}
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
                const pointState: GridState = dataPoint.state
                return (
                  <div className="custom-tooltip">
                    <p className="tooltip-time">{formattedTime}</p>
                    <div className="tooltip-row">
                      <span className={`tooltip-dot ${pointState}`} />
                      <span className="tooltip-value">
                        {pointState === 'unknown' ? t('history.no_data') : t(`state.${pointState}`)}
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
