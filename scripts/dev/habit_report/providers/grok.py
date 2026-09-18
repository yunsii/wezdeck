"""Grok Build provider: ~/.grok/sessions/<encoded-cwd>/<session-id>/

Primary: updates.jsonl tool_call rows with rawInput.
Secondary: events.jsonl tool_started / mcp_*.
Skill: SKILL.md reads + prompt_history.jsonl leading `/name` (cwd-level file).
Session: per-session chat_history (turns/feed/media/active time) + goal_updated.
"""

from __future__ import annotations

from collections import Counter
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
    slash_command_name,
)
from ..schema import ProviderMetrics, empty_metrics
from ..session import (
    count_urls,
    normalize_user_feed_text,
    record_goal_completed,
    record_rewrites,
    record_session_flags,
    record_timing,
    record_user_message,
)


def _row_ts(row: dict, tz) -> datetime | None:
    raw_ts = row.get("timestamp")
    if isinstance(raw_ts, (int, float)):
        return datetime.fromtimestamp(float(raw_ts), tz=tz)
    if isinstance(raw_ts, str):
        return parse_iso_ts(raw_ts)
    return None


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
    goals_seen: set[str] = set()

    # Slash only — prompt_history.jsonl is cwd-scoped, NOT per-session (do not time it).
    for prompt_hist in base.rglob("prompt_history.jsonl"):
        if not mtime_in_window(prompt_hist, start_dt, end_dt):
            continue
        m.files_scanned += 1
        for row in iter_jsonl(prompt_hist):
            if row.get("is_bash"):
                continue
            ts = _row_ts(row, start_dt.tzinfo)
            if ts is not None and not in_window(ts, start_dt, end_dt):
                continue
            name = slash_command_name(str(row.get("prompt") or ""))
            if name:
                m.skills[name] += 1

    for updates in base.rglob("updates.jsonl"):
        if not mtime_in_window(updates, start_dt, end_dt):
            continue
        m.files_scanned += 1
        sid = updates.parent.name
        sessions.add(sid)
        file_ts: list[datetime] = []
        file_edits: Counter[str] = Counter()
        saw = False

        for row in iter_jsonl(updates):
            ts = _row_ts(row, start_dt.tzinfo)
            params = row.get("params") if isinstance(row.get("params"), dict) else {}
            upd = params.get("update") if isinstance(params.get("update"), dict) else {}
            su = upd.get("sessionUpdate")

            if su == "goal_updated" and ts is not None and in_window(ts, start_dt, end_dt):
                if upd.get("last_event") == "goal_completed":
                    gid = str(upd.get("goal_id") or f"{sid}:{ts.isoformat()}")
                    if gid not in goals_seen:
                        goals_seen.add(gid)
                        elapsed = upd.get("elapsed_ms")
                        record_goal_completed(
                            m.session,
                            int(elapsed) if isinstance(elapsed, (int, float)) else None,
                        )
                continue

            if su != "tool_call":
                continue
            if ts is not None and not in_window(ts, start_dt, end_dt):
                continue
            if ts:
                file_ts.append(ts)
                saw = True
            title = str(upd.get("title") or "")
            raw = upd.get("rawInput") if isinstance(upd.get("rawInput"), dict) else {}
            meta = (
                (upd.get("_meta") or {}).get("x.ai/tool")
                if isinstance(upd.get("_meta"), dict)
                else None
            )
            tool_name = title
            if isinstance(meta, dict) and meta.get("name"):
                tool_name = str(meta.get("name"))
            if tool_name:
                m.tools[tool_name] += 1

            if tool_name in {"search_replace", "write"}:
                m.session["tool_route"]["edit_write"] += 1
                fpath = str(raw.get("file_path") or raw.get("path") or raw.get("target_file") or "")
                if fpath and "SKILL.md" not in fpath:
                    file_edits[fpath] += 1
            elif tool_name == "run_terminal_command":
                cmd = str(raw.get("command") or "")
                labels = classify_command(cmd)
                if "uxc" in labels:
                    m.session["tool_route"]["uxc"] += 1
                else:
                    m.session["tool_route"]["bash"] += 1
            elif tool_name in {"use_tool", "search_tool"}:
                m.session["tool_route"]["mcp_native"] += 1
            elif tool_name:
                m.session["tool_route"]["other"] += 1

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
                    m.tools[f"event:{tn}"] += 1
                elif et in {"mcp_server_starting", "mcp_config_resolved"}:
                    server = str(
                        row.get("server")
                        or row.get("name")
                        or row.get("mcp_server")
                        or "mcp"
                    )
                    m.mcp[server] += 1

        # User feed from chat_history (session-scoped).
        chat = updates.parent / "chat_history.jsonl"
        had_image = False
        had_url = False
        if chat.is_file():
            m.files_scanned += 1
            for row in iter_jsonl(chat):
                if row.get("type") != "user" and row.get("role") != "user":
                    continue
                content = row.get("content")
                texts: list[str] = []
                images = 0
                if isinstance(content, str):
                    texts = [content]
                elif isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        bt = block.get("type")
                        if bt == "text":
                            texts.append(str(block.get("text") or ""))
                        elif bt in {"image", "input_image", "image_url"}:
                            images += 1
                text_joined = "\n".join(texts)
                # normalize_user_feed_text drops skill listings / user_info envelopes.
                record_user_message(m.session, text_joined, images=images)
                if images:
                    had_image = True
                cleaned = normalize_user_feed_text(text_joined)
                if cleaned and count_urls(cleaned):
                    had_url = True
                saw = True

        if saw:
            record_timing(m.session, file_ts)
            record_session_flags(m.session, had_image=had_image, had_url=had_url)
            if file_edits:
                record_rewrites(m.session, file_edits)

    m.sessions_scanned = len(sessions)
    m.verify["cdp_sessions"] = len(cdp_sessions)
    m.verify["iterate_sessions"] = len(iterate_sessions)
    m.notes.append(
        "source= ~/.grok/sessions/<cwd>/<session-id>/ "
        "(updates+chat_history+events; slash via cwd prompt_history; "
        "active-time not from prompt_history; goal_elapsed from goal_updated)"
    )
    return m
