"""Agent concurrency from runtime.log attention status edges.

Why not raw session_id occupancy?
  UserPromptSubmit → running can leave a sid in `running` forever if Stop/done
  never lands (killed pane, /clear without SessionStart hook, crash). Scanning a
  multi-day log then reports absurd max_running (e.g. 12) while the badge only
  ever showed a handful of panes.

Primary metric (matches attention UI feel):
  - key = (tmux_socket, tmux_pane) with wezterm_pane fallback
  - new `running` on the same pane replaces the previous sid (same-pane eviction)
  - TTL default 30 minutes (attention.TTL_MS = 1800000) drops silent zombies
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from .common import parse_local_ts

TS_RE = re.compile(r'^ts="([^"]+)"')
KV_RE = re.compile(r'(\w+)="((?:\\.|[^"\\])*)"')
SID_OK = re.compile(
    r"^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|01[0-9a-f]{24,})$",
    re.I,
)

# Mirror scripts/runtime/attention-state-lib.sh / attention.TTL_MS.
DEFAULT_TTL_S = 1800


def _list_runtime_logs(primary: Path) -> list[Path]:
    """Oldest → newest so occupancy replay is chronological across rotates."""
    parent = primary.parent if primary.name else primary
    rotates: list[tuple[int, Path]] = []
    if parent.is_dir():
        for p in parent.glob("runtime.log.[0-9]*"):
            if not p.is_file():
                continue
            suf = p.name.rsplit(".", 1)[-1]
            if suf.isdigit():
                rotates.append((int(suf), p))
    # Higher rotate index is older (runtime.log.5 before .1 before current).
    rotates.sort(key=lambda t: -t[0])
    out = [p for _, p in rotates]
    if primary.is_file() and primary not in out:
        out.append(primary)
    return out


def _slot_key(fields: dict[str, str]) -> str:
    sock = fields.get("tmux_socket") or ""
    tp = fields.get("tmux_pane") or ""
    if tp:
        return f"{sock}|{tp}"
    pane = fields.get("wezterm_pane") or ""
    if pane:
        return f"wezterm:{pane}"
    return f"sid:{fields.get('session_id') or '?'}"


def analyze_concurrency(
    runtime_log: Path,
    *,
    start: date,
    end: date,
    ttl_s: int = DEFAULT_TTL_S,
) -> dict[str, Any]:
    day_set = {
        (start + timedelta(days=i)).isoformat()
        for i in range((end - start).days + 1)
    }

    # slot -> (status, sid, last_ts, provider, branch)
    live: dict[str, tuple[str, str, datetime, str, str]] = {}
    last_ts: datetime | None = None
    integral_running = 0.0
    integral_active = 0.0
    max_running = 0
    max_active = 0
    max_running_at: str | None = None
    max_running_slots: list[dict[str, str]] = []
    daily_max: dict[str, int] = defaultdict(int)
    transitions = 0
    providers_seen: dict[str, int] = defaultdict(int)
    unique_running_sids: set[str] = set()
    ttl_drops = 0
    # Diagnostic: raw sid occupancy without TTL/pane (shows zombie inflation).
    raw_live: dict[str, tuple[str, datetime]] = {}
    raw_max = 0

    def prune(now: datetime) -> None:
        nonlocal ttl_drops
        dead = [
            k
            for k, v in live.items()
            if (now - v[2]).total_seconds() > ttl_s
        ]
        for k in dead:
            live.pop(k, None)
            ttl_drops += 1
        raw_dead = [
            k
            for k, v in raw_live.items()
            if (now - v[1]).total_seconds() > ttl_s * 48  # only for sanity bound
        ]
        for k in raw_dead:
            raw_live.pop(k, None)

    def flush(now: datetime) -> None:
        nonlocal last_ts, integral_running, integral_active
        if last_ts is None:
            last_ts = now
            return
        dt = (now - last_ts).total_seconds()
        if dt < 0:
            last_ts = now
            return
        running = sum(1 for v in live.values() if v[0] == "running")
        active = len(live)
        integral_running += dt * running
        integral_active += dt * active
        last_ts = now

    for path in _list_runtime_logs(runtime_log):
        try:
            fh = path.open("r", encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                if 'message="hook emitted agent status"' not in line:
                    continue
                tm = TS_RE.match(line)
                if not tm:
                    continue
                day = tm.group(1)[:10]
                if day not in day_set:
                    continue
                fields = dict(KV_RE.findall(line))
                sid = fields.get("session_id") or ""
                if not SID_OK.match(sid):
                    continue
                status = fields.get("status") or ""
                if status not in {"running", "waiting", "done", "pane-evict"}:
                    continue
                ts = parse_local_ts(fields.get("ts") or tm.group(1))
                if ts is None:
                    continue

                prune(ts)
                flush(ts)
                transitions += 1
                provider = fields.get("provider") or "unknown"
                providers_seen[provider] += 1
                branch = fields.get("git_branch") or ""
                slot = _slot_key(fields)

                if status == "running":
                    live[slot] = ("running", sid, ts, provider, branch)
                    unique_running_sids.add(sid)
                    raw_live[sid] = ("running", ts)
                elif status == "waiting":
                    # Same pane: demote to waiting (still "active" for avg_active).
                    live[slot] = ("waiting", sid, ts, provider, branch)
                    if sid in raw_live:
                        raw_live[sid] = ("waiting", ts)
                elif status in {"done", "pane-evict"}:
                    cur = live.get(slot)
                    if cur and (cur[1] == sid or status == "pane-evict"):
                        live.pop(slot, None)
                    raw_live.pop(sid, None)

                running = sum(1 for v in live.values() if v[0] == "running")
                active = len(live)
                raw_running = sum(1 for v in raw_live.values() if v[0] == "running")
                if raw_running > raw_max:
                    raw_max = raw_running
                if running > max_running:
                    max_running = running
                    max_running_at = ts.isoformat(sep=" ")
                    max_running_slots = [
                        {
                            "slot": k,
                            "session_id": v[1],
                            "provider": v[3],
                            "git_branch": v[4],
                            "age_s": str(int((ts - v[2]).total_seconds())),
                        }
                        for k, v in live.items()
                        if v[0] == "running"
                    ]
                if active > max_active:
                    max_active = active
                if running > daily_max[day]:
                    daily_max[day] = running

    if last_ts is not None:
        end_local = datetime(end.year, end.month, end.day) + timedelta(days=1)
        prune(end_local)
        flush(end_local)

    window_s = max((end - start).days + 1, 1) * 86400.0
    avg_running = integral_running / window_s if window_s else 0.0
    avg_active = integral_active / window_s if window_s else 0.0

    return {
        "max_running": max_running,
        "max_active": max_active,
        "avg_running": round(avg_running, 3),
        "avg_active": round(avg_active, 3),
        "unique_running_sessions": len(unique_running_sids),
        "transitions": transitions,
        "daily_max_running": dict(sorted(daily_max.items())),
        "provider_edge_counts": dict(providers_seen),
        "ttl_s": ttl_s,
        "ttl_drops": ttl_drops,
        "max_running_at": max_running_at,
        "max_running_slots": max_running_slots,
        # Diagnostic only — unscoped sid occupancy (zombie inflation).
        "raw_sid_max_running": raw_max,
        "notes": [
            "max_running keys on tmux pane (+30m TTL), not raw session_id",
            "raw_sid_max_running ignores pane eviction — inflated by zombie sids without done",
            "avg_* = time-integral / window_seconds (includes idle nights)",
        ],
    }
