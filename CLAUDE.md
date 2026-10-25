# CLAUDE.md

Single-page status app showing a Home Assistant binary sensor (grid power: on/off) — current state, last change, and a history chart with stats. See README.md for setup and env vars.

## Layout

- `backend/` — FastAPI (Poetry, Python 3.11+). Thin proxy over the HA REST API; HA token never reaches the browser.
  - `app/ha_client.py` — sync `httpx` calls to HA (`/api/states/<id>`, `/api/history/period/<start>`). Run from async routes via a thread pool (`run_sync` in `main.py`).
  - `app/schedule.py` — DTEK's outage schedule (see below); not via HA.
  - `ha_client.get_address_status` — DTEK Monitor's sensors for the address (see below).
  - `app/main.py` — runs the schedule poller (lifespan task, every `POLL_SECONDS`); routes: `/health`, `/api/state`, `/api/history?hours=N` or `?start=…[&end=…]`, `/api/last-change`, `/api/schedule`, `/api/address`.
  - `app/config.py` — `pydantic-settings`, env vars without prefix (`HA_BASE_URL`, `HA_TOKEN`, `GRID_ENTITY_ID`, optional `SCHEDULE_REGION` / `SCHEDULE_QUEUE` / `SCHEDULE_DTEK_URL` / `SCHEDULE_EMERGENCY_API_URL` / `ADDRESS_ENTITY_ID` / `DATA_DIR`).
- `frontend/` — React 18 + Vite + TypeScript + Recharts. No router, no state library.
  - `App.tsx` — fetches all endpoints every 30 s; owns the selected history range. `/api/schedule` is fetched separately so its failure doesn't hide the page.
  - `DtekNotices.tsx` — DTEK alerts under the state card: region emergency + address outage (see below).
  - `ScheduleCard.tsx` — planned outage schedule: DTEK-style hour grid with half-hour halves (hover shows exact times), next outage.
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

## Outage schedule (DTEK)

