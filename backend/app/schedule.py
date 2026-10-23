"""Planned outage schedule straight from the svitlo.live API, with past days kept on disk."""

import json
import os
import threading
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from app.config import settings

# svitlo.live publishes slots in Kyiv time: 48 half-hour slots per day from local midnight,
# {"00:00": 1, "00:30": 1, …} with 0 = not published, 1 = power on, 2 = outage.
SCHEDULE_TZ = ZoneInfo("Europe/Kyiv")
OFF = "2"
POLL_SECONDS = 300
KEEP_DAYS = 14  # history ranges go back at most 7 days (MAX_HISTORY_HOURS)

# The emergency flag only exists in the DTEK proxy, which spells a few regions differently
EMERGENCY_REGION_ALIASES = {
    "harkivska-oblast": "kharkivska-oblast",
    "hmelnitska-oblast": "khmelnytska-oblast",
    "chernigivska-oblast": "chernihivska-oblast",
    "jitomirska-oblast": "zhytomyrska-oblast",
}

_lock = threading.Lock()
# Last successful fetch: {"fetched_at": datetime, "found": bool, "days": {date: slots}, "emergency": bool}
_latest: dict[str, Any] | None = None


def enabled() -> bool:
    return bool(settings.schedule_region and settings.schedule_queue)


def _store_path() -> Path:
    return Path(settings.data_dir) / "schedule.json"


def _load_store() -> dict[str, list[dict[str, str]]]:
    """Every version of each day's slots seen: {"2026-10-23": [{"from": iso, "slots": "0112…"}, …]}"""
    try:
        return json.loads(_store_path().read_text())
    except FileNotFoundError:
        return {}


def _save_store(store: dict[str, list[dict[str, str]]]) -> None:
    path = _store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(store, indent=1))
    os.replace(tmp, path)


def _get_json(url: str) -> dict[str, Any]:
    with httpx.Client(timeout=10.0) as client:
        resp = client.get(url)
        resp.raise_for_status()
        data = resp.json()
    # The DTEK proxy wraps its payload as a JSON string in "body"
    return json.loads(data["body"]) if isinstance(data.get("body"), str) else data


def _find_region(data: dict[str, Any], region: str) -> dict[str, Any] | None:
    return next((r for r in data.get("regions") or [] if r.get("cpu") == region), None)


def _fetch_emergency(today: date) -> bool:
    """Emergency outages (ГАВ) in effect, per the DTEK proxy; False if unknown or stale."""
    if not settings.schedule_emergency_api_url:
        return False
    try:
        data = _get_json(settings.schedule_emergency_api_url)
    except Exception:
        return False
    if data.get("date_today") != today.isoformat():
        return False  # it can lag a whole day behind; don't trust a stale flag
    region = _find_region(data, EMERGENCY_REGION_ALIASES.get(settings.schedule_region, settings.schedule_region))
    return bool((region or {}).get("emergency"))


def refresh() -> dict[str, Any]:
    """Fetch the schedule, record new versions of each day, and return it."""
    global _latest
    now = datetime.now(timezone.utc)
    today = now.astimezone(SCHEDULE_TZ).date()
    region = _find_region(_get_json(settings.schedule_api_url), settings.schedule_region)
    queue = ((region or {}).get("schedule") or {}).get(settings.schedule_queue)
    days: dict[date, str] = {}
    for day, slots in (queue or {}).items():
        values = "".join(str(v) for _, v in sorted((slots or {}).items()))
        # All zeros = not published yet
        if len(values) == 48 and values.strip("0"):
            days[date.fromisoformat(day)] = values
    latest = {"fetched_at": now, "found": queue is not None, "days": days, "emergency": _fetch_emergency(today)}

    with _lock:
        store = _load_store()
        changed = False
        for day, slots in days.items():
            versions = store.setdefault(day.isoformat(), [])
            if not versions or versions[-1]["slots"] != slots:
                versions.append({"from": now.isoformat(), "slots": slots})
                changed = True
        oldest = (today - timedelta(days=KEEP_DAYS)).isoformat()
        for day in [d for d in store if d < oldest]:
            del store[day]
            changed = True
        if changed:
            _save_store(store)
        _latest = latest
    return latest


