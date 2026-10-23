# CLAUDE.md

Single-page status app showing a Home Assistant binary sensor (grid power: on/off) — current state, last change, and a history chart with stats. See README.md for setup and env vars.

## Layout

- `backend/` — FastAPI (Poetry, Python 3.11+). Thin proxy over the HA REST API; HA token never reaches the browser.
  - `app/ha_client.py` — sync `httpx` calls to HA (`/api/states/<id>`, `/api/history/period/<start>`). Run from async routes via a thread pool (`run_sync` in `main.py`).
  - `app/schedule.py` — outage schedule straight from the svitlo.live API (see below); not via HA.
  - `app/main.py` — runs the schedule poller (lifespan task, every `POLL_SECONDS`); routes: `/health`, `/api/state`, `/api/history?hours=N` or `?start=…[&end=…]`, `/api/last-change`, `/api/schedule`.
  - `app/config.py` — `pydantic-settings`, env vars without prefix (`HA_BASE_URL`, `HA_TOKEN`, `GRID_ENTITY_ID`, optional `SCHEDULE_REGION` / `SCHEDULE_QUEUE` / `SCHEDULE_API_URL` / `SCHEDULE_EMERGENCY_API_URL` / `DATA_DIR`).
- `frontend/` — React 18 + Vite + TypeScript + Recharts. No router, no state library.
  - `App.tsx` — fetches all endpoints every 30 s; owns the selected history range. `/api/schedule` is fetched separately so its failure doesn't hide the page.
  - `ScheduleCard.tsx` — planned outage schedule: DTEK-style hour grid with half-hour halves (hover shows exact times), next outage, emergency banner.
  - `HistoryChart.tsx` — builds the timeline, gradient, and stats (all logic lives here), plus a collapsible list of all on/off periods in the range (`factSegments`, newest first) as the last item of the stats grid.
  - `i18n.tsx` — `en` / `uk` strings in one object; every new key must be added to both.
  - `utils.ts` — `formatDuration`, `normalizeState`, `HistoryRange` / `getRangeBounds`.
- `docker-compose.yml` — backend on :8033, frontend (nginx, proxies `/api/` to backend) on :3033.

## Commands

```bash
# backend (needs HA_BASE_URL / HA_TOKEN / GRID_ENTITY_ID, e.g. `set -a; . ../.env; set +a`)
cd backend && poetry install && poetry run uvicorn app.main:app --reload --port 8000

# frontend (Vite dev server proxies /api to localhost:8000)
cd frontend && npm install && npm run dev
npm run build   # tsc -b + vite build — the only type check; there is no linter or test suite

docker compose up --build
```

## Home Assistant behaviour to keep in mind

- `/api/history/period/<start>` defaults `end_time` to start + 1 day — always pass `end_time`.
- HA returns the state at `start` as the first item, with `last_changed` clamped to exactly `start`. The backend returns that `start` in `/api/history`, and the chart uses it (not the browser clock) to recognise that item.
- If the first item is later than `start`, HA has no older record (purged, or the entity was recreated, e.g. after deleting/re-adding a template helper). The chart shows that stretch as "no data" — never guess it from the next state.
- States other than `on`/`off` (`unavailable`, `unknown`) are normalised to `'unknown'` via `normalizeState`. They carry the previous known state forward (off → unavailable → off is one outage): in the chart/stats (`HistoryChart.tsx`) and in both cards (`get_last_change` in `ha_client.py` collapses history into on/off runs; `App.tsx` feeds its state/time to `StateCard`). HA's raw `last_changed` resets on every such blip, so don't use it for durations. Only a stretch with no earlier known state shows as "no data" / grey "Unavailable".
- History retention is HA's recorder setting (`purge_keep_days`, default 10), not something this app controls.

## Outage schedule (svitlo.live)

