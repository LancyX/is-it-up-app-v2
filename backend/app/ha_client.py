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


def get_last_change() -> dict[str, Any] | None:
    """Get the most recent state change (on/off) time from current state."""
    state = get_current_state()
    last_changed = state.get("last_changed") or state.get("last_updated")
    if not last_changed:
        return None
    
    result = {
        "state": state.get("state", "unknown"),
        "last_changed": last_changed,
        "friendly_name": state.get("attributes", {}).get("friendly_name"),
    }

    # Try to find the previous state to calculate duration.
    # Look back as far as the longest history range the chart offers (MAX_HISTORY_HOURS),
    # so a long-running outage doesn't silently disappear from this card.
    try:
        current_start = datetime.fromisoformat(last_changed.replace("Z", "+00:00"))
        search_start = current_start - timedelta(hours=MAX_HISTORY_HOURS)
        history_list = _fetch_history_period(search_start, current_start)

        if history_list:
            # Filter out changes that happened AT or AFTER the current state change
            # (HA might return the transition to current state as the last item)
            current_ts = current_start.timestamp()
            valid_history = [
                h for h in history_list
                if _parse_ts(h.get("last_changed") or h.get("last_updated")) < current_ts - 1.0  # 1s buffer
            ]

            if valid_history:
                # The previous state started at the earliest item of the trailing run with
                # that same state (HA can record repeated items with an unchanged state)
                prev_state = valid_history[-1].get("state")
                prev = valid_history[-1]
                for h in reversed(valid_history):
                    if h.get("state") != prev_state:
                        break
                    prev = h
                prev_ts_str = prev.get("last_changed") or prev.get("last_updated")

                if prev_ts_str:
                    prev_ts = datetime.fromisoformat(prev_ts_str.replace("Z", "+00:00"))
                    duration_sec = (current_start - prev_ts).total_seconds()
                    result["previous_state"] = prev_state
                    result["previous_duration_sec"] = duration_sec
    except Exception:
        # Ignore errors in fetching previous state, it's optional
        pass

    return result
