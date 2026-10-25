"""Planned outage schedule from DTEK's data (via outage-data-ua) or svitlo.live, with past days
kept on disk per source."""

import json
import os
import threading
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from app.config import settings

# Both sources publish wall-clock Kyiv time; slots are kept as 48 half-hour digits per day from
# local midnight: 0 = not published, 1 = power on, 2 = outage.
SCHEDULE_TZ = ZoneInfo("Europe/Kyiv")
OFF = "2"
POLL_SECONDS = 300
KEEP_DAYS = 14  # history ranges go back at most 7 days (MAX_HISTORY_HOURS)

# DTEK's own schedule, scraped from its sites by github.com/Baskerville42/outage-data-ua (the sites
# themselves are behind bot protection); the first is the default, the other is for comparison
SOURCES = ("dtek", "svitlo")
DTEK_FILES = {"kiivska-oblast": "kyiv-region", "kyiv": "kyiv", "dnipropetrovska-oblast": "dnipro", "odeska-oblast": "odesa"}
DTEK_URL = "https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/{file}.json"
# Per hour "1".."24" (1 = 00:00–01:00): its two half-hours. "maybe"/"mfirst"/"msecond" (possible
# outage) only appear in DTEK's weekly template, not in the actual schedule; count them as on.
DTEK_HOUR_SLOTS = {"yes": "11", "no": "22", "first": "21", "second": "12"}

# The emergency flag only exists in the DTEK proxy behind svitlo.live, which spells a few regions
# differently
EMERGENCY_REGION_ALIASES = {
    "harkivska-oblast": "kharkivska-oblast",
    "hmelnitska-oblast": "khmelnytska-oblast",
    "chernigivska-oblast": "chernihivska-oblast",
    "jitomirska-oblast": "zhytomyrska-oblast",
}

_lock = threading.Lock()
# Last successful fetch per source: {"fetched_at", "updated", "found", "days": {date: slots}}
_latest: dict[str, dict[str, Any]] = {}
_emergency = False


def enabled() -> bool:
    return bool(settings.schedule_region and settings.schedule_queue)


def _dtek_url() -> str:
    if settings.schedule_dtek_url:
        return settings.schedule_dtek_url
    file = DTEK_FILES.get(settings.schedule_region)
    return DTEK_URL.format(file=file) if file else ""


def _store_path() -> Path:
    return Path(settings.data_dir) / "schedule.json"


def _load_store() -> dict[str, dict[str, list[dict[str, str]]]]:
    """Every version of each day's slots seen, per source:
    {"dtek": {"2026-10-23": [{"from": iso, "slots": "0112…"}, …]}, "svitlo": {…}}"""
    try:
        store = json.loads(_store_path().read_text())
    except FileNotFoundError:
        return {}
    # Before DTEK was added, the file held svitlo.live's days only
    if any(key[:1].isdigit() for key in store):
        store = {"svitlo": store}
    return store


def _save_store(store: dict[str, dict[str, list[dict[str, str]]]]) -> None:
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
    # The DTEK proxy behind svitlo.live wraps its payload as a JSON string in "body"
    return json.loads(data["body"]) if isinstance(data.get("body"), str) else data


def _find_region(data: dict[str, Any], region: str) -> dict[str, Any] | None:
    return next((r for r in data.get("regions") or [] if r.get("cpu") == region), None)


def _fetch_svitlo(now: datetime) -> dict[str, Any]:
    """svitlo.live: {regions: [{cpu, schedule: {queue: {"YYYY-MM-DD": {"00:00": 0|1|2, …}}}}]}"""
    region = _find_region(_get_json(settings.schedule_api_url), settings.schedule_region)
    queue = ((region or {}).get("schedule") or {}).get(settings.schedule_queue)
    days: dict[date, str] = {}
    for day, slots in (queue or {}).items():
        values = "".join(str(v) for _, v in sorted((slots or {}).items()))
        if len(values) == 48 and values.strip("0"):
            days[date.fromisoformat(day)] = values
    # No update time in the data: when it was fetched
    return {"fetched_at": now, "updated": now, "found": queue is not None, "days": days}


