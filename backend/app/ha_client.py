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
    history = data[0]
    # Filter to requested time range (HA may return more)
    # We do NOT filter by start_ts because HA returns the "initial state" 
    # as the first element, often with a timestamp < start_ts. We need this!
    return history


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

    # Try to find the previous state to calculate duration
    try:
        current_start = datetime.fromisoformat(last_changed.replace("Z", "+00:00"))
        # Look back up to 48 hours for the previous change
        search_start = current_start - timedelta(hours=48)
        
        url = f"{settings.ha_base_url.rstrip('/')}/api/history/period/{search_start.isoformat()}"
        params = {
            "filter_entity_id": settings.grid_entity_id,
            "end_time": current_start.isoformat(),
            "minimal_response": "true",
            "no_attributes": "true",
        }
        
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(url, headers=_headers(), params=params)
            if resp.status_code == 200:
                data = resp.json()
                if data and data[0]:
                    # The history list ends at 'end_time' (current_start). 
                    # The last items in the list effectively represent the state *before* current_start.
                    # We want the last element that has a DIFFERENT state than current.
                    # But wait, history/period returns changes. 
                    # The last element in the list *should* be the start of the previous state 
                    # (assuming we didn't miss it by looking back only 48h).
                    # Actually, we just want the *last* element in the returned history.
                    # This element represents the transition TO the state that existed just before current_last_changed.
                    
                    history_list = data[0]
                    # We need to filter out any entries that might be identical to current state (if any)
                    # or just take the last one.
                    if history_list:
                         # Filter out changes that happened AT or AFTER the current state change
                         # (HA might return the transition to current state as the last item)
                         current_ts = current_start.timestamp()
                         valid_history = [
                             h for h in history_list 
                             if _parse_ts(h.get("last_changed") or h.get("last_updated")) < current_ts - 1.0 # 1s buffer
                         ]

                         if valid_history:
                             # The last valid item is the start of the previous state
                             prev = valid_history[-1]
                             prev_ts_str = prev.get("last_changed") or prev.get("last_updated")
                             prev_state = prev.get("state")
                             
                             if prev_ts_str:
                                 prev_ts = datetime.fromisoformat(prev_ts_str.replace("Z", "+00:00"))
                                 duration_sec = (current_start - prev_ts).total_seconds()
                                 result["previous_state"] = prev_state
                                 result["previous_duration_sec"] = duration_sec
    except Exception:
        # Ignore errors in fetching previous state, it's optional
        pass
        
    return result
