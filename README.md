# Is It Up — grid power status page

**English** · [Українська](README.uk.md)

A small, mobile-first status page that answers one question for you and your neighbours: **is there power right now?**
It reads a grid power sensor from [Home Assistant](https://www.home-assistant.io/) and shows the current state, when it last changed, the actual outage history, and — optionally — the planned outage schedule (Ukraine, via [svitlo.live](https://github.com/chaichuk/svitlo_live)) side by side with what really happened.

Made for a residential complex in Ukraine during scheduled and emergency blackouts. Pretty much fully AI-generated, built for fun, but in daily use.

<table>
  <tr>
    <td width="68%"><img src="docs/desktop-dark.png" alt="Desktop, dark theme, Ukrainian"></td>
    <td width="32%"><img src="docs/phone-dark.png" alt="Phone, dark theme, Ukrainian"></td>
  </tr>
  <tr>
    <td><img src="docs/desktop-light.png" alt="Desktop, light theme, English"></td>
    <td><img src="docs/phone-light.png" alt="Phone, light theme, English"></td>
  </tr>
</table>

## Why

Home Assistant knows when the power goes out, but you don't want to give neighbours access to it. This app is a read-only public window onto a single sensor: the HA token stays on the server, and HA itself can stay on your home network or behind a VPN.

## Features

- **Current state** — on / off and for how long, plus the last change and how long the previous state lasted. Short `unavailable` blips in HA (e.g. while a template sensor reloads) don't break an outage into pieces.
- **Outage schedule** (optional) — today and tomorrow as an hour grid like DTEK's (each hour split into half-hours), the next scheduled outage with a countdown, and a banner when emergency outages are in effect and the schedule may not be followed.
- **Actual history** — today, yesterday, or the last 6 h … 7 days, with availability, total time without power, number of outages and their average length.
  - On a computer: a step chart with a **Plan** lane under it, so you can see at a glance whether outages followed the schedule.
  - On a phone: two compact lanes, **Actual** and **Plan**, on one time scale. Turn the phone to landscape to get the full chart.
  - Outage start/end times are labelled under both, in pairs (never just a start or just an end); outages too short for a label still get a tick mark.
- **Phone-friendly** — compact layout, no hover-only UI, refreshes as soon as you come back to the tab, state in the tab title (🟢 / 🔴), and can be added to the home screen as an app.
- Light / dark theme (follows the system), English / Ukrainian, refreshes every 30 s.

## How it works

```
Browser ──► nginx (frontend, :3033) ──/api──► FastAPI (backend, :8033) ──REST──► Home Assistant
```

- The **backend** is a thin proxy over the Home Assistant REST API (`/api/states`, `/api/history/period`, `/api/calendars`). The browser never sees the HA token.
- **Grid sensor** — any HA `binary_sensor` whose state is `on` when there's power and `off` when there isn't. For example: a template sensor built from a UPS "on battery" status, a ping sensor for a device that isn't on backup power, or a smart plug's availability.
- **History** comes from the HA recorder, so how far back you can look is HA's `purge_keep_days` (10 days by default), not something this app controls. Time before the sensor's first record is shown as "No data" — never guessed.
- **Schedule** comes from the [svitlo.live](https://github.com/chaichuk/svitlo_live) HACS integration (covers Ukraine, including Kyiv region / DTEK, where DTEK itself has no public API):
  - today/tomorrow are read from its status sensor;
  - the sensor doesn't say which date its schedule is for (after midnight it keeps yesterday's until the new day is published), so the backend checks it against the integration's calendar, which has real dates;
  - past days come from the calendar's recorded state in HA history — the schedule as it was in effect at the time. That history starts when you install the integration.

## Setup

### 1. Home Assistant

1. A grid power `binary_sensor` (see above).
2. A long-lived access token: your HA profile → **Security** → **Long-lived access tokens**.
3. *(Optional, for the schedule)* Install [svitlo.live](https://github.com/chaichuk/svitlo_live) via HACS and add your region and queue. It creates entities like `sensor.svitlo_kiivska_oblast_5_1_electricity` and `calendar.svitlo_kiivska_oblast_5_1_outages_schedule`.

### 2. Run with Docker

```bash
cp .env.example .env   # then fill in HA_BASE_URL, HA_TOKEN, GRID_ENTITY_ID (+ SCHEDULE_ENTITY_ID)
docker compose up -d --build
```

Open **http://localhost:3033**. The frontend's nginx proxies `/api` to the backend.
If the backend runs in Docker and HA is on the host's LAN, use `http://host.docker.internal:8123` or the HA IP.

### Environment variables

**Backend**

| Variable | Description | Example |
|---|---|---|
| `HA_BASE_URL` | Home Assistant URL | `http://192.168.1.10:8123` |
| `HA_TOKEN` | Long-lived access token | — |
| `GRID_ENTITY_ID` | Grid power binary sensor | `binary_sensor.grid_power` |
| `SCHEDULE_ENTITY_ID` | *Optional.* svitlo.live status sensor; enables the schedule card and the Plan lane | `sensor.svitlo_kiivska_oblast_5_1_electricity` |
| `SCHEDULE_CALENDAR_ID` | *Optional.* svitlo.live calendar, used to date the schedule and for past days. Derived from `SCHEDULE_ENTITY_ID` if unset | `calendar.svitlo_kiivska_oblast_5_1_outages_schedule` |

**Frontend** (optional, baked in at build time; passed as Docker build args)

| Variable | Description | Example |
|---|---|---|
| `VITE_APP_SUBTITLE` | Line under the title, e.g. your address or queue | `Kyiv region · queue 5.1` |
| `VITE_CONTACT_EMAIL` | Email in the Contact section (hidden if unset) | `you@example.com` |
| `VITE_GITHUB_REPO_URL` | Link to the repo in the footer | `https://github.com/...` |
| `VITE_BASE_PATH` | Base path if served from a subpath | `/` or `/is-it-up/` |
| `VITE_API_BASE` | Path to the API on the same host | `/api` |

Behind a reverse proxy (e.g. Nginx Proxy Manager), set `VITE_BASE_PATH` and `VITE_API_BASE` to the paths you route to the frontend and the backend.

### Add to the home screen

Open the page on your phone → **Share → Add to Home Screen** (iPhone) or the browser menu → **Add to Home screen** (Android). It opens like an app, without the address bar.

## Local development

```bash
# backend (needs HA_BASE_URL / HA_TOKEN / GRID_ENTITY_ID, e.g. `set -a; . ../.env; set +a`)
cd backend
poetry install
poetry run uvicorn app.main:app --reload --port 8000

# frontend (the Vite dev server proxies /api to localhost:8000)
cd frontend
npm install
npm run dev
npm run build   # tsc + vite build — the only type check
```

## API

| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `GET /api/state` | Current state of the grid sensor |
| `GET /api/last-change` | Last on/off change and how long the previous state lasted (ignoring `unavailable` blips) |
| `GET /api/history?hours=N` | State changes for a rolling window, `N` ∈ 6, 12, 24, 48, 72, 168 |
| `GET /api/history?start=<ISO>[&end=<ISO>]` | Same for a fixed window (with a timezone offset; max 168 h; `end` defaults to now). Includes `schedule_history` — the recorded schedule before today — when a schedule is configured |
| `GET /api/schedule` | Planned outages for today and tomorrow (Kyiv time), the emergency flag and the last update; `{"enabled": false}` if not configured |

## Tech stack

- **Backend:** Python 3.11+, FastAPI, httpx, pydantic-settings, Poetry
- **Frontend:** React 18, Vite, TypeScript, Recharts
- **Deploy:** Docker Compose (backend + frontend on nginx)
