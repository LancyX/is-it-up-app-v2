import { useEffect, useMemo, useRef, useState } from 'react'
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
const LANE_LABEL_SPACING = 6 // px between neighbouring labels; ones that would overlap are skipped
const LABEL_CHAR_WIDTH = 6.2 // px per character at 11px, to estimate label widths
const LABEL_EDGE = 16 // px; labels closer to a lane edge are aligned to it instead of centred

// Phones (App.css's breakpoint): two compact lanes, actual and planned, instead of the chart.
// Tracked live, so turning a phone to landscape switches to the full chart.
const PHONE_QUERY = '(max-width: 599px)'

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const update = () => setMatches(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [query])
  return matches
}
const CHART_HEIGHT = 220

type LaneState = 'on' | 'off' | 'unknown'

// An outage to label. A missing start/end isn't a real transition (cut off by the range edge or
// by unknown data), so it gets no label.
interface LabelSpan {
  start?: number
  end?: number
  duration: number // ms (visible part); longer outages get label space first
}

interface LabelFormat {
  time: (time: number) => string
  range: (start: number, end: number) => string // "11:30–12:00", for spans too short for two labels
}

interface Lane {
  label: string
  segments: Array<{ start: number; end: number; state: LaneState }>
  spans: LabelSpan[]
  edges: EdgeLabel[]
  format: LabelFormat
}

type TickAlign = 'start' | 'middle' | 'end'

// The range start/end, labelled if there's room left after the outages
interface EdgeLabel {
  time: number
  text: string
}

interface PlacedLabel {
  key: string
  text: string
  x: number
  anchor: TickAlign
  from: number
  to: number
}

// Time labels for outages along a lane spanning `left`..`right` px. An outage's start and end are
// shown together or not at all (never just one of them): as two labels at its edges, or as one
// "start–end" label under it when it's too short for two. Outages go from the longest down (a
// 5-minute blip shouldn't take the space of an hour-long outage), then the range edges, skipping
// ones that would overlap labels already placed. `marks` = every outage
// boundary, so it's visible even when its label didn't fit.
function placeSpanLabels(
  spans: LabelSpan[],
  edges: EdgeLabel[],
  format: LabelFormat,
  toPx: (time: number) => number,
  left: number,
  right: number,
): { labels: PlacedLabel[]; marks: number[] } {
  const atTime = (time: number, text = format.time(time)): PlacedLabel => {
    const px = toPx(time)
    const width = text.length * LABEL_CHAR_WIDTH
    // Centred on its time, or aligned to the lane edge it's close to
    const anchor: TickAlign = px - left < LABEL_EDGE ? 'start' : right - px < LABEL_EDGE ? 'end' : 'middle'
    const from = anchor === 'start' ? px : anchor === 'end' ? px - width : px - width / 2
    return { key: `t-${time}`, text, x: px, anchor, from, to: from + width }
  }
  const groups: PlacedLabel[][] = []
  for (const span of [...spans].sort((a, b) => b.duration - a.duration)) {
    if (span.start !== undefined && span.end !== undefined) {
      const pair = [atTime(span.start), atTime(span.end)]
      if (pair[1].from >= pair[0].to + LANE_LABEL_SPACING) {
        groups.push(pair)
      } else {
        const text = format.range(span.start, span.end)
        const width = text.length * LABEL_CHAR_WIDTH
        const middle = (toPx(span.start) + toPx(span.end)) / 2
        const from = Math.min(Math.max(middle - width / 2, left), right - width)
        groups.push([{ key: `r-${span.start}`, text, x: from, anchor: 'start', from, to: from + width }])
      }
    } else if (span.start !== undefined || span.end !== undefined) {
      groups.push([atTime((span.start ?? span.end)!)])
    }
  }
  groups.push(...edges.map((e) => [atTime(e.time, e.text)]))
  const labels: PlacedLabel[] = []
  const free = (l: PlacedLabel) => labels.every((k) => l.to + LANE_LABEL_SPACING <= k.from || l.from >= k.to + LANE_LABEL_SPACING)
  for (const group of groups) {
    if (group.every(free)) labels.push(...group)
  }
  const marks = spans.flatMap((s) => [s.start, s.end]).filter((t): t is number => t !== undefined).map(toPx)
  return { labels, marks }
}

