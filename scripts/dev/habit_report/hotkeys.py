"""WezTerm hotkey pressed-row window metrics + lifetime intensity."""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

TS_RE = re.compile(r'^ts="([^"]+)"')
KV_RE = re.compile(r'(\w+)="((?:\\.|[^"\\])*)"')

PEER_IDS = (
    "attention.jump-running",
    "attention.jump-done",
    "attention.jump-waiting",
    "clipboard.paste-smart",
    "vscode.open-current-dir",
    "workspace.switch-work",
    "workspace.switch-config",
    "worktree.picker",
)


def list_wezterm_logs(primary: Path) -> list[Path]:
    paths: list[Path] = []
    if primary.is_file():
        paths.append(primary)
    parent = primary.parent
    if parent.is_dir():
        for p in sorted(
            parent.glob("wezterm.log.[0-9]*"),
            key=lambda x: int(x.name.rsplit(".", 1)[-1])
            if x.name.rsplit(".", 1)[-1].isdigit()
            else 9999,
        ):
            if p.is_file() and p not in paths:
                paths.append(p)
    return paths


def scan_hotkey_window(
    logs: list[Path], start: date, end: date
) -> dict[str, Any]:
    day_ok = {
        (start + timedelta(days=i)).isoformat()
        for i in range((end - start).days + 1)
    }
    by_day: dict[str, Counter[str]] = defaultdict(Counter)
    files_read: list[str] = []
    matched = 0
    for path in logs:
        here = 0
        try:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if 'category="hotkey"' not in line or 'message="pressed"' not in line:
                        continue
                    tm = TS_RE.match(line)
                    if not tm:
                        continue
                    day = tm.group(1)[:10]
                    if day not in day_ok:
                        continue
                    fields = dict(KV_RE.findall(line))
                    hid = fields.get("hotkey_id") or "?"
                    by_day[day][hid] += 1
                    here += 1
        except OSError:
            continue
        if here:
            files_read.append(str(path))
            matched += here

    days = [
        (start + timedelta(days=i)).isoformat()
        for i in range((end - start).days + 1)
    ]
    daily = []
    window_ids: Counter[str] = Counter()
    for day in days:
        counts = by_day.get(day) or Counter()
        total = sum(counts.values())
        alt_l = counts.get("attention.jump-running", 0)
        peers = {hid: int(counts.get(hid, 0)) for hid in PEER_IDS}
        daily.append(
            {
                "day": day,
                "total_hotkeys": total,
                "alt_l": alt_l,
                "alt_l_share_pct": round(100 * alt_l / total, 1) if total else 0.0,
                "peers": peers,
            }
        )
        window_ids.update(counts)
    active = [d for d in daily if d["total_hotkeys"] > 0]
    alt_sum = sum(d["alt_l"] for d in active)
    return {
        "files_read": files_read,
        "lines_matched": matched,
        "daily": daily,
        "top_hotkeys": [
            {"id": k, "count": v} for k, v in window_ids.most_common(12)
        ],
        "alt_l_sum": alt_sum,
        "alt_l_avg_per_active_day": round(alt_sum / len(active), 1) if active else 0.0,
        "total_hotkey_presses": sum(window_ids.values()),
        "active_days": len(active),
    }


def lifetime_intensity(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    now = datetime.now(timezone.utc)
    rows = []
    for hid, info in (data.get("hotkeys") or {}).items():
        if not isinstance(info, dict):
            continue
        count = int(info.get("count") or 0)
        try:
            first = datetime.fromisoformat(
                str(info.get("first_seen") or "").replace("Z", "+00:00")
            )
        except ValueError:
            continue
        if first.tzinfo is None:
            first = first.replace(tzinfo=timezone.utc)
        days = max((now - first).total_seconds() / 86400.0, 1 / 24)
        if days < 1.0:
            continue
        rows.append(
            {
                "id": hid,
                "count": count,
                "days_observed": round(days, 2),
                "per_day": round(count / days, 2),
            }
        )
    rows.sort(key=lambda r: (-r["per_day"], -r["count"]))
    return rows
