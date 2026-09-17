"""Fetch and aggregate WakaTime summaries for a closed date window.

Uses GET /api/v1/users/current/summaries?start=&end= so the range matches
habit-weekly --since/--until (not the fixed stats/last_7_days bucket).

Never embeds the API key in returned payloads.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date
from typing import Any

DEFAULT_API_BASE = "https://api.wakatime.com/api/v1"
USER_AGENT = "wezdeck-habit-weekly"


def resolve_api_key() -> str:
    return (
        os.environ.get("WAKATIME_API_KEY")
        or os.environ.get("TMUX_STATUS_WAKATIME_API_KEY")
        or ""
    ).strip()


def _humanize_seconds(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    parts: list[str] = []
    if hours:
        parts.append(f"{hours} hrs" if hours != 1 else "1 hr")
    if minutes:
        parts.append(f"{minutes} mins" if minutes != 1 else "1 min")
    if not parts:
        if secs:
            parts.append(f"{secs} secs" if secs != 1 else "1 sec")
        else:
            parts.append("0 secs")
    return " ".join(parts)


def _entry(name: str, seconds: float, percent: float | None = None) -> dict[str, Any]:
    row: dict[str, Any] = {
        "name": name,
        "seconds": round(float(seconds), 3),
        "text": _humanize_seconds(seconds),
    }
    if percent is not None:
        row["percent"] = round(float(percent), 2)
    return row


def _merge_named(
    buckets: dict[str, float], *, total_seconds: float, limit: int
) -> list[dict[str, Any]]:
    items = sorted(buckets.items(), key=lambda kv: -kv[1])
    out: list[dict[str, Any]] = []
    for name, seconds in items[:limit]:
        pct = (100.0 * seconds / total_seconds) if total_seconds > 0 else 0.0
        out.append(_entry(name, seconds, pct))
    return out


def aggregate_summaries_payload(
    payload: dict[str, Any],
    *,
    start: date,
    end: date,
    top_n: int = 8,
) -> dict[str, Any]:
    """Aggregate a WakaTime summaries JSON body into habit-report.wakatime."""
    days = payload.get("data") or []
    categories: dict[str, float] = defaultdict(float)
    projects: dict[str, float] = defaultdict(float)
    languages: dict[str, float] = defaultdict(float)
    editors: dict[str, float] = defaultdict(float)
    daily: list[dict[str, Any]] = []
    total_seconds = 0.0

    for day in days:
        range_meta = day.get("range") or {}
        day_date = (
            range_meta.get("date")
            or range_meta.get("start_date")
            or ""
        )
        gt = day.get("grand_total") or {}
        day_secs = float(gt.get("total_seconds") or 0.0)
        total_seconds += day_secs
        daily.append(
            {
                "date": day_date,
                "seconds": round(day_secs, 3),
                "text": gt.get("text") or _humanize_seconds(day_secs),
            }
        )
        for key, bucket in (
            ("categories", categories),
            ("projects", projects),
            ("languages", languages),
            ("editors", editors),
        ):
            for item in day.get(key) or []:
                name = item.get("name")
                if not isinstance(name, str) or not name:
                    continue
                bucket[name] += float(item.get("total_seconds") or 0.0)

    cum = payload.get("cumulative_total") or {}
    if cum.get("seconds") is not None:
        total_seconds = float(cum["seconds"])
    total_text = cum.get("text") or _humanize_seconds(total_seconds)

    # Prefer Coding / AI Coding near the top of categories for the report.
    cat_rows = _merge_named(categories, total_seconds=total_seconds, limit=top_n)
    preferred = {"Coding", "AI Coding"}
    cat_rows.sort(
        key=lambda r: (0 if r["name"] in preferred else 1, -float(r["seconds"]))
    )

    return {
        "ok": True,
        "source": "summaries",
        "window": {"start": start.isoformat(), "end": end.isoformat()},
        "totals": {
            "seconds": round(total_seconds, 3),
            "text": total_text,
        },
        "categories": cat_rows,
        "projects": _merge_named(projects, total_seconds=total_seconds, limit=top_n),
        "languages": _merge_named(languages, total_seconds=total_seconds, limit=top_n),
        "editors": _merge_named(editors, total_seconds=total_seconds, limit=top_n),
        "daily": daily,
        "error": None,
    }


def _failure(start: date, end: date, error: str) -> dict[str, Any]:
    return {
        "ok": False,
        "source": "summaries",
        "window": {"start": start.isoformat(), "end": end.isoformat()},
        "totals": {"seconds": 0, "text": "0 secs"},
        "categories": [],
        "projects": [],
        "languages": [],
        "editors": [],
        "daily": [],
        "error": error,
    }


def fetch_summaries(
    start: date,
    end: date,
    *,
    api_key: str | None = None,
    api_base: str | None = None,
    timeout: float = 20.0,
    top_n: int = 8,
) -> dict[str, Any]:
    key = (api_key if api_key is not None else resolve_api_key()).strip()
    if not key:
        return _failure(start, end, "missing_api_key")

    base = (api_base or os.environ.get("WAKATIME_API_BASE") or DEFAULT_API_BASE).rstrip(
        "/"
    )
    query = urllib.parse.urlencode(
        {"start": start.isoformat(), "end": end.isoformat()}
    )
    url = f"{base}/users/current/summaries?{query}"
    token = base64.b64encode(key.encode("utf-8")).decode("ascii")
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Basic {token}",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            payload = json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")[:200]
        except Exception:
            body = ""
        detail = f"http_{exc.code}"
        if body:
            detail = f"{detail}:{body}"
        return _failure(start, end, detail)
    except (OSError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return _failure(start, end, f"{type(exc).__name__}:{exc}")

    if not isinstance(payload, dict):
        return _failure(start, end, "invalid_payload")

    try:
        return aggregate_summaries_payload(
            payload, start=start, end=end, top_n=top_n
        )
    except Exception as exc:  # noqa: BLE001 — keep weekly report resilient
        return _failure(start, end, f"aggregate:{type(exc).__name__}:{exc}")
