"""Claude Code provider: ~/.claude/projects/<slug>/<session>.jsonl

Official layout (Claude Code docs, Application data):
  projects/<project>/<session>.jsonl — every message, tool call, tool result
Skill signal: assistant tool_use name=Skill input.skill
MCP signal:   tool name mcp__<server>__<tool>
CLI signal:   Bash input.command via shared classify_command
"""

from __future__ import annotations

from datetime import date, datetime
from pathlib import Path

from ..common import (
    classify_command,
    classify_mcp_tool,
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
    m = empty_metrics("claude")
    base = root or (Path.home() / ".claude" / "projects")
    if not base.is_dir():
        m.notes.append(f"missing projects dir: {base}")
        return m

    start_dt, end_dt = day_bounds_utc(start, end)
    sessions: set[str] = set()
    # session_id → saw chrome-devtools / later edit-like tools
    cdp_sessions: set[str] = set()
    iterate_sessions: set[str] = set()
    last_cdp_ts: dict[str, datetime] = {}
    pending_iterate: set[str] = set()

    for path in base.rglob("*.jsonl"):
        name = path.name
        # Skip set-aside transcripts (official orphaned/superseded naming).
        if ".orphaned-" in name or ".superseded-" in name:
            continue
        if not mtime_in_window(path, start_dt, end_dt):
            continue
        m.files_scanned += 1
        sid = path.stem
        for row in iter_jsonl(path):
            ts = parse_iso_ts(str(row.get("timestamp") or ""))
            if not in_window(ts, start_dt, end_dt):
                continue
            sessions.add(str(row.get("sessionId") or row.get("session_id") or sid))
            if row.get("type") != "assistant":
                continue
            msg = row.get("message") or {}
            content = msg.get("content") if isinstance(msg, dict) else None
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                name_t = str(block.get("name") or "?")
                m.tools[name_t] += 1
                inp = block.get("input") if isinstance(block.get("input"), dict) else {}

                if name_t == "Skill":
                    skill = str(inp.get("skill") or inp.get("name") or "?")
                    m.skills[skill] += 1
                    if "chrome-devtools" in skill:
                        cdp_sessions.add(sid)
                        pending_iterate.add(sid)
                        last_cdp_ts[sid] = ts  # type: ignore[assignment]
                        m.verify["cdp_calls"] += 1
                mcp = classify_mcp_tool(name_t)
                if mcp:
                    server, full = mcp
                    m.mcp[server] += 1
                    m.mcp[full] += 1
                    if "chrome" in server or "devtools" in server:
                        cdp_sessions.add(sid)
                        pending_iterate.add(sid)
                        last_cdp_ts[sid] = ts  # type: ignore[assignment]
                        m.verify["cdp_calls"] += 1

                if name_t == "Bash":
                    cmd = str(inp.get("command") or "")
                    for label in classify_command(cmd):
                        m.cli[label] += 1
                        if label == "chrome-devtools":
                            cdp_sessions.add(sid)
                            pending_iterate.add(sid)
                            last_cdp_ts[sid] = ts  # type: ignore[assignment]
                            m.verify["cdp_calls"] += 1
                    sk = skill_from_path(cmd)
                    if sk:
                        m.skills[f"path:{sk}"] += 1

                # One iterate credit per CDP bout (first Edit/Write/Bash/Skill after).
                if sid in pending_iterate and name_t in {
                    "Edit",
                    "Write",
                    "Bash",
                    "Skill",
                }:
                    prev = last_cdp_ts.get(sid)
                    if ts and prev and (ts - prev).total_seconds() <= 3600:
                        # Skip if this tool_use itself is the CDP call.
                        is_cdp = (
                            name_t == "Skill"
                            and "chrome-devtools" in str(inp.get("skill") or "")
                        ) or (
                            name_t == "Bash"
                            and "chrome-devtools" in classify_command(
                                str(inp.get("command") or "")
                            )
                        )
                        if not is_cdp:
                            iterate_sessions.add(sid)
                            m.verify["iterate_after_cdp"] += 1
                            pending_iterate.discard(sid)

    m.sessions_scanned = len(sessions)
    m.verify["cdp_sessions"] = len(cdp_sessions)
    m.verify["iterate_sessions"] = len(iterate_sessions)
    m.notes.append(
        "source= ~/.claude/projects/**/<session>.jsonl "
        "(official transcript; default cleanupPeriodDays=30)"
    )
    return m