// Phone view: horizontal lanes (HTML) sharing one time scale, labels in a left gutter
function TimelineLanes({ lanes, minTime, now, noDataLabel }: { lanes: Lane[]; minTime: number; now: number; noDataLabel: string }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  const pct = (time: number) => ((time - minTime) / (now - minTime)) * 100
  const toPx = (time: number) => (pct(time) / 100) * width

  return (
    <div className="timeline-lanes">
      {lanes.map((lane, idx) => (
        <div className="timeline-lane" key={lane.label}>
          <span className="timeline-lane-label">{lane.label}</span>
          <div className="timeline-lane-track" ref={idx === 0 ? trackRef : undefined}>
            {lane.segments.map((s) => (
              <span
                key={`${s.state}-${s.start}`}
                className="timeline-lane-segment"
                data-state={s.state}
                style={{ left: `${pct(s.start)}%`, width: `${pct(s.end) - pct(s.start)}%` }}
              >
                {s.state === 'unknown' && toPx(s.end) - toPx(s.start) >= LANE_NO_DATA_MIN_WIDTH && noDataLabel}
              </span>
            ))}
          </div>
          <div className="timeline-lane-ticks">
            {width > 0 &&
              (() => {
                const { labels, marks } = placeSpanLabels(lane.spans, lane.edges, lane.format, toPx, 0, width)
                return (
                  <>
                    {marks.map((px) => (
                      <span key={`m-${px}`} className="timeline-lane-mark" style={{ left: px }} />
                    ))}
                    {labels.map((l) => (
                      <span key={l.key} className="timeline-lane-tick" style={{ left: l.from }}>
                        {l.text}
                      </span>
                    ))}
                  </>
                )
              })()}
          </div>
        </div>
      ))}
    </div>
  )
}

// SVG time labels under a line at `y` (desktop chart axis and plan lane)
function TimeLabels({ labels, marks, y }: { labels: PlacedLabel[]; marks: number[]; y: number }) {
  return (
    <g>
      {marks.map((px) => (
        <line key={`m-${px}`} x1={px} x2={px} y1={y} y2={y + 3} stroke="var(--text-muted)" />
      ))}
      {labels.map((l) => (
        <text key={l.key} x={l.x} y={y + 4} textAnchor={l.anchor} dominantBaseline="hanging" fill="var(--text-muted)" fontSize={11}>
          {l.text}
        </text>
      ))}
    </g>
  )
}

const localeTag = (locale: Locale) => (locale === 'uk' ? 'uk-UA' : 'en')

