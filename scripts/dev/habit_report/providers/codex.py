"""Codex CLI provider: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl

Do NOT use ~/.codex/history.jsonl — that is prompt recall only.
Tool signal: response_item.payload.type == function_call
  - exec_command / shell-like → classify_command(arguments.cmd)
  - MCP tools appear as function_call names (codex-trace: MCP tool inspection)
Optional compressed siblings rollout-*.jsonl.zst are noted but skipped unless
zstd is available (codex reads them natively; we keep a soft gap note).
"""

from __future__ import annotations

import json
import os
from collections import Counter
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
from ..session import (
    count_urls,
    record_rewrites,
    record_session_flags,
    record_timing,
    record_user_message,
)


def _codex_home() -> Path:
    env = os.environ.get("CODEX_HOME", "").strip()
    if env:
        return Path(env)
    return Path.home() / ".codex"


def collect(
    *,
    start: date,
    end: date,
    root: Path | None = None,
) -> ProviderMetrics:
    m = empty_metrics("codex")
    base = root or (_codex_home() / "sessions")
    if not base.is_dir():
        m.notes.append(f"missing sessions dir: {base}")
        return m

    start_dt, end_dt = day_bounds_utc(start, end)
    sessions: set[str] = set()
    cdp_sessions: set[str] = set()
    iterate_sessions: set[str] = set()
    last_cdp_ts: dict[str, datetime] = {}
    pending_iterate: set[str] = set()
    zst_seen = 0

    for path in base.rglob("rollout-*.jsonl"):
        if path.name.endswith(".jsonl.zst"):
            continue
        if not mtime_in_window(path, start_dt, end_dt):
            continue
        m.files_scanned += 1
        sid = path.stem
        # rollout-2026-09-12T…-<uuid>
        if "-" in sid:
            sid = sid.rsplit("-", 5)
            # keep full stem as session key; also try uuid suffix
            sid = path.stem
        sessions.add(sid)
        file_ts: list[datetime] = []
        file_edits: Counter[str] = Counter()
        had_url = False
        saw = False

        for row in iter_jsonl(path):
            ts = parse_iso_ts(str(row.get("timestamp") or ""))
            if ts is not None and not in_window(ts, start_dt, end_dt):
                continue
            if row.get("type") == "session_meta":
                pl = row.get("payload") if isinstance(row.get("payload"), dict) else {}
                sessions.add(str(pl.get("session_id") or pl.get("id") or sid))
                continue
            if row.get("type") == "event_msg":
                pl = row.get("payload") if isinstance(row.get("payload"), dict) else {}
                if pl.get("type") == "user_message":
                    msg = str(pl.get("message") or "")
                    # Skip long untrusted-transcript wrappers used by review agents.
                    if msg.startswith("The following is the Codex agent history"):
                        continue
                    if ts:
                        file_ts.append(ts)
                        saw = True
                    record_user_message(m.session, msg, images=0)
                    if count_urls(msg):
                        had_url = True
                continue
            if row.get("type") != "response_item":
                continue
            pl = row.get("payload") if isinstance(row.get("payload"), dict) else {}
            if pl.get("type") != "function_call":
                continue
            if ts:
                file_ts.append(ts)
                saw = True
            name = str(pl.get("name") or "?")
            m.tools[name] += 1
            args = pl.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {"_raw": args}
            if not isinstance(args, dict):
                args = {}

            mcp = classify_mcp_tool(name)
            if mcp:
                server, full = mcp
                m.mcp[server] += 1
                m.mcp[full] += 1
                m.session["tool_route"]["mcp_native"] += 1

            # Common Codex shell tool
            cmd = str(args.get("cmd") or args.get("command") or "")
            cmd_labels: list[str] = []
            if name in {"exec_command", "shell_command", "Bash", "shell"} or cmd:
                cmd_labels = classify_command(cmd)
                if "uxc" in cmd_labels:
                    m.session["tool_route"]["uxc"] += 1
                else:
                    m.session["tool_route"]["bash"] += 1
                for label in cmd_labels:
                    m.cli[label] += 1
                    if label == "chrome-devtools":
                        cdp_sessions.add(sid)
                        pending_iterate.add(sid)
                        if ts:
                            last_cdp_ts[sid] = ts
                        m.verify["cdp_calls"] += 1
                sk = skill_from_path(cmd)
                if sk:
                    # Reading SKILL.md (agents/skills, .system, scripts/dev, …) is a skill load.
                    cmd_norm = cmd.replace("\\", "/")
                    if "SKILL.md" in cmd_norm:
                        m.skills[sk] += 1
                    else:
                        m.skills[f"path:{sk}"] += 1
                    if "chrome-devtools" in sk or sk == "chrome-devtools-mcp-skill":
                        cdp_sessions.add(sid)
                        pending_iterate.add(sid)
                        if ts:
                            last_cdp_ts[sid] = ts
                        m.verify["cdp_calls"] += 1
            elif name == "apply_patch":
                m.session["tool_route"]["edit_write"] += 1
            else:
                m.session["tool_route"]["other"] += 1

            # Named skill-ish tools
            if "skill" in name.lower():
                m.skills[str(args.get("skill") or args.get("name") or name)] += 1

            if sid in pending_iterate and name in {
                "exec_command",
                "apply_patch",
                "write_stdin",
            }:
                prev = last_cdp_ts.get(sid)
                if ts and prev and (ts - prev).total_seconds() <= 3600:
                    if "chrome-devtools" not in cmd_labels:
                        iterate_sessions.add(sid)
                        m.verify["iterate_after_cdp"] += 1
                        pending_iterate.discard(sid)

        if saw:
            record_timing(m.session, file_ts)
            record_session_flags(m.session, had_image=False, had_url=had_url)
            if file_edits:
                record_rewrites(m.session, file_edits)

    for _ in base.rglob("rollout-*.jsonl.zst"):
        zst_seen += 1
    if zst_seen:
        m.notes.append(
            f"skipped {zst_seen} rollout-*.jsonl.zst (codex compressed sibling); "
            "decompress or extend provider if needed"
        )

    m.sessions_scanned = len(sessions)
    m.verify["cdp_sessions"] = len(cdp_sessions)
    m.verify["iterate_sessions"] = len(iterate_sessions)
    m.notes.append(
        "source= $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl "
        "(not history.jsonl); exec_command → CLI + skills/.system SKILL.md loads"
    )
    return m
