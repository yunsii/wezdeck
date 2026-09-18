"""Join Rime commit-char JSONL with host.foreground process timeline.

Privacy: commit log has no text; helper.log foreground rows have process
names only (no window titles). Agent-vs-shell inside WezTerm is Phase 2 —
PoC buckets stop at OS foreground process (wezterm-gui / Code / chrome / other).
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .common import day_bounds_utc, in_window, iter_jsonl, parse_iso_ts, parse_local_ts

_FG_RE = re.compile(
    r'ts="([^"]+)".*category="foreground".*message="foreground changed".*'
    r'(?:to_process="([^"]*)"|from_process="([^"]*)")'
)
# Prefer to_process; some lines may order fields differently — parse kv loosely.
_KV_RE = re.compile(r'(\w+)="([^"]*)"')

_WEZTERM_NAMES = frozenset({"wezterm-gui", "wezterm", "WezTerm"})
_CODE_NAMES = frozenset({"Code", "Code - Insiders", "code"})
_CHROME_NAMES = frozenset({"chrome", "msedge", "brave", "Chromium"})


@dataclass
class FgEdge:
    ts: datetime
    process: str


def _parse_helper_ts(raw: str) -> datetime | None:
    # helper.log uses local wall clock without TZ: "2026-09-12 19:11:41.886"
    dt = parse_local_ts(raw)
    if dt is None:
        return None
    # Treat as local-then-UTC-naive attach: compare in UTC by assuming local==host.
    # Host helper and Rime both run on Windows local time; Rime writes UTC Z.
    # Convert local naive → UTC by tagging as UTC offset unknown: use as-is with
    # UTC label for window compare only when Rime ts converted to local…
    # Simpler: convert Rime UTC → naive local via astimezone if we know offset.
    return dt.replace(tzinfo=None)


def _bucket(process: str) -> str:
    if process in _WEZTERM_NAMES:
        return "wezterm"
    if process in _CODE_NAMES:
        return "code"
    if process in _CHROME_NAMES:
        return "chrome"
    if not process:
        return "unknown"
    return "other"


def load_foreground_timeline(helper_log: Path) -> list[FgEdge]:
    edges: list[FgEdge] = []
    if not helper_log.is_file():
        return edges
    with helper_log.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if 'category="foreground"' not in line:
                continue
            if 'message="foreground changed"' not in line:
                continue
            kv = dict(_KV_RE.findall(line))
            ts = _parse_helper_ts(kv.get("ts", ""))
            proc = kv.get("to_process") or ""
            if ts is None or not proc:
                continue
            edges.append(FgEdge(ts=ts, process=proc))
    edges.sort(key=lambda e: e.ts)
    return edges


def process_at(edges: list[FgEdge], when_local: datetime) -> str:
    """Return foreground process name at when_local (naive local)."""
    if not edges:
        return ""
    # last edge with ts <= when
    lo, hi = 0, len(edges) - 1
    best = ""
    while lo <= hi:
        mid = (lo + hi) // 2
        if edges[mid].ts <= when_local:
            best = edges[mid].process
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def _rime_ts_to_local_naive(ts: datetime) -> datetime:
    if ts.tzinfo is None:
        return ts
    return ts.astimezone().replace(tzinfo=None)


def collect_rime_commits(
    *,
    start: date,
    end: date,
    commit_log: Path | None = None,
    helper_log: Path | None = None,
) -> dict[str, Any]:
    """Return summary dict for habit-report (empty-ok if logs missing)."""
    out: dict[str, Any] = {
        "available": False,
        "commit_events": 0,
        "commit_chars": 0,
        "by_foreground": {},
        "notes": [],
        "paths": {},
    }

    if commit_log is None or helper_log is None:
        out["notes"].append("paths not resolved")
        return out

    out["paths"] = {
        "commit_log": str(commit_log),
        "helper_log": str(helper_log),
    }
    if not commit_log.is_file():
        out["notes"].append(f"missing commit log: {commit_log}")
        return out

    start_dt, end_dt = day_bounds_utc(start, end)
    edges = load_foreground_timeline(helper_log) if helper_log.is_file() else []
    if not edges:
        out["notes"].append(
            "no foreground edges in helper.log — chars counted but unbucketed"
        )

    by_fg: Counter[str] = Counter()
    by_fg_events: Counter[str] = Counter()
    total_chars = 0
    events = 0

    for row in iter_jsonl(commit_log):
        if row.get("source") not in {None, "rime_commit"}:
            # tolerate missing source
            if row.get("source") and row.get("source") != "rime_commit":
                continue
        ts = parse_iso_ts(str(row.get("ts") or ""))
        if not in_window(ts, start_dt, end_dt):
            continue
        try:
            chars = int(row.get("chars") or 0)
        except (TypeError, ValueError):
            continue
        if chars <= 0:
            continue
        events += 1
        total_chars += chars
        local = _rime_ts_to_local_naive(ts) if ts else None
        proc = process_at(edges, local) if local else ""
        bucket = _bucket(proc) if proc else "unknown"
        by_fg[bucket] += chars
        by_fg_events[bucket] += 1

    out["available"] = events > 0 or commit_log.is_file()
    out["commit_events"] = events
    out["commit_chars"] = total_chars
    out["by_foreground"] = {
        k: {"chars": by_fg[k], "events": by_fg_events[k]}
        for k in sorted(by_fg.keys(), key=lambda x: -by_fg[x])
    }
    out["notes"].append(
        "PoC: OS foreground only (wezterm/code/chrome/other). "
        "Agent-pane split inside WezTerm is not joined yet."
    )
    if events == 0 and commit_log.is_file():
        out["notes"].append("commit log exists but no events in window")
    return out


def resolve_default_paths() -> tuple[Path | None, Path | None]:
    """Best-effort paths via env or common WSL mounts (no cmd.exe here)."""
    import os

    commit = os.environ.get("WEZDECK_RIME_COMMIT_LOG", "").strip()
    helper = os.environ.get("WEZDECK_HELPER_LOG", "").strip()
    candidates_commit: list[Path] = []
    candidates_helper: list[Path] = []
    if commit:
        candidates_commit.append(Path(commit))
    if helper:
        candidates_helper.append(Path(helper))

    # Common WSL mounts for this machine layout.
    home = Path.home()
    for user in ("yuns", "Yuns"):
        base = Path(f"/mnt/c/Users/{user}/AppData/Local/wezterm-runtime")
        candidates_commit.append(base / "state" / "rime-commits.jsonl")
        candidates_helper.append(base / "logs" / "helper.log")
    candidates_commit.append(
        home / ".local/state/wezterm-runtime/state/rime-commits.jsonl"
    )

    commit_path = next((p for p in candidates_commit if p.is_file()), None)
    # Prefer creating path hint even if missing: first candidate under LocalAppData
    if commit_path is None:
        for p in candidates_commit:
            if "wezterm-runtime" in str(p):
                commit_path = p
                break
    helper_path = next((p for p in candidates_helper if p.is_file()), None)
    return commit_path, helper_path