- Optional: `SCHEDULE_REGION` (the API's `cpu` id, e.g. `kiivska-oblast`) + `SCHEDULE_QUEUE` (e.g. `5.1`). Either empty → `/api/schedule` returns `{"enabled": false}` and the UI hides the card/overlay.
- Source: `SCHEDULE_API_URL` (`svitlo-proxy.svitlo-proxy.workers.dev`, unofficial, what svitlo.live's site shows): `{date_today, date_tomorrow, regions: [{cpu, schedule: {queue: {"YYYY-MM-DD": {"00:00": 0|1|2, …}}}}]}`, 48 half-hour slots from Kyiv midnight, 0 = not published, 1 = on, 2 = outage. Slots are converted to UTC intervals (DST-safe) and merged across midnight. Not the svitlo.live HA integration any more: for Kyiv region it reads a DTEK proxy that can lag a whole day behind the site.
- `main.py` polls `schedule.refresh` every 5 min, also with nobody watching; `/api/schedule` serves the last successful fetch (`updated` = its time). It always returns today/tomorrow (Kyiv) in `days`; `ScheduleCard` ignores ended days and names days by date, not position.
- Emergency outages (ГАВ, the schedule may not be followed — shown as a banner): the `emergency` flag of the region in the DTEK proxy (`SCHEDULE_EMERGENCY_API_URL`, payload JSON-encoded in `body`, a few region ids spelled differently — `EMERGENCY_REGION_ALIASES`), only trusted when its `date_today` is today.
- Past schedule: every new version of each day's slots is appended to `DATA_DIR/schedule.json` (`{"YYYY-MM-DD": [{"from": iso, "slots": "0112…"}]}`, kept `KEEP_DAYS`; a Docker volume). A version applies from when it was first seen until the next one; the first one covers the whole day. `/api/history` includes it as `schedule_history` (`covered` / `outages`, via `schedule.get_schedule_history`) for the part of the range before today's Kyiv midnight — from today on the current schedule is used, so an unpublished today stays empty rather than looking "on by schedule". Only known since the app started recording; failures return `null` without failing the history.
- The history chart's "Plan" lane (drawn under the X axis via `<Customized>`, same time scale as the plot; planned outage start/end times are labelled under it) merges the current schedule's published days with `schedule_history` and is hidden when nothing in the range is known; unknown stretches are drawn like the chart's "No data" areas. Time labels are drawn only for transitions with a known plan on both sides.
- Time labels (plan lane, and the actual change times — the X axis has `tick={false}`, since Recharts' own ticks drop some at random) come from `placeSpanLabels`: an outage's start and end are shown together or not at all (two labels, or one "start–end" when it's short), outages longest first, then the range edges (a live range's end reads "now", not a time that looks like an outage start), skipping ones that would overlap (widths estimated from text length). Every boundary still gets a tick mark. Used by the desktop SVG (`TimeLabels`) and the phone lanes.

## Conventions

- History ranges (`HistoryRange` in `utils.ts`): rolling `hours` windows whitelisted in `main.py` (`ALLOWED_HOURS`; must match the `<select>` in `App.tsx` and `MAX_HISTORY_HOURS` in `ha_client.py`), or `'today'`/`'yesterday'` — calendar days in the browser's timezone, sent as `start`/`end` ISO params. `getRangeBounds` is the single source for a range's start/end; `live: false` (yesterday) means the current state must not be applied at the range end.
- Chart colours are horizontal gradients defined in plot-area pixels (`gradientUnits="userSpaceOnUse"`, rendered via `<Customized>` to get Recharts' `offset`). Don't switch back to the default `objectBoundingBox`: a flat line has a zero-height box and SVG won't paint it. Segments are hidden via stop opacity.
- Current state and last change are one card with two columns on every screen (`.cards-grid` in `App.css` strips the inner `.card` chrome). The last change card doesn't repeat the new state (it's the current state next to it); the previous state is coloured.
- On phones (`max-width: 599px` in `App.css`) that card is just tighter, and the history stats become one block of label/value rows, purely in CSS (`.stats-grid`); from 600px they're three badges side by side.
- Phone-friendly bits: `text-size-adjust: 100%` in `index.css` (iOS Safari otherwise enlarges text in landscape); less padding for short landscape screens; tighter padding under 600px (`App.css`); at the same breakpoint (`useMediaQuery(PHONE_QUERY)`, live, so rotating to landscape shows the chart) the history is shown as two lanes, "Факт" and "Графік" (`TimelineLanes` in `HistoryChart.tsx`, HTML, same `placeSpanLabels` labels), instead of the Recharts chart; the history chart's tooltip exists only with the full chart (not the phone lanes), so landscape phones get it too; `App.tsx` reloads on `visibilitychange` (timers pause in background tabs) and sets `document.title` to the localized app name (no state in it: phones freeze background tabs, so it'd go stale); `theme.tsx` syncs `<meta name="theme-color">` with `--bg`. Home-screen install: `public/manifest.webmanifest` + `icon-192/512.png`, `apple-touch-icon.png` (rendered from `public/icon.svg`).
- Colours come from CSS variables in `index.css` (`--on`, `--off`, `--text-muted`, …) with light/dark variants; don't hardcode colours in components.
- Frontend build-time config is via `VITE_*` env vars (see README); they're baked in at build, passed as Docker build args.
