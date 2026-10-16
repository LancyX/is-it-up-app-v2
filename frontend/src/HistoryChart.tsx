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
import type { History, Schedule } from './api'
import { useTranslations } from './i18n'
import type { Locale } from './i18n'
import { formatDuration, getRangeBounds, mergeIntervals, normalizeState, parseIntervals, parseOutages } from './utils'
import type { GridState, HistoryRange, Interval } from './utils'

const stateColor = (state: GridState) =>
  state === 'on' ? 'var(--on)' : state === 'off' ? 'var(--off)' : 'var(--text-muted)'

interface HistoryChartProps {
  history: History | null
  currentState?: string | null
  lastChanged?: string
  schedule?: Schedule | null
}

// Schedule lane under the X axis (Recharts' default axis height is 30)
const X_AXIS_HEIGHT = 30
const LANE_GAP = 6
const LANE_HEIGHT = 14
const LANE_NO_DATA_MIN_WIDTH = 80 // px; narrower unknown stretches get no "No data" text
// Planned on/off times under the lane, to compare with the actual change times on the X axis
const LANE_LABEL_HEIGHT = 16
const LANE_LABEL_MIN_GAP = 36 // px between label centres; closer ones are skipped

const localeTag = (locale: Locale) => (locale === 'uk' ? 'uk-UA' : 'en')

export function HistoryChart({
  history,
  currentState,
  lastChanged,
  historyRange,
  schedule,
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

  // Planned schedule (svitlo.live) for a separate lane under the time axis, clipped to the
  // visible range: the current schedule's published days, plus what HA recorded before today.
  // `covered` = where the plan is known; elsewhere the lane stays empty.
  const scheduleLane = useMemo(() => {
    const clip = (list: Interval[]) =>
      mergeIntervals(list)
        .filter((o) => o.end > minTime && o.start < now)
        .map((o) => ({ start: Math.max(o.start, minTime), end: Math.min(o.end, now) }))
    const recorded = history?.schedule_history
    const covered = clip([
      ...(schedule?.days ?? [])
        .filter((d) => d.published)
        .map((d) => ({ start: new Date(d.start).getTime(), end: new Date(d.end).getTime() })),
      ...parseIntervals(recorded?.covered),
    ])
    if (covered.length === 0) return null
    // Stretches with no known plan (before the schedule was recorded, HA downtime, unpublished today)
    const unknown: Interval[] = []
    let cursor = minTime
    for (const c of covered) {
      if (c.start > cursor) unknown.push({ start: cursor, end: c.start })
      cursor = Math.max(cursor, c.end)
    }
    if (cursor < now) unknown.push({ start: cursor, end: now })
    return { covered, unknown, outages: clip([...parseOutages(schedule), ...parseIntervals(recorded?.outages)]) }
  }, [schedule, history, minTime, now])

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
  const laneSpace = scheduleLane ? LANE_GAP + LANE_HEIGHT + LANE_LABEL_HEIGHT : 0

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

      <ResponsiveContainer width="100%" height={220 + laneSpace}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 8 + laneSpace }}>
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
          {scheduleLane && (
            <Customized
              component={({ offset }: { offset?: { left: number; top: number; width: number; height: number } }) => {
                if (!offset) return null
                const x = (time: number) => offset.left + ((time - minTime) / (now - minTime)) * offset.width
                const y = offset.top + offset.height + X_AXIS_HEIGHT + LANE_GAP
                return (
                  <g className="schedule-lane">
                    <text
                      x={offset.left - 6}
                      y={y + LANE_HEIGHT / 2}
                      textAnchor="end"
                      dominantBaseline="central"
                      fill="var(--text-muted)"
                      fontSize={11}
                    >
                      {t('schedule.lane')}
                    </text>
                    {/* Unknown stretches look like the chart's "No data" areas */}
                    {scheduleLane.unknown.map((u) => (
                      <g key={`u-${u.start}`}>
                        <rect x={x(u.start)} y={y} width={x(u.end) - x(u.start)} height={LANE_HEIGHT} fill="var(--text-muted)" fillOpacity={0.08} />
                        {x(u.end) - x(u.start) >= LANE_NO_DATA_MIN_WIDTH && (
                          <text
                            x={(x(u.start) + x(u.end)) / 2}
                            y={y + LANE_HEIGHT / 2}
                            textAnchor="middle"
                            dominantBaseline="central"
                            fill="var(--text-muted)"
                            fontSize={10}
                          >
                            {t('history.no_data')}
                          </text>
                        )}
                      </g>
                    ))}
                    {scheduleLane.covered.map((c) => (
                      <rect key={`c-${c.start}`} x={x(c.start)} y={y} width={x(c.end) - x(c.start)} height={LANE_HEIGHT} fill="var(--glow-on)" />
                    ))}
                    {scheduleLane.outages.map((o) => (
                      <rect key={`o-${o.start}`} x={x(o.start)} y={y} width={x(o.end) - x(o.start)} height={LANE_HEIGHT} fill="var(--off)" />
                    ))}
                    {(() => {
                      // Outage starts/ends inside the range (not where they're clipped to its edges)
                      // Only real transitions: the plan must be known on both sides (not where an
                      // outage is cut by the range edges or the start/end of the known schedule)
                      const times = scheduleLane.outages
                        .flatMap((o) => [o.start, o.end])
                        .filter((time) => scheduleLane.covered.some((c) => c.start < time && time < c.end))
                      const right = offset.left + offset.width
                      let lastX = -Infinity
                      return times.map((time) => {
                        const px = x(time)
                        if (px - lastX < LANE_LABEL_MIN_GAP) return null
                        lastX = px
                        // Keep labels near the plot edges inside it
                        const anchor = px - offset.left < 16 ? 'start' : right - px < 16 ? 'end' : 'middle'
                        return (
                          <g key={`t-${time}`}>
                            <line x1={px} x2={px} y1={y + LANE_HEIGHT} y2={y + LANE_HEIGHT + 3} stroke="var(--text-muted)" />
                            <text
                              x={px}
                              y={y + LANE_HEIGHT + 4}
                              textAnchor={anchor}
                              dominantBaseline="hanging"
                              fill="var(--text-muted)"
                              fontSize={11}
                            >
                              {new Date(time).toLocaleTimeString(localeTag(locale), { hour: '2-digit', minute: '2-digit' })}
                            </text>
                          </g>
                        )
                      })
                    })()}
                  </g>
                )
              }}
            />
          )}
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
            width={52}
          />
          <Tooltip
            cursor={false}
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
            activeDot={false}
            animationDuration={300}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