def _day_bounds(day: date) -> tuple[datetime, datetime]:
    return (
        datetime.combine(day, time(0), SCHEDULE_TZ),
        datetime.combine(day + timedelta(days=1), time(0), SCHEDULE_TZ),
    )


def _slots_to_outages(slots: str, day: date) -> list[tuple[datetime, datetime]]:
    """Merge consecutive outage slots of a Kyiv-local day into (start, end) intervals."""
    outages: list[tuple[datetime, datetime]] = []
    midnight = _day_bounds(day)[0]
    for i, slot in enumerate(slots):
        if slot != OFF:
            continue
        # Wall-clock arithmetic, then to UTC: correct on 23/25-hour DST days too
        start = (midnight + timedelta(minutes=30 * i)).astimezone(timezone.utc)
        end = (midnight + timedelta(minutes=30 * (i + 1))).astimezone(timezone.utc)
        _append(outages, start, end)
    return outages


def _append(runs: list[tuple[datetime, datetime]], start: datetime, end: datetime) -> None:
    """Add an interval, extending the last one if they touch (e.g. an outage over midnight)."""
    if runs and runs[-1][1] == start:
        runs[-1] = (runs[-1][0], end)
    else:
        runs.append((start, end))


def _iso(runs: list[tuple[datetime, datetime]]) -> list[dict[str, str]]:
    return [{"start": s.isoformat(), "end": e.isoformat()} for s, e in runs]


def get_schedule() -> dict[str, Any] | None:
    """Current planned outage schedule, or None if not configured."""
    if not enabled():
        return None
    # Kept fresh by the poller in main.py; fetch here only before its first run
    latest = _latest or refresh()
    today = datetime.now(SCHEDULE_TZ).date()

    outages: list[tuple[datetime, datetime]] = []
    for day, slots in sorted(latest["days"].items()):
        for start, end in _slots_to_outages(slots, day):
            _append(outages, start, end)

    # Always report today and tomorrow (unpublished if svitlo.live has nothing for them yet)
    published_days = {day: True for day in latest["days"]}
    for day in (today, today + timedelta(days=1)):
        published_days.setdefault(day, False)
    days = [
        {
            "date": day.isoformat(),
            "start": _day_bounds(day)[0].isoformat(),
            "end": _day_bounds(day)[1].isoformat(),
            "published": published,
        }
        for day, published in sorted(published_days.items())
        if day >= today or published
    ]

    return {
        "queue": settings.schedule_queue,
        "region": settings.schedule_region,
        # Emergency outages are in effect and the schedule may not be followed
        "emergency": latest["emergency"],
        "available": latest["found"],
        "updated": latest["fetched_at"].isoformat(),
        "days": days,
        "outages": _iso(outages),
    }


def get_schedule_history(start: datetime, end: datetime) -> dict[str, Any] | None:
    """Past schedule as it was in effect, from the recorded versions, for the part of start..end
    before today's Kyiv midnight; from today on, the current schedule (get_schedule) is used
    instead. Only known since this app started recording. None if no schedule is configured."""
    if not enabled():
        return None
    cutoff = min(end, datetime.combine(datetime.now(SCHEDULE_TZ).date(), time(0), SCHEDULE_TZ))
    with _lock:
        store = _load_store()
    covered: list[tuple[datetime, datetime]] = []
    outages: list[tuple[datetime, datetime]] = []
    for day_str in sorted(store):
        day = date.fromisoformat(day_str)
        day_start, day_end = _day_bounds(day)
        if day_end <= start or day_start >= cutoff:
            continue
        versions = store[day_str]
        for i, version in enumerate(versions):
            # Each version applies until the next one was seen; the first one covers the whole
            # day up to then (it's the plan that was published for it)
            v_start = day_start if i == 0 else max(day_start, datetime.fromisoformat(version["from"]))
            v_end = day_end if i + 1 == len(versions) else datetime.fromisoformat(versions[i + 1]["from"])
            v_start, v_end = max(v_start, start), min(v_end, day_end, cutoff)
            if v_start >= v_end:
                continue
            _append(covered, v_start, v_end)
            for o_start, o_end in _slots_to_outages(version["slots"], day):
                o_start, o_end = max(o_start, v_start), min(o_end, v_end)
                if o_start < o_end:
                    _append(outages, o_start, o_end)
    return {"covered": _iso(covered), "outages": _iso(outages)}