- Optional: `SCHEDULE_REGION` (outage-data-ua file id: `kyiv-region`, `kyiv`, `dnipro`, `odesa`; the svitlo.live-style `kiivska-oblast` etc. used before are mapped via `DTEK_FILES`) + `SCHEDULE_QUEUE` (e.g. `5.1`). Either empty → `/api/schedule` returns `{"enabled": false}` and the UI hides the card/overlay.
- Source: DTEK's own schedule (what its sites/bot show) via github.com/Baskerville42/outage-data-ua, a scraper committing every ~5 min (DTEK's sites are behind Incapsula). `SCHEDULE_DTEK_URL`, or derived from the region. `fact.data`: `{<Kyiv midnight, unix>: {"GPV5.1": {"1".."24": yes|no|first|second}}}` (`"1"` = 00:00–01:00; first/second = off for that half); `fact.update` = DTEK's own update time ("25.10.2026 10:02", Kyiv), returned as `updated`. `maybe`/`mfirst`/`msecond` are only in the weekly `preset`. svitlo.live's schedule was used before and removed (it often differed from DTEK's).
- Emergency outages in the region (ГАВ, the schedule may not be followed): `emergency` in `/api/schedule`, from the DTEK proxy behind svitlo.live (`SCHEDULE_EMERGENCY_API_URL`, the only place this flag is published; payload JSON-encoded in `body`; region ids differ — `EMERGENCY_REGIONS`), fetched in `refresh`, only trusted when its `date_today` is today (it can lag a day). Independent of the address status: `DtekNotices` shows either or both, only when set.
- Internally each day is 48 half-hour digits from Kyiv midnight (0 = not published, 1 = on, 2 = outage), converted to UTC intervals (DST-safe: wall-clock arithmetic) and merged across midnight. Wall-clock hours mean the repeated hour when clocks go back can't be told apart (`ScheduleCard` groups hour cells by clock hour, so it's one cell).
- `main.py` polls `schedule.refresh` every 5 min, also with nobody watching; `/api/schedule` serves the last successful fetch. It always returns today/tomorrow (Kyiv) in `days`; `ScheduleCard` ignores ended days and names days by date, not position.
- Past schedule: every new version of each day's slots is appended to `DATA_DIR/schedule.json` (`{"dtek": {"YYYY-MM-DD": [{"from": iso, "slots": "0112…"}]}}`; anything else in it is old svitlo.live data, ignored and dropped on the next write; kept `KEEP_DAYS`; a Docker volume). A version applies from when it was first seen until the next one; the first one covers the whole day. `/api/history` includes it as `schedule_history` (`covered` / `outages`, via `schedule.get_schedule_history`) for the part of the range before today's Kyiv midnight — from today on the current schedule is used, so an unpublished today stays empty rather than looking "on by schedule". Only known since the app started recording; failures return `null` without failing the history.
- The history chart's "Plan" lane (drawn under the X axis via `<Customized>`, same time scale as the plot; planned outage start/end times are labelled under it) merges the current schedule's published days with `schedule_history` and is hidden when nothing in the range is known; unknown stretches are drawn like the chart's "No data" areas. Time labels are drawn only for transitions with a known plan on both sides.
- Time labels (plan lane, and the actual change times — the X axis has `tick={false}`, since Recharts' own ticks drop some at random) come from `placeSpanLabels`: an outage's start and end are shown together or not at all (two labels, or one "start–end" when it's short), outages longest first, then the range edges (a live range's end reads "now", not a time that looks like an outage start), skipping ones that would overlap (widths estimated from text length). Every boundary still gets a tick mark. Used by the desktop SVG (`TimeLabels`) and the phone lanes.

## DTEK status for the address (DTEK Monitor)

- Optional: `ADDRESS_ENTITY_ID` = the `sensor.dtek_krem_<id>_outage_status` of the DTEK Monitor HACS integration (groove-max/ha-dtek-monitor; it reads DTEK's per-address lookup — DTEK's site is behind Incapsula, that integration gets through, NetZhizni/ha-dtek-krem-outages got blocked within minutes, so it isn't used). Siblings are derived by suffix (`ADDRESS_SENSORS`: `_outage_description`, `_outage_start`, `_outage_end` = estimated restoration, `_dtek_connection`). Empty → `/api/address` returns `{"enabled": false}`.
- `outage_status`: `ok` / `emergency` / `planned` (repair works) / `stabilization` (by schedule). `DtekNotices` shows nothing for the address unless `connected` (its last request to DTEK went through — otherwise `ok` may be stale); a non-`ok` status is a red banner with DTEK's description, start and estimated restoration; `ok` shows nothing (the user asked not to show "DTEK reports nothing" — accidents announced elsewhere often don't show up here, nor in DTEK's bot).
- Fetched separately in `App.tsx`, like the schedule, so a failure doesn't hide the page.

## Conventions

- History ranges (`HistoryRange` in `utils.ts`): rolling `hours` windows whitelisted in `main.py` (`ALLOWED_HOURS`; must match the `<select>` in `App.tsx` and `MAX_HISTORY_HOURS` in `ha_client.py`), or `'today'`/`'yesterday'` — calendar days in the browser's timezone, sent as `start`/`end` ISO params. `getRangeBounds` is the single source for a range's start/end; `live: false` (yesterday) means the current state must not be applied at the range end.
- Chart colours are horizontal gradients defined in plot-area pixels (`gradientUnits="userSpaceOnUse"`, rendered via `<Customized>` to get Recharts' `offset`). Don't switch back to the default `objectBoundingBox`: a flat line has a zero-height box and SVG won't paint it. Segments are hidden via stop opacity.
- Current state and last change are one card with two columns on every screen (`.cards-grid` in `App.css` strips the inner `.card` chrome). The last change card doesn't repeat the new state (it's the current state next to it); the previous state is coloured.
- On phones (`max-width: 599px` in `App.css`) that card is just tighter, and the history stats become one block of label/value rows, purely in CSS (`.stats-grid`); from 600px they're three badges side by side.
- Phone-friendly bits: `text-size-adjust: 100%` in `index.css` (iOS Safari otherwise enlarges text in landscape); less padding for short landscape screens; tighter padding under 600px (`App.css`); at the same breakpoint (`useMediaQuery(PHONE_QUERY)`, live, so rotating to landscape shows the chart) the history is shown as two lanes, "Факт" and "Графік" (`TimelineLanes` in `HistoryChart.tsx`, HTML, same `placeSpanLabels` labels), instead of the Recharts chart; the history chart's tooltip exists only with the full chart (not the phone lanes), so landscape phones get it too; `App.tsx` reloads on `visibilitychange` (timers pause in background tabs) and sets `document.title` to the localized app name (no state in it: phones freeze background tabs, so it'd go stale); `theme.tsx` syncs `<meta name="theme-color">` with `--bg`. Home-screen install: `public/manifest.webmanifest` + `icon-192/512.png`, `apple-touch-icon.png` (rendered from `public/icon.svg`).
- Colours come from CSS variables in `index.css` (`--on`, `--off`, `--text-muted`, …) with light/dark variants; don't hardcode colours in components.
- Frontend build-time config is via `VITE_*` env vars (see README); they're baked in at build, passed as Docker build args.
