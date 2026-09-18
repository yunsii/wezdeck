"""Join Rime commit-char JSONL with host.foreground + WezTerm pane-focus.

Privacy: commit log has no text; helper.log foreground rows have process
names only; pane-focus JSONL has pane id / role / cmd basename / agent
label only (no titles / cwd).

Buckets:
  - code / chrome / other / unknown — OS foreground outside WezTerm
  - wezterm — OS WezTerm but no pane-focus edge yet
  - wezterm.shell — focused pane classified non-agent
  - wezterm.agent.<claude|codex|grok> — focused agent pane
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

from .common import day_bounds_utc, in_window, iter_jsonl, parse_iso_ts, parse_local_ts

_KV_RE = re.compile(r'(\w+)="([^"]*)"')

_WEZTERM_NAMES = frozenset({"wezterm-gui", "wezterm", "WezTerm"})
_CODE_NAMES = frozenset({"Code", "Code - Insiders", "code"})
_CHROME_NAMES = frozenset({"chrome", "msedge", "brave", "Chromium"})


@dataclass
class FgEdge:
    ts: datetime
    process: str


@dataclass
class PaneEdge:
    ts: datetime
    kind: str  # agent | shell
    agent: str  # claude|codex|grok|""


def _parse_helper_ts(raw: str) -> datetime | None:
    dt = parse_local_ts(raw)
    if dt is None:
        return None
    return dt.replace(tzinfo=None)


def _os_bucket(process: str) -> str:
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


def load_pane_focus_timeline(pane_log: Path) -> list[PaneEdge]:
    edges: list[PaneEdge] = []
    if not pane_log.is_file():
        return edges
    for row in iter_jsonl(pane_log):
        if row.get("source") not in {None, "tmux_focus"}:
            if row.get("source") and row.get("source") != "tmux_focus":
                continue
        ts = parse_iso_ts(str(row.get("ts") or ""))
        if ts is None:
            continue
        local = ts.astimezone().replace(tzinfo=None) if ts.tzinfo else ts
        kind = str(row.get("kind") or "shell")
        agent = str(row.get("agent") or "")
        edges.append(PaneEdge(ts=local, kind=kind, agent=agent))
    edges.sort(key=lambda e: e.ts)
    return edges


def _edge_at(edges: list, when_local: datetime):
    if not edges:
        return None
    lo, hi = 0, len(edges) - 1
    best = None
    while lo <= hi:
        mid = (lo + hi) // 2
        if edges[mid].ts <= when_local:
            best = edges[mid]
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def process_at(edges: list[FgEdge], when_local: datetime) -> str:
    best = _edge_at(edges, when_local)
    return str(best.process) if best else ""


def pane_at(edges: list[PaneEdge], when_local: datetime) -> PaneEdge | None:
    return _edge_at(edges, when_local)


def refine_bucket(os_bucket: str, pane: PaneEdge | None) -> str:
    """Split wezterm into shell / agent.* when pane-focus timeline exists."""
    if os_bucket != "wezterm":
        return os_bucket
    if pane is None:
        return "wezterm"
    if pane.kind == "agent" and pane.agent:
        return f"wezterm.agent.{pane.agent}"
    if pane.kind == "agent":
        return "wezterm.agent"
    return "wezterm.shell"


def _rime_ts_to_local_naive(ts: datetime) -> datetime:
    if ts.tzinfo is None:
        return ts
    return ts.astimezone().replace(tzinfo=None)


def resolve_pane_focus_log(commit_log: Path | None) -> Path | None:
    """Co-locate with rime-commits under wezterm-runtime/state/."""
    import os

    env = os.environ.get("WEZDECK_PANE_FOCUS_LOG", "").strip()
    if env:
        return Path(env)
    candidates: list[Path] = []
    if commit_log is not None:
        candidates.append(commit_log.parent / "wezterm-pane-focus.jsonl")
    home = Path.home()
    for user in ("yuns", "Yuns"):
        candidates.append(
            Path(f"/mnt/c/Users/{user}/AppData/Local/wezterm-runtime/state/wezterm-pane-focus.jsonl")
        )
    candidates.append(home / ".local/state/wezterm-runtime/state/wezterm-pane-focus.jsonl")
    return next((p for p in candidates if p.is_file()), candidates[0] if candidates else None)


def collect_rime_commits(
    *,
    start: date,
    end: date,
    commit_log: Path | None = None,
    helper_log: Path | None = None,
    pane_log: Path | None = None,
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

    if pane_log is None:
        pane_log = resolve_pane_focus_log(commit_log)

    out["paths"] = {
        "commit_log": str(commit_log),
        "helper_log": str(helper_log),
        "pane_focus_log": str(pane_log) if pane_log else "",
    }
    if not commit_log.is_file():
        out["notes"].append(f"missing commit log: {commit_log}")
        return out

    start_dt, end_dt = day_bounds_utc(start, end)
    edges = load_foreground_timeline(helper_log) if helper_log.is_file() else []
    pane_edges = load_pane_focus_timeline(pane_log) if pane_log and pane_log.is_file() else []
    if not edges:
        out["notes"].append(
            "no foreground edges in helper.log — chars counted but unbucketed"
        )
    if not pane_edges:
        out["notes"].append(
            "no wezterm-pane-focus.jsonl edges yet — wezterm bucket not split "
            "(switch panes once after upgrade to start sampling)"
        )

    by_fg: Counter[str] = Counter()
    by_fg_events: Counter[str] = Counter()
    total_chars = 0
    events = 0

    for row in iter_jsonl(commit_log):
        if row.get("source") not in {None, "rime_commit"}:
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
        os_bucket = _os_bucket(proc) if proc else "unknown"
        pane = pane_at(pane_edges, local) if local else None
        bucket = refine_bucket(os_bucket, pane)
        by_fg[bucket] += chars
        by_fg_events[bucket] += 1

    out["available"] = events > 0 or commit_log.is_file()
    out["commit_events"] = events
    out["commit_chars"] = total_chars
    out["by_foreground"] = {
        k: {"chars": by_fg[k], "events": by_fg_events[k]}
        for k in sorted(by_fg.keys(), key=lambda x: -by_fg[x])
    }
    out["pane_focus_edges"] = len(pane_edges)
    if pane_edges:
        out["notes"].append(
            "WezTerm bucket refined via tmux focus timeline "
            "(wezterm.agent.* / wezterm.shell); OS FG still gates non-WezTerm apps"
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

    home = Path.home()
    for user in ("yuns", "Yuns"):
        base = Path(f"/mnt/c/Users/{user}/AppData/Local/wezterm-runtime")
        candidates_commit.append(base / "state" / "rime-commits.jsonl")
        candidates_helper.append(base / "logs" / "helper.log")
    candidates_commit.append(
        home / ".local/state/wezterm-runtime/state/rime-commits.jsonl"
    )

    commit_path = next((p for p in candidates_commit if p.is_file()), None)
    if commit_path is None:
        for p in candidates_commit:
            if "wezterm-runtime" in str(p):
                commit_path = p
                break
    helper_path = next((p for p in candidates_helper if p.is_file()), None)
    return commit_path, helper_path