def _fetch_dtek(now: datetime) -> dict[str, Any] | None:
    """DTEK: {fact: {data: {<Kyiv midnight, unix>: {"GPV5.1": {"1": "yes", …, "24": …}}}, update}}"""
    url = _dtek_url()
    if not url:
        return None  # region not covered
    fact = _get_json(url).get("fact") or {}
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
    return {"fetched_at": now, "updated": updated, "found": found, "days": days}


def _fetch_emergency(today: date) -> bool:
    """Emergency outages (ГАВ) in effect, per the DTEK proxy; False if unknown or stale."""
    if not settings.schedule_emergency_api_url:
        return False
    data = _get_json(settings.schedule_emergency_api_url)
    if data.get("date_today") != today.isoformat():
        return False  # it can lag a whole day behind; don't trust a stale flag
    region = _find_region(data, EMERGENCY_REGION_ALIASES.get(settings.schedule_region, settings.schedule_region))
    return bool((region or {}).get("emergency"))


def refresh() -> None:
    """Fetch every source, recording new versions of each day. A failing source keeps its last
    fetch; raises only if all of them failed."""
    global _emergency
    now = datetime.now(timezone.utc)
    today = now.astimezone(SCHEDULE_TZ).date()
    fetched: dict[str, dict[str, Any]] = {}
    errors: list[Exception] = []
    for source, fetch in (("dtek", _fetch_dtek), ("svitlo", _fetch_svitlo)):
        try:
            result = fetch(now)
        except Exception as e:
            errors.append(e)
            continue
        if result is not None:
            fetched[source] = result
    try:
        emergency = _fetch_emergency(today)
    except Exception:
        emergency = False

    with _lock:
        store = _load_store()
        changed = False
        for source, latest in fetched.items():
            source_store = store.setdefault(source, {})
            for day, slots in latest["days"].items():
                versions = source_store.setdefault(day.isoformat(), [])
                if not versions or versions[-1]["slots"] != slots:
                    versions.append({"from": now.isoformat(), "slots": slots})
                    changed = True
        oldest = (today - timedelta(days=KEEP_DAYS)).isoformat()
        for source_store in store.values():
            for day in [d for d in source_store if d < oldest]:
                del source_store[day]
                changed = True
        if changed:
            _save_store(store)
        _latest.update(fetched)
        _emergency = emergency
    if errors and not fetched:
        raise errors[0]


def _choose(source: str | None) -> str:
    """The requested source, or the default: DTEK if it has the queue, else svitlo.live."""
    if source in SOURCES:
        return source
    return "dtek" if _latest.get("dtek", {}).get("found") else "svitlo"


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


def get_schedule(source: str | None = None) -> dict[str, Any] | None:
    """Current planned outage schedule from `source` (default: see _choose), or None if not
    configured."""
    if not enabled():
        return None
    # Kept fresh by the poller in main.py; fetch here only before its first run
    if not _latest:
        refresh()
    source = _choose(source)
    latest = _latest.get(source) or {"fetched_at": None, "updated": None, "found": False, "days": {}}
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
        "source": source,
        # Sources that have this region/queue, for switching between them
        "sources": [s for s in SOURCES if _latest.get(s, {}).get("found")],
        "queue": settings.schedule_queue,
        "region": settings.schedule_region,
        # Emergency outages are in effect and the schedule may not be followed
        "emergency": _emergency,
        "available": latest["found"],
        "updated": latest["updated"].isoformat() if latest["updated"] else None,
        "days": days,
        "outages": _iso(outages),
    }


def get_schedule_history(start: datetime, end: datetime, source: str | None = None) -> dict[str, Any] | None:
    """Past schedule from `source` as it was in effect, from the recorded versions, for the part
    of start..end before today's Kyiv midnight; from today on, the current schedule
    (get_schedule) is used instead. Only known since this app started recording. None if no
    schedule is configured."""
    if not enabled():
        return None
    cutoff = min(end, datetime.combine(datetime.now(SCHEDULE_TZ).date(), time(0), SCHEDULE_TZ))
    with _lock:
        store = _load_store().get(_choose(source), {})
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