export function HistoryChart({
  history,
  currentState,
  lastChanged,
  historyRange,
  schedule,
}: HistoryChartProps & { historyRange: HistoryRange }) {
  const { t, locale } = useTranslations()
  const isPhone = useMediaQuery(PHONE_QUERY)

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
    const outages = clip([...parseOutages(schedule), ...parseIntervals(recorded?.outages)])
    // Planned on/off times: only real transitions, i.e. with a known plan on both sides (not where
    // an outage is cut by the range edges or the start/end of the known schedule)
    const known = (time: number) => covered.some((c) => c.start < time && time < c.end)
    const spans: LabelSpan[] = outages.map((o) => ({
      start: known(o.start) ? o.start : undefined,
      end: known(o.end) ? o.end : undefined,
      duration: o.end - o.start,
    }))
    return { covered, unknown, outages, spans }
  }, [schedule, history, minTime, now])

  // Actual on/off/unknown runs, and the outages among them for the time labels: a start/end is
  // labelled only if it's a real change from/to 'on' (not the range edges or unknown data)
  const factSegments = useMemo(() => {
    const segments: Lane['segments'] = []
    for (let i = 0; i < timeline.length - 1; i++) {
      const last = segments[segments.length - 1]
      if (last && last.state === timeline[i].state) last.end = timeline[i + 1].time
      else segments.push({ start: timeline[i].time, end: timeline[i + 1].time, state: timeline[i].state })
    }
    return segments
  }, [timeline])
  const factSpans = useMemo(
    () =>
      factSegments.flatMap((seg, k): LabelSpan[] =>
        seg.state === 'off'
          ? [{
              start: factSegments[k - 1]?.state === 'on' ? seg.start : undefined,
              end: factSegments[k + 1]?.state === 'on' ? seg.end : undefined,
              duration: seg.end - seg.start,
            }]
          : [],
      ),
    [factSegments],
  )

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

  const formatClock = (time: number) =>
    new Date(time).toLocaleTimeString(localeTag(locale), { hour: '2-digit', minute: '2-digit' })

  // Actual times may need a date (multi-day ranges); a range's end then drops it if on the same day
  // An end on the start's day doesn't repeat the date
  const formatEnd = (start: number, end: number) =>
    new Date(start).toDateString() === new Date(end).toDateString() ? formatClock(end) : formatTime(end)
  const factFormat: LabelFormat = {
    time: formatTime,
    range: (start, end) => `${formatTime(start)}–${formatEnd(start, end)}`,
  }
  const planFormat: LabelFormat = { time: formatClock, range: (start, end) => `${formatClock(start)}–${formatClock(end)}` }

  // A live range ends now: say so, a plain time there reads like an outage start
  const factEdges: EdgeLabel[] = [
    { time: minTime, text: formatTime(minTime) },
    { time: now, text: live ? t('history.now') : formatTime(now) },
  ]

  // Phone view: actual and planned lanes
  const lanes: Lane[] = []
  if (isPhone) {
    lanes.push({ label: t('history.lane'), segments: factSegments, spans: factSpans, edges: factEdges, format: factFormat })
    if (scheduleLane) {
      lanes.push({
        label: t('schedule.lane'),
        segments: [
          ...scheduleLane.unknown.map((u) => ({ ...u, state: 'unknown' as const })),
          ...scheduleLane.covered.map((c) => ({ ...c, state: 'on' as const })),
          ...scheduleLane.outages.map((o) => ({ ...o, state: 'off' as const })),
        ],
        spans: scheduleLane.spans,
        edges: [],
        format: planFormat,
      })
    }
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

          {/* Every on/off period in the range as rows, newest first; collapsed by default */}
          <details className="segments-list">
            <summary className="segments-summary">
              {t('history.segments')} · {factSegments.length}
            </summary>
            <ul className="segments-rows">
              {[...factSegments].reverse().map((s) => (
                <li key={s.start} className="segments-row" data-state={s.state}>
                  <span className="segments-dot" aria-hidden />
                  <span className="segments-time">
                    {formatTime(s.start)} – {live && s.end === now ? t('history.now') : formatEnd(s.start, s.end)}
                  </span>
                  <span className="segments-state">{s.state === 'unknown' ? t('history.no_data') : t(`state.${s.state}`)}</span>
                  <span className="segments-duration">{formatDuration((s.end - s.start) / 1000, t)}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {isPhone ? (
        <TimelineLanes lanes={lanes} minTime={minTime} now={now} noDataLabel={t('history.no_data')} />
      ) : (
        <ResponsiveContainer width="100%" height={CHART_HEIGHT + laneSpace}>
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
                        const opacity = s.state === 'on' ? 0.4 : s.state === 'off' ? 0.02 : 0
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
                        <rect key={`c-${c.start}`} x={x(c.start)} y={y} width={x(c.end) - x(c.start)} height={LANE_HEIGHT} fill="var(--on-fill)" />
                      ))}
                      {scheduleLane.outages.map((o) => (
                        <rect key={`o-${o.start}`} x={x(o.start)} y={y} width={x(o.end) - x(o.start)} height={LANE_HEIGHT} fill="var(--off)" />
                      ))}
                      {(() => {
                        const { labels, marks } = placeSpanLabels(
                          scheduleLane.spans,
                          [],
                          planFormat,
                          x,
                          offset.left,
                          offset.left + offset.width,
                        )
                        return (
                          <TimeLabels labels={labels} marks={marks} y={y + LANE_HEIGHT} />
                        )
                      })()}
                    </g>
                  )
                }}
              />
            )}
            {/* Actual change times, drawn like the plan's (Recharts' own ticks would drop some of them) */}
            <Customized
              component={({ offset }: { offset?: { left: number; top: number; width: number; height: number } }) => {
                if (!offset) return null
                const x = (time: number) => offset.left + ((time - minTime) / (now - minTime)) * offset.width
                const { labels, marks } = placeSpanLabels(factSpans, factEdges, factFormat, x, offset.left, offset.left + offset.width)
                return <TimeLabels labels={labels} marks={marks} y={offset.top + offset.height} />
              }}
            />
            <XAxis dataKey="time" type="number" domain={[minTime, now]} scale="time" tick={false} stroke="var(--border)" />
            <YAxis
              domain={[0, 1]}
              ticks={[0, 1]}
              tickFormatter={(v) => (v === 1 ? t('state.on_history') : t('state.off_history'))}
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              stroke="var(--border)"
              width={52}
            />
            {/* Only the full chart has a tooltip (desktop, tablet, phone in landscape) */}
            {!isPhone && (
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
            )}
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
      )}
    </div>
  )
}
