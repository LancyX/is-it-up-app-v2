"""Home Assistant API client - fetches state and history for Grid Power entity."""

from datetime import date, datetime, time, timedelta, timezone
from time import monotonic
from typing import Any
from zoneinfo import ZoneInfo

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


def _fetch_history_period(start: datetime, end: datetime, entity_id: str | None = None) -> list[dict[str, Any]]:
    """Fetch raw state-change history for an entity (default: the grid one) between start and end (both tz-aware)."""
    url = f"{settings.ha_base_url.rstrip('/')}/api/history/period/{start.isoformat()}"
    params = {
        "filter_entity_id": entity_id or settings.grid_entity_id,
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


def get_history(start: datetime, end: datetime) -> list[dict[str, Any]]:
    """Fetch state history for the grid entity between start and end (both tz-aware)."""
    # We do NOT filter the result by start_ts because HA returns the "initial state"
    # as the first element, with its timestamp clamped to start_ts. We need this!
    return _fetch_history_period(start, end)


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


# svitlo.live publishes slots in Kyiv time: today_48half / tomorrow_48half are 48 half-hour
# slots ('on' / 'off' / 'unknown') starting at local midnight.
SCHEDULE_TZ = ZoneInfo("Europe/Kyiv")


def _get_entity_state(entity_id: str) -> dict[str, Any]:
    url = f"{settings.ha_base_url.rstrip('/')}/api/states/{entity_id}"
    with httpx.Client(timeout=10.0) as client:
        resp = client.get(url, headers=_headers())
        resp.raise_for_status()
        return resp.json()


def _slots_to_outages(slots: list[str], day: date) -> list[tuple[datetime, datetime]]:
    """Merge consecutive 'off' half-hour slots of a Kyiv-local day into (start, end) intervals."""
    outages: list[tuple[datetime, datetime]] = []
    midnight = datetime.combine(day, time(0), SCHEDULE_TZ)
    for i, slot in enumerate(slots):
        if slot != "off":
            continue
        # Wall-clock arithmetic, then to UTC: correct on 23/25-hour DST days too
        start = (midnight + timedelta(minutes=30 * i)).astimezone(timezone.utc)
        end = (midnight + timedelta(minutes=30 * (i + 1))).astimezone(timezone.utc)
        if outages and outages[-1][1] == start:
            outages[-1] = (outages[-1][0], end)
        else:
            outages.append((start, end))
    return outages


def _schedule_calendar_id() -> str:
    """svitlo.live calendar entity: explicit setting, or derived from the status sensor's id."""
    if settings.schedule_calendar_id:
        return settings.schedule_calendar_id
    sensor = settings.schedule_entity_id
    if sensor.startswith("sensor.") and sensor.endswith("_electricity"):
        return "calendar." + sensor[len("sensor."):-len("_electricity")] + "_outages_schedule"
    return ""


def _get_calendar_outages(calendar_id: str, start: datetime, end: datetime) -> set[tuple[datetime, datetime]]:
    url = f"{settings.ha_base_url.rstrip('/')}/api/calendars/{calendar_id}"
    params = {"start": start.isoformat(), "end": end.isoformat()}
    with httpx.Client(timeout=10.0) as client:
        resp = client.get(url, headers=_headers(), params=params)
        resp.raise_for_status()
        events = resp.json()
    return {
        (
            datetime.fromisoformat(e["start"]["dateTime"]).astimezone(timezone.utc),
            datetime.fromisoformat(e["end"]["dateTime"]).astimezone(timezone.utc),
        )
        for e in events
        if "dateTime" in e.get("start", {}) and "dateTime" in e.get("end", {})
    }


def _ha_schedule_slots(attrs: dict[str, Any], base: date) -> dict[date, list[str]]:
    """Slots of the published days, assuming `today_48half` belongs to `base`."""
    slots_by_day: dict[date, list[str]] = {}
    for offset, key in ((0, "today_48half"), (1, "tomorrow_48half")):
        slots = attrs.get(key) or []
        # An all-'unknown' list means no schedule was published for that day
        if any(s in ("on", "off") for s in slots):
            slots_by_day[base + timedelta(days=offset)] = slots
    return slots_by_day


def _merge_outages(slots_by_day: dict[date, list[str]]) -> list[tuple[datetime, datetime]]:
    outages: list[tuple[datetime, datetime]] = []
    for day, slots in sorted(slots_by_day.items()):
        day_outages = _slots_to_outages(slots, day)
        # An outage over midnight continues into the next day's first slot
        if outages and day_outages and outages[-1][1] == day_outages[0][0]:
            outages[-1] = (outages[-1][0], day_outages.pop(0)[1])
        outages.extend(day_outages)
    return outages


# The svitlo.live API's region ids differ from the integration's for a few regions
API_REGION_ALIASES = {
    "kharkivska-oblast": "harkivska-oblast",
    "khmelnytska-oblast": "hmelnitska-oblast",
    "chernihivska-oblast": "chernigivska-oblast",
    "zhytomyrska-oblast": "jitomirska-oblast",
}
API_SLOT_STATES = {1: "on", 2: "off"}  # 0 = not published
API_CACHE_SECONDS = 300
_api_cache: tuple[float, dict[str, Any]] | None = None


def _get_api_schedule(region: str, queue: str) -> dict[date, list[str]]:
    """Published days for a region/queue straight from the svitlo.live API (cached)."""
    global _api_cache
    now = monotonic()
    if _api_cache is None or now - _api_cache[0] > API_CACHE_SECONDS:
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(settings.schedule_api_url)
            resp.raise_for_status()
            _api_cache = (now, resp.json())
    region_id = API_REGION_ALIASES.get(region, region)
    entry = next((r for r in _api_cache[1].get("regions", []) if r.get("cpu") == region_id), None)
    days = ((entry or {}).get("schedule") or {}).get(queue) or {}
    slots_by_day: dict[date, list[str]] = {}
    for day, slots in days.items():
        # {"00:00": 1, "00:30": 1, …}: 48 half-hour slots from Kyiv midnight
        states = [API_SLOT_STATES.get(v, "unknown") for _, v in sorted((slots or {}).items())]
        if len(states) == 48 and any(s != "unknown" for s in states):
            slots_by_day[date.fromisoformat(day)] = states
    return slots_by_day


def get_schedule() -> dict[str, Any] | None:
    """Planned outage schedule from the svitlo.live sensor, or None if not configured."""
    if not settings.schedule_entity_id:
        return None
    entity = _get_entity_state(settings.schedule_entity_id)
    attrs = entity.get("attributes", {})
    today = datetime.now(SCHEDULE_TZ).date()

    # The sensor doesn't expose which date `today_48half` is for, and after midnight it keeps
    # yesterday's schedule until svitlo.live publishes the new day. The integration's calendar
    # has the real dates, so pick the date whose outages match the calendar's events.
    candidates = (today, today - timedelta(days=1))
    base = today
    calendar_id = _schedule_calendar_id()
    if calendar_id:
        try:
            calendar = _get_calendar_outages(
                calendar_id,
                datetime.combine(today - timedelta(days=1), time(0), SCHEDULE_TZ),
                datetime.combine(today + timedelta(days=2), time(0), SCHEDULE_TZ),
            )
            base = next(
                (c for c in candidates if set(_merge_outages(_ha_schedule_slots(attrs, c))) == calendar), today
            )
        except Exception:
            pass  # calendar unavailable: assume the schedule is today's
    slots_by_day = _ha_schedule_slots(attrs, base)

    # The integration can lag behind svitlo.live (its upstream may not have the new day yet):
    # fill the days it doesn't have from the API directly.
    from_api = False
    if settings.schedule_api_url and attrs.get("region") and attrs.get("queue"):
        try:
            for day, slots in _get_api_schedule(attrs["region"], str(attrs["queue"])).items():
                if day not in slots_by_day:
                    slots_by_day[day] = slots
                    from_api = from_api or day >= today
        except Exception:
            pass  # optional: keep what HA has
    outages = _merge_outages(slots_by_day)

    # Always report today and tomorrow (unpublished if svitlo.live has nothing for them yet),
    # plus a stale yesterday so the history chart can still show it.
    published_days = {day: True for day in slots_by_day}
    for day in (today, today + timedelta(days=1)):
        published_days.setdefault(day, False)
    days = [
        {
            "date": day.isoformat(),
            "start": datetime.combine(day, time(0), SCHEDULE_TZ).isoformat(),
            "end": datetime.combine(day + timedelta(days=1), time(0), SCHEDULE_TZ).isoformat(),
            "published": published,
        }
        for day, published in sorted(published_days.items())
        if day >= today or published
    ]

    return {
        "entity_id": settings.schedule_entity_id,
        "queue": attrs.get("queue"),
        "region": attrs.get("region"),
        # State 'Emergency' = emergency outages are in effect and the schedule may not be followed
        "emergency": entity.get("state") == "Emergency",
        "available": from_api or entity.get("state") not in ("No data", "unavailable", "unknown"),
        "updated": attrs.get("updated"),
        "days": days,
        "outages": [{"start": s.isoformat(), "end": e.isoformat()} for s, e in outages],
    }


def get_schedule_history(start: datetime, end: datetime) -> dict[str, Any] | None:
    """Past schedule from the recorded state of the svitlo.live calendar ('on' during a planned
    outage), for the part of start..end before today's Kyiv midnight; from today on, the
    current schedule (get_schedule) is used instead. None if no schedule is configured."""
    calendar_id = _schedule_calendar_id() if settings.schedule_entity_id else ""
    if not calendar_id:
        return None
    cutoff = min(end, datetime.combine(datetime.now(SCHEDULE_TZ).date(), time(0), SCHEDULE_TZ))
    covered: list[tuple[datetime, datetime]] = []
    outages: list[tuple[datetime, datetime]] = []
    if start < cutoff:
        items = [
            (datetime.fromisoformat(h["last_changed"]), h.get("state"))
            for h in _fetch_history_period(start, cutoff, calendar_id)
            if h.get("last_changed")
        ]
        for i, (ts, state) in enumerate(items):
            run_end = items[i + 1][0] if i + 1 < len(items) else cutoff
            # 'unavailable'/'unknown' (e.g. HA restart) = plan unknown for that stretch
            if state not in ("on", "off") or run_end <= ts:
                continue
            for runs, add in ((covered, True), (outages, state == "on")):
                if not add:
                    continue
                if runs and runs[-1][1] == ts:
                    runs[-1] = (runs[-1][0], run_end)
                else:
                    runs.append((ts, run_end))
    return {
        "covered": [{"start": s.isoformat(), "end": e.isoformat()} for s, e in covered],
        "outages": [{"start": s.isoformat(), "end": e.isoformat()} for s, e in outages],
    }
