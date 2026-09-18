"""Claude Code provider: ~/.claude/projects/<slug>/<session>.jsonl

Official layout (Claude Code docs, Application data):
  projects/<project>/<session>.jsonl — every message, tool call, tool result
Skill signal: assistant tool_use name=Skill input.skill
User-invoke:  <command-name>/…</command-name> + <forked-skill-launch>
MCP signal:   tool name mcp__<server>__<tool>
CLI signal:   Bash input.command via shared classify_command
Session:      user turns/chars/images/urls, active time + segments, rewrites
"""

from __future__ import annotations

from collections import Counter
from datetime import date, datetime
from pathlib import Path

from ..common import (
    classify_command,
    classify_mcp_tool,
    day_bounds_utc,
    in_window,
    iter_claude_command_names,
    iter_claude_forked_skills,
    iter_jsonl,
    mtime_in_window,
    parse_iso_ts,
    skill_from_path,
)
from ..schema import ProviderMetrics, empty_metrics
from ..session import (
    count_urls,
    normalize_user_feed_text,
    record_rewrites,
    record_session_flags,
    record_timing,
    record_user_message,
)


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
    cdp_sessions: set[str] = set()
    iterate_sessions: set[str] = set()
    last_cdp_ts: dict[str, datetime] = {}
    pending_iterate: set[str] = set()

    for path in base.rglob("*.jsonl"):
        name = path.name
        if ".orphaned-" in name or ".superseded-" in name:
            continue
        if not mtime_in_window(path, start_dt, end_dt):
            continue
        m.files_scanned += 1
        sid = path.stem

        file_ts: list[datetime] = []
        file_had_image = False
        file_had_url = False
        file_edits: Counter[str] = Counter()
        file_saw_in_window = False

        for row in iter_jsonl(path):
            ts = parse_iso_ts(str(row.get("timestamp") or ""))
            if not in_window(ts, start_dt, end_dt):
                continue
            file_saw_in_window = True
            if ts:
                file_ts.append(ts)
            sessions.add(str(row.get("sessionId") or row.get("session_id") or sid))
            row_type = row.get("type")

            if row_type == "user":
                msg = row.get("message") or {}
                content = msg.get("content") if isinstance(msg, dict) else None
                texts: list[str] = []
                images = 0
                # tool_result-only "user" rows are protocol chatter, not human turns.
                humanish = False
                if isinstance(content, str):
                    texts = [content]
                    humanish = bool(content.strip())
                elif isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        bt = block.get("type")
                        if bt == "text":
                            texts.append(str(block.get("text") or ""))
                            humanish = True
                        elif bt == "image":
                            images += 1
                            humanish = True
                if humanish:
                    text_joined = "\n".join(texts)
                    # Slash commands still counted even when feed text is excluded.
                    for text in texts:
                        for cmd_name in iter_claude_command_names(text):
                            m.skills[cmd_name] += 1
                    record_user_message(m.session, text_joined, images=images)
                    if images:
                        file_had_image = True
                    cleaned = normalize_user_feed_text(text_joined)
                    if cleaned and count_urls(cleaned):
                        file_had_url = True
                continue

            if row_type == "system":
                content = str(row.get("content") or "")
                for sk in iter_claude_forked_skills(content):
                    m.skills[sk] += 1
                continue

            if row_type != "assistant":
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

                if name_t in {"Edit", "Write"}:
                    m.session["tool_route"]["edit_write"] += 1
                    fpath = str(
                        inp.get("file_path") or inp.get("path") or inp.get("filePath") or ""
                    )
                    if fpath:
                        file_edits[fpath] += 1
                elif name_t == "Bash":
                    cmd = str(inp.get("command") or "")
                    labels = classify_command(cmd)
                    if "uxc" in labels:
                        m.session["tool_route"]["uxc"] += 1
                    else:
                        m.session["tool_route"]["bash"] += 1
                elif name_t.startswith("mcp__"):
                    m.session["tool_route"]["mcp_native"] += 1
                else:
                    m.session["tool_route"]["other"] += 1

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

                if sid in pending_iterate and name_t in {
                    "Edit",
                    "Write",
                    "Bash",
                    "Skill",
                }:
                    prev = last_cdp_ts.get(sid)
                    if ts and prev and (ts - prev).total_seconds() <= 3600:
                        is_cdp = (
                            name_t == "Skill"
                            and "chrome-devtools" in str(inp.get("skill") or "")
                        ) or (
                            name_t == "Bash"
                            and "chrome-devtools"
                            in classify_command(str(inp.get("command") or ""))
                        )
                        if not is_cdp:
                            iterate_sessions.add(sid)
                            m.verify["iterate_after_cdp"] += 1
                            pending_iterate.discard(sid)

        if file_saw_in_window:
            record_timing(m.session, file_ts)
            record_session_flags(
                m.session, had_image=file_had_image, had_url=file_had_url
            )
            if file_edits:
                record_rewrites(m.session, file_edits)

    m.sessions_scanned = len(sessions)
    m.verify["cdp_sessions"] = len(cdp_sessions)
    m.verify["iterate_sessions"] = len(iterate_sessions)
    m.notes.append(
        "source= ~/.claude/projects/**/<session>.jsonl "
        "(Skill/slash + session active-time/segments/feed/media/rewrites; "
        "default cleanupPeriodDays=30)"
    )
    return m
