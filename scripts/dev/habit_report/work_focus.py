"""Commit-path distribution for the WezDeck development-habit report."""

from __future__ import annotations

import subprocess
from collections import Counter
from datetime import date
from pathlib import Path
from typing import Any


def _area(path: str) -> str:
    if path.startswith("web/"):
        return "web"
    if path.startswith("native/wezdeck-wsl/"):
        return "relay"
    if path.startswith("native/wezdeck-runtime/"):
        return "runtime"
    if path.startswith("wezterm-x/") or path in {"tmux.conf", "wezterm.lua"}:
        return "terminal"
    if path.startswith("docs/") or path.startswith("README"):
        return "docs"
    if path.startswith(("scripts/", "skills/")):
        return "automation"
    return "other"


def collect_work_focus(repo: Path, *, start: date, end: date) -> dict[str, Any]:
    window = {"start": start.isoformat(), "end": end.isoformat()}
    command = [
        "git", "-C", str(repo), "log", "--no-merges",
        f"--since={start.isoformat()}T00:00:00",
        f"--until={end.isoformat()}T23:59:59",
        "--format=COMMIT %H %cs", "--name-only",
    ]
    try:
        output = subprocess.check_output(
            command, text=True, stderr=subprocess.DEVNULL, timeout=60
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return {"ok": False, "window": window, "reason": "git_log_failed"}

    areas: Counter[str] = Counter()
    daily: dict[str, Counter[str]] = {}
    total = 0
    web_related = 0
    commit_day = ""
    touched: set[str] = set()

    def finish_commit() -> None:
        nonlocal total, web_related
        if not commit_day:
            return
        total += 1
        day = daily.setdefault(commit_day, Counter())
        day["commits"] += 1
        for area in touched:
            areas[area] += 1
        if touched.intersection({"web", "relay", "runtime"}):
            web_related += 1
            day["web_related"] += 1

    for line in output.splitlines():
        if line.startswith("COMMIT "):
            finish_commit()
            _, _, commit_day = line.split(" ", 2)
            touched = set()
        elif line:
            touched.add(_area(line))
    finish_commit()

    return {
        "ok": True,
        "window": window,
        "commits": total,
        "web_related": web_related,
        "areas": dict(areas),
        "daily": [
            {
                "day": day,
                "commits": counts["commits"],
                "web_related": counts["web_related"],
            }
            for day, counts in sorted(daily.items())
        ],
        "counting": "non_merge_commits; areas_overlap",
    }
