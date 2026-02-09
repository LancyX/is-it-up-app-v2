"""FastAPI app - exposes Grid Power state and history from Home Assistant."""

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app import ha_client

# Run sync HA calls in thread pool to not block event loop
import asyncio
from concurrent.futures import ThreadPoolExecutor

_executor = ThreadPoolExecutor(max_workers=2)


async def run_sync(fn, *args, **kwargs):
    loop = asyncio.get_event_loop()
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
    allow_credentials=True,
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


@app.get("/api/history")
async def get_history(hours: int = 24):
    """State change history for the grid entity (time series for chart)."""
    if hours not in [6, 12, 24, 48]:
        raise HTTPException(status_code=400, detail="hours must be one of: 6, 12, 24, 48")
    try:
        data = await run_sync(ha_client.get_history, hours)
        return {
            "entity_id": settings.grid_entity_id,
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
