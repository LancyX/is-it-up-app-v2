"""Home Assistant API client - fetches state and history for Grid Power entity."""

from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from app.config import settings


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.ha_token}",
        "Content-Type": "application/json",
    }


MAX_HISTORY_HOURS = 168  # keep in sync with the largest option in main.py's `hours` whitelist


def get_current_state() -> dict[str, Any]:
    """Fetch current state of the grid entity from Home Assistant."""
    url = f"{settings.ha_base_url.rstrip('/')}/api/states/{settings.grid_entity_id}"
    with httpx.Client(timeout=10.0) as client:
        resp = client.get(url, headers=_headers())
        resp.raise_for_status()
        return resp.json()


def _fetch_history_period(start: datetime, end: datetime) -> list[dict[str, Any]]:
    """Fetch raw state-change history for the grid entity between start and end (both tz-aware)."""
    url = f"{settings.ha_base_url.rstrip('/')}/api/history/period/{start.isoformat()}"
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
    return data[0]


def get_history(hours: int = 24) -> tuple[datetime, list[dict[str, Any]]]:
    """Fetch state history for the grid entity. Returns (requested start, list of state changes)."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    # We do NOT filter the result by start_ts because HA returns the "initial state"
    # as the first element, with its timestamp clamped to start_ts. We need this!
    return start, _fetch_history_period(start, end)


def _parse_ts(iso_str: str) -> float:
    try:
        return datetime.fromisoformat(iso_str.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


KNOWN_STATES = ("on", "off")


def get_last_change() -> dict[str, Any] | None:
    """Get the most recent real on/off change and the period before it.

    'unavailable'/'unknown' readings are ignored, so off -> unavailable -> off is one continuous
    'off' period (same rule as the history chart). HA's own last_changed resets on every such
    blip, so it's only used as a fallback.
    """
    state = get_current_state()
    last_changed = state.get("last_changed") or state.get("last_updated")
    if not last_changed:
        return None

    result = {
        "state": state.get("state", "unknown"),
        "last_changed": last_changed,
        "friendly_name": state.get("attributes", {}).get("friendly_name"),
    }

    # Look back twice the longest chart range (MAX_HISTORY_HOURS), so the previous period is
    # still found when the current one has lasted up to that long.
    try:
        end = datetime.now(timezone.utc)
        history_list = _fetch_history_period(end - timedelta(hours=2 * MAX_HISTORY_HOURS), end)
        items = [(h.get("state"), h.get("last_changed") or h.get("last_updated")) for h in history_list]
        # The current state may be newer than the history snapshot
        if not items or _parse_ts(last_changed) > _parse_ts(items[-1][1] or ""):
            items.append((state.get("state"), last_changed))

        # Collapse into runs of consecutive known states: [(state, run start)]
        runs: list[tuple[str, str]] = []
        for item_state, ts in items:
            if item_state not in KNOWN_STATES or not ts:
                continue
            if not runs or runs[-1][0] != item_state:
                runs.append((item_state, ts))

        if runs:
            result["state"], result["last_changed"] = runs[-1]
        if len(runs) >= 2:
            prev_state, prev_ts = runs[-2]
            result["previous_state"] = prev_state
            result["previous_duration_sec"] = _parse_ts(runs[-1][1]) - _parse_ts(prev_ts)
    except Exception:
        # Fall back to HA's raw current state; the previous period is optional
        pass

    return result
