# is-it-up-app V2 [ˈɪz ɪt ˈʌp ˈʌp]

Single-page mobile-friendly app that shows **Grid Power** state from Home Assistant: current state, last change time, and a time-series history chart. Dark/light mode supported.
Pretty much fully AI genarated app, so can have issues. Made for fun, but can be usefull.

- **Frontend**: React (Vite) + TypeScript, Recharts, theme toggle.
- **Backend**: Python FastAPI with Poetry; talks to Home Assistant via REST API (token). Frontend only talks to the API, so HA can stay on your home network or behind WireGuard.

## Quick start with Docker

1. Copy env example and set your HA details:

   ```bash
   cp .env.example .env
   # Edit .env: HA_BASE_URL, HA_TOKEN, GRID_ENTITY_ID
   ```

2. Run:

   ```bash
   docker compose up --build
   ```

3. Open **http://localhost:3000** (frontend). The frontend proxies `/api` to the backend.

### Env vars

**Backend**

| Variable         | Description                          | Example                    |
|------------------|--------------------------------------|----------------------------|
| `HA_BASE_URL`    | Home Assistant URL                   | `http://192.168.1.10:8123` |
| `HA_TOKEN`       | Long-Lived Access Token from HA       | From Profile → Tokens      |
| `GRID_ENTITY_ID` | Entity ID for grid power (binary)    | `binary_sensor.grid_power` |

**Frontend** (build time, optional)

| Variable               | Description                                      | Example        |
|------------------------|--------------------------------------------------|----------------|
| `VITE_CONTACT_EMAIL`   | Email shown in Contact section                   | `your@email.com` |
| `VITE_GITHUB_REPO_URL` | Link to GitHub repo (shown in footer)            | `https://github.com/...` |
| `VITE_BASE_PATH`     | Base path when app is served from a subpath      | `/` or `/is-it-up/` |
| `VITE_API_BASE`      | Path to API on same host (you route this in NPM)  | `/api`         |

Same host: set `VITE_BASE_PATH` and `VITE_API_BASE` to the paths you use in Nginx Proxy Manager; NPM routes those paths to this app (frontend) and to the backend (API). If unset, Contact section is hidden; base path is `/` and API path is `/api`.

If the backend runs in Docker and HA is on the host LAN, use `http://host.docker.internal:8123` (or your HA IP). For HA on another machine (e.g. WireGuard), use that machine’s URL.

## Local development

### Backend (Poetry)

```bash
cd backend
poetry install
# Set HA_BASE_URL, HA_TOKEN, GRID_ENTITY_ID in .env or shell
poetry run uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Vite proxies `/api` to `http://localhost:8000`, so use **http://localhost:5173** and the app will call your local backend.

## API (backend)

- `GET /health` – health check
- `GET /api/state` – current state of the grid entity
- `GET /api/history?hours=24` – state change history (1–168 hours)
- `GET /api/last-change` – last on/off change time and state

## Tech stack

- **Backend**: Python 3.11+, FastAPI, httpx, pydantic-settings, Poetry.
- **Frontend**: React 18, Vite, TypeScript, Recharts.
- **Deploy**: Docker + docker-compose (backend + frontend with nginx).
