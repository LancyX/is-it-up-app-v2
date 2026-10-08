# CLAUDE.md

Single-page status app showing a Home Assistant binary sensor (grid power: on/off) — current state, last change, and a history chart with stats. See README.md for setup and env vars.

## Layout

- `backend/` — FastAPI (Poetry, Python 3.11+). Thin proxy over the HA REST API; HA token never reaches the browser.
  - `app/ha_client.py` — sync `httpx` calls to HA (`/api/states/<id>`, `/api/history/period/<start>`). Run from async routes via a thread pool (`run_sync` in `main.py`).
  - `app/main.py` — routes: `/health`, `/api/state`, `/api/history?hours=N` or `?start=…[&end=…]`, `/api/last-change`.
  - `app/config.py` — `pydantic-settings`, env vars without prefix (`HA_BASE_URL`, `HA_TOKEN`, `GRID_ENTITY_ID`).
- `frontend/` — React 18 + Vite + TypeScript + Recharts. No router, no state library.
  - `App.tsx` — fetches all three endpoints every 30 s; owns the selected history range.
  - `HistoryChart.tsx` — builds the timeline, gradient, and stats (all logic lives here).
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

## Conventions

- History ranges (`HistoryRange` in `utils.ts`): rolling `hours` windows whitelisted in `main.py` (`ALLOWED_HOURS`; must match the `<select>` in `App.tsx` and `MAX_HISTORY_HOURS` in `ha_client.py`), or `'today'`/`'yesterday'` — calendar days in the browser's timezone, sent as `start`/`end` ISO params. `getRangeBounds` is the single source for a range's start/end; `live: false` (yesterday) means the current state must not be applied at the range end.
- Chart colours are horizontal gradients defined in plot-area pixels (`gradientUnits="userSpaceOnUse"`, rendered via `<Customized>` to get Recharts' `offset`). Don't switch back to the default `objectBoundingBox`: a flat line has a zero-height box and SVG won't paint it. Segments are hidden via stop opacity.
- Colours come from CSS variables in `index.css` (`--on`, `--off`, `--text-muted`, …) with light/dark variants; don't hardcode colours in components.
- Frontend build-time config is via `VITE_*` env vars (see README); they're baked in at build, passed as Docker build args.
