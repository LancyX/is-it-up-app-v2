"""FastAPI app - exposes Grid Power state and history from Home Assistant."""

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app import ha_client

# Run sync HA calls in thread pool to not block event loop
import asyncio
from concurrent.futures import ThreadPoolExecutor

_executor = ThreadPoolExecutor(max_workers=2)


async def run_sync(fn, *args, **kwargs):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_executor, lambda: fn(*args, **kwargs))


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    _executor.shutdown(wait=True)


app = FastAPI(
    title="Is It Up API",
    description="Proxy for Home Assistant Grid Power entity",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/api/state")
async def get_state():
    """Current state of the Grid Power entity."""
    try:
        data = await run_sync(ha_client.get_current_state)
        return {
            "entity_id": data.get("entity_id"),
            "state": data.get("state"),
            "last_changed": data.get("last_changed"),
            "last_updated": data.get("last_updated"),
            "attributes": data.get("attributes", {}),
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Home Assistant error: {str(e)}")


ALLOWED_HOURS = [6, 12, 24, 48, 72, 168]


@app.get("/api/history")
async def get_history(
    hours: int | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
):
    """State change history for the grid entity (time series for chart).

    Either `hours` (rolling window ending now) or `start` [+ `end`] (fixed window, e.g. a
    calendar day in the client's timezone; `end` defaults to now and is capped at now).
    """
    now = datetime.now(timezone.utc)
    if start is None:
        if end is not None:
            raise HTTPException(status_code=400, detail="end requires start")
        hours = 24 if hours is None else hours
        if hours not in ALLOWED_HOURS:
            raise HTTPException(status_code=400, detail=f"hours must be one of: {', '.join(map(str, ALLOWED_HOURS))}")
        start, end = now - timedelta(hours=hours), now
    else:
        if hours is not None:
            raise HTTPException(status_code=400, detail="use either hours or start/end")
        if start.tzinfo is None or (end is not None and end.tzinfo is None):
            raise HTTPException(status_code=400, detail="start/end must include a timezone offset")
        end = min(end or now, now)
        if not start < end or end - start > timedelta(hours=ha_client.MAX_HISTORY_HOURS):
            raise HTTPException(
                status_code=400,
                detail=f"start must be before end, at most {ha_client.MAX_HISTORY_HOURS} hours apart",
            )
    try:
        data = await run_sync(ha_client.get_history, start, end)
        return {
            "entity_id": settings.grid_entity_id,
            # Lets the client recognise HA's initial-state item (stamped exactly at start)
            # even if the client clock differs from the server's.
            "start": start.isoformat(),
            "history": [
                {
                    "state": h.get("state"),
                    "last_changed": h.get("last_changed") or h.get("last_updated"),
                }
                for h in data
            ],
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Home Assistant error: {str(e)}")


@app.get("/api/last-change")
async def get_last_change():
    """Last on/off change time and current state."""
    try:
        data = await run_sync(ha_client.get_last_change)
        return data or {}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Home Assistant error: {str(e)}")
