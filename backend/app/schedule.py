"""Planned outage schedule from DTEK's own data (via outage-data-ua), with past days kept on disk,
plus whether emergency outages are in effect in the region."""

import json
import os
import threading
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from app.config import settings

# DTEK publishes wall-clock Kyiv time; slots are kept as 48 half-hour digits per day from local
# midnight: 0 = not published, 1 = power on, 2 = outage.
SCHEDULE_TZ = ZoneInfo("Europe/Kyiv")
OFF = "2"
POLL_SECONDS = 300
KEEP_DAYS = 14  # history ranges go back at most 7 days (MAX_HISTORY_HOURS)

# DTEK's own schedule, scraped from its sites by github.com/Baskerville42/outage-data-ua (the sites
# themselves are behind bot protection). SCHEDULE_REGION is its file id (kyiv-region, kyiv, dnipro,
# odesa); the svitlo.live-style ids used before are still accepted.
DTEK_FILES = {"kiivska-oblast": "kyiv-region", "dnipropetrovska-oblast": "dnipro", "odeska-oblast": "odesa"}
DTEK_URL = "https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/{file}.json"
# Per hour "1".."24" (1 = 00:00–01:00): its two half-hours. "maybe"/"mfirst"/"msecond" (possible
# outage) only appear in DTEK's weekly template, not in the actual schedule; count them as on.
DTEK_HOUR_SLOTS = {"yes": "11", "no": "22", "first": "21", "second": "12"}
# Region-wide emergency outages (ГАВ) only appear as a flag in the DTEK proxy behind svitlo.live
# (`emergency` per region, payload JSON-encoded in "body"), which names regions differently
EMERGENCY_REGIONS = {"kyiv-region": "kiivska-oblast", "dnipro": "dnipro-dnem", "dnipropetrovska-oblast": "dnipro-dnem"}

_lock = threading.Lock()
# Last successful fetch: {"updated", "found", "days": {date: slots}, "emergency": bool}
_latest: dict[str, Any] | None = None


def enabled() -> bool:
    return bool(settings.schedule_region and settings.schedule_queue)


def _dtek_url() -> str:
    region = settings.schedule_region
    return settings.schedule_dtek_url or DTEK_URL.format(file=DTEK_FILES.get(region, region))


def _store_path() -> Path:
    return Path(settings.data_dir) / "schedule.json"


def _load_store() -> dict[str, list[dict[str, str]]]:
    """Every version of each day's slots seen: {"2026-10-23": [{"from": iso, "slots": "0112…"}, …]},
    stored under "dtek" (anything else in the file is from svitlo.live, no longer used)."""
    try:
        return json.loads(_store_path().read_text()).get("dtek") or {}
    except FileNotFoundError:
        return {}


def _save_store(store: dict[str, list[dict[str, str]]]) -> None:
    path = _store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"dtek": store}, indent=1))
    os.replace(tmp, path)


def _fetch_dtek(now: datetime) -> dict[str, Any]:
    """{fact: {data: {<Kyiv midnight, unix>: {"GPV5.1": {"1": "yes", …, "24": …}}}, update}}"""
    with httpx.Client(timeout=10.0) as client:
        resp = client.get(_dtek_url())
        resp.raise_for_status()
        fact = resp.json().get("fact") or {}
    data = fact.get("data")
    queue_key = f"GPV{settings.schedule_queue}"
    days: dict[date, str] = {}
    found = False
    for midnight, queues in (data.items() if isinstance(data, dict) else []):
        hours = (queues or {}).get(queue_key)
        if not hours:
            continue
        found = True
        values = "".join(DTEK_HOUR_SLOTS.get(hours.get(str(h)), "11") for h in range(1, 25))
        days[datetime.fromtimestamp(int(midnight), SCHEDULE_TZ).date()] = values
    # DTEK's own "updated at", Kyiv time: "25.10.2026 10:02"
    try:
        updated = datetime.strptime(fact.get("update") or "", "%d.%m.%Y %H:%M").replace(tzinfo=SCHEDULE_TZ)
    except ValueError:
        updated = now
    return {"updated": updated, "found": found, "days": days}


def _fetch_emergency(today: date) -> bool:
    """Emergency outages in effect in the region; False if unknown or stale."""
    if not settings.schedule_emergency_api_url:
        return False
    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(settings.schedule_emergency_api_url)
            resp.raise_for_status()
            data = resp.json()
        data = json.loads(data["body"]) if isinstance(data.get("body"), str) else data
    except Exception:
        return False
    if data.get("date_today") != today.isoformat():
        return False  # it can lag a whole day behind; don't trust a stale flag
    region_id = EMERGENCY_REGIONS.get(settings.schedule_region, settings.schedule_region)
    region = next((r for r in data.get("regions") or [] if r.get("cpu") == region_id), None)
    return bool((region or {}).get("emergency"))


def refresh() -> dict[str, Any]:
    """Fetch the schedule, record new versions of each day, and return it."""
    global _latest
    now = datetime.now(timezone.utc)
    today = now.astimezone(SCHEDULE_TZ).date()
    latest = _fetch_dtek(now)
    latest["emergency"] = _fetch_emergency(today)
    with _lock:
        store = _load_store()
        changed = False
        for day, slots in latest["days"].items():
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

    # Always report today and tomorrow (unpublished if there's nothing for them yet)
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
        "available": latest["found"],
        # Emergency outages in the region: the schedule may not be followed
        "emergency": latest["emergency"],
        # DTEK's own update time
        "updated": latest["updated"].isoformat(),
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
