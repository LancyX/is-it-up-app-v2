"""Home Assistant API client - fetches state and history for Grid Power entity."""

from datetime import datetime, timedelta
from typing import Any

import httpx

from app.config import settings


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.ha_token}",
        "Content-Type": "application/json",
    }


def get_current_state() -> dict[str, Any]:
    """Fetch current state of the grid entity from Home Assistant."""
    url = f"{settings.ha_base_url.rstrip('/')}/api/states/{settings.grid_entity_id}"
    with httpx.Client(timeout=10.0) as client:
        resp = client.get(url, headers=_headers())
        resp.raise_for_status()
        return resp.json()


def get_history(hours: int = 24) -> list[dict[str, Any]]:
    """Fetch state history for the grid entity. Returns list of state changes."""
    end = datetime.utcnow()
    start = end - timedelta(hours=hours)
    url = f"{settings.ha_base_url.rstrip('/')}/api/history/period"
    params = {
        "filter_entity_id": settings.grid_entity_id,
        "minimal_response": "true",
        "end_time": end.isoformat(),
        "no_attributes": "true",
    }
    with httpx.Client(timeout=15.0) as client:
        resp = client.get(url, headers=_headers(), params=params)
        resp.raise_for_status()
        data = resp.json()
    # API returns list of lists (one list per entity); we have one entity
    if not data or not data[0]:
        return []
    history = data[0]
    # Filter to requested time range (HA may return more)
    start_ts = start.timestamp()
    return [h for h in history if _parse_ts(h.get("last_updated") or h.get("last_changed")) >= start_ts]


def _parse_ts(iso_str: str) -> float:
    try:
        return datetime.fromisoformat(iso_str.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def get_last_change() -> dict[str, Any] | None:
    """Get the most recent state change (on/off) time from current state."""
    state = get_current_state()
    last_changed = state.get("last_changed") or state.get("last_updated")
    if not last_changed:
        return None
    return {
        "state": state.get("state", "unknown"),
        "last_changed": last_changed,
        "friendly_name": state.get("attributes", {}).get("friendly_name"),
    }
