"""Grok Build provider: ~/.grok/sessions/<encoded-cwd>/<session-id>/

Primary (aligned with ccusage / grok-utils): updates.jsonl tool_call rows
with rawInput (command / target_file).
Secondary: events.jsonl tool_started for native tool name histogram.
Skill signal: read_file of **/skills/<name>/SKILL.md in updates rawInput.
MCP signal: events mcp_server_starting / mcp_config_resolved.
"""

from __future__ import annotations

from datetime import date, datetime
from pathlib import Path

from ..common import (
    classify_command,
    day_bounds_utc,
    in_window,
    iter_jsonl,
    mtime_in_window,
    parse_iso_ts,
    skill_from_path,
)
from ..schema import ProviderMetrics, empty_metrics


def collect(
    *,
    start: date,
    end: date,
    root: Path | None = None,
) -> ProviderMetrics:
    m = empty_metrics("grok")
    base = root or (Path.home() / ".grok" / "sessions")
    if not base.is_dir():
        m.notes.append(f"missing sessions dir: {base}")
        return m

    start_dt, end_dt = day_bounds_utc(start, end)
    sessions: set[str] = set()
    cdp_sessions: set[str] = set()
    iterate_sessions: set[str] = set()
    last_cdp_ts: dict[str, datetime] = {}
    pending_iterate: set[str] = set()

    for updates in base.rglob("updates.jsonl"):
        if not mtime_in_window(updates, start_dt, end_dt):
            continue
        m.files_scanned += 1
        sid = updates.parent.name
        sessions.add(sid)
        for row in iter_jsonl(updates):
            # Envelope: {timestamp, method, params:{update:{sessionUpdate, title, rawInput}}}
            ts = None
            raw_ts = row.get("timestamp")
            if isinstance(raw_ts, (int, float)):
                ts = datetime.fromtimestamp(float(raw_ts), tz=start_dt.tzinfo)
            elif isinstance(raw_ts, str):
                ts = parse_iso_ts(raw_ts)
            params = row.get("params") if isinstance(row.get("params"), dict) else {}
            upd = params.get("update") if isinstance(params.get("update"), dict) else {}
            if upd.get("sessionUpdate") != "tool_call":
                continue
            if ts is not None and not in_window(ts, start_dt, end_dt):
                continue
            title = str(upd.get("title") or "")
            raw = upd.get("rawInput") if isinstance(upd.get("rawInput"), dict) else {}
            meta = (upd.get("_meta") or {}).get("x.ai/tool") if isinstance(
                upd.get("_meta"), dict
            ) else None
            tool_name = title
            if isinstance(meta, dict) and meta.get("name"):
                tool_name = str(meta.get("name"))
            if tool_name:
                m.tools[tool_name] += 1

            # Skill load via reading SKILL.md
            path = str(raw.get("target_file") or raw.get("path") or "")
            sk = skill_from_path(path)
            if sk:
                m.skills[sk] += 1
                if "chrome-devtools" in sk:
                    cdp_sessions.add(sid)
                    pending_iterate.add(sid)
                    if ts:
                        last_cdp_ts[sid] = ts
                    m.verify["cdp_calls"] += 1

            cmd = str(raw.get("command") or "")
            cmd_labels = classify_command(cmd)
            for label in cmd_labels:
                m.cli[label] += 1
                if label == "chrome-devtools":
                    cdp_sessions.add(sid)
                    pending_iterate.add(sid)
                    if ts:
                        last_cdp_ts[sid] = ts
                    m.verify["cdp_calls"] += 1

            if sid in pending_iterate and tool_name in {
                "run_terminal_command",
                "search_replace",
                "write",
            }:
                prev = last_cdp_ts.get(sid)
                if ts and prev and (ts - prev).total_seconds() <= 3600:
                    if "chrome-devtools" not in cmd_labels:
                        iterate_sessions.add(sid)
                        m.verify["iterate_after_cdp"] += 1
                        pending_iterate.discard(sid)

        # Secondary: events.jsonl tool histogram + mcp_* events
        events = updates.parent / "events.jsonl"
        if events.is_file():
            m.files_scanned += 1
            for row in iter_jsonl(events):
                ts = parse_iso_ts(str(row.get("ts") or ""))
                if ts is not None and not in_window(ts, start_dt, end_dt):
                    continue
                et = row.get("type")
                if et == "tool_started":
                    tn = str(row.get("tool_name") or "?")
                    # Already counted from updates when possible; keep events as
                    # fallback denser stream — only add if updates had none for session.
                    m.tools[f"event:{tn}"] += 1
                elif et in {"mcp_server_starting", "mcp_config_resolved"}:
                    server = str(
                        row.get("server")
                        or row.get("name")
                        or row.get("mcp_server")
                        or "mcp"
                    )
                    m.mcp[server] += 1

    m.sessions_scanned = len(sessions)
    m.verify["cdp_sessions"] = len(cdp_sessions)
    m.verify["iterate_sessions"] = len(iterate_sessions)
    m.notes.append(
        "source= ~/.grok/sessions/**/updates.jsonl (+ events.jsonl); "
        "skills via SKILL.md reads; GROK_HOME relocates root"
    )
    return m
