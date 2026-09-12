#!/usr/bin/env python3
"""Project a day workflow timeline from existing WezDeck / OpenClaw logs.

Reads wezterm.log + runtime.log + helper.log + session-bridge-audit.jsonl
(optional) and emits a compact event stream suitable for reconstructing the
daily loop:

  workspace/tab → worktree select|create (+ resume / focus restore)
  → in-slot attention jumps → host verify / OS foreground → recycle / interop

Privacy: drops audit preview, never exports last_user_prompt / chat text.
No window titles from foreground sampling.
"""

from __future__ import annotations

import argparse
import json
import re
import signal
import sys
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

# Allow `… | head` without a noisy BrokenPipe traceback.
if hasattr(signal, "SIGPIPE"):
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)

KV_RE = re.compile(r'(\w+)="((?:\\.|[^"\\])*)"')
TS_RE = re.compile(r'^ts="([^"]+)"')

# Hotkey ids that belong on the human day loop (not clipboard / font / etc.).
HOTKEY_KIND = {
    "attention.jump-waiting": ("attention.jump", {"status": "waiting"}),
    "attention.jump-done": ("attention.jump", {"status": "done"}),
    "attention.jump-running": ("attention.jump", {"status": "running"}),
    "attention.jump-running-prev": (
        "attention.jump",
        {"status": "running", "reverse": "1"},
    ),
    "attention.overlay": ("attention.overlay", {}),
    "tab.overflow-picker": ("tab.overflow", {}),
    "tab.select-by-index": ("tab.select", {}),
    "tab.next": ("tab.select", {"dir": "next"}),
    "tab.previous": ("tab.select", {"dir": "prev"}),
    "worktree.picker": ("worktree.picker_open", {}),
    "worktree.quick-create-dev": ("worktree.create", {"slug_kind": "dev"}),
    "worktree.quick-create-task": ("worktree.create", {"slug_kind": "task"}),
    "worktree.quick-create-hotfix": ("worktree.create", {"slug_kind": "hotfix"}),
    "worktree.reclaim-current": ("worktree.reclaim", {"via": "hotkey"}),
    "vscode.open-current-dir": ("host.vscode", {"via": "hotkey"}),
    "chrome.open-debug-profile": ("host.chrome", {"mode": "H"}),
    "chrome.open-debug-profile-visible": ("host.chrome", {"mode": "V"}),
    "session.claw-take": ("interop.take", {"via": "hotkey"}),
}

WORKSPACE_HOTKEY_PREFIX = "workspace.switch-"


def parse_kv_line(line: str) -> dict[str, str] | None:
    m = TS_RE.match(line)
    if not m:
        return None
    fields = {"ts": m.group(1)}
    for key, raw in KV_RE.findall(line):
        if key == "ts":
            continue
        fields[key] = raw.encode("utf-8").decode("unicode_escape")
    return fields


def parse_local_ts(ts: str) -> datetime | None:
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(ts, fmt)
        except ValueError:
            continue
    return None


def parse_iso_ts(ts: str) -> datetime | None:
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def local_day_bounds(day: date) -> tuple[datetime, datetime]:
    start = datetime(day.year, day.month, day.day, 0, 0, 0)
    end = start + timedelta(days=1)
    return start, end


def iter_day_kv_lines(path: Path, day: date) -> Iterator[dict[str, str]]:
    if not path.is_file():
        return
    prefix = f'ts="{day.isoformat()}'
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if prefix not in line:
                continue
            fields = parse_kv_line(line.rstrip("\n"))
            if fields:
                yield fields


def event(
    ts: str,
    kind: str,
    source: str,
    **extra: Any,
) -> dict[str, Any]:
    row: dict[str, Any] = {"ts": ts, "kind": kind, "source": source}
    for key, value in extra.items():
        if value is None or value == "":
            continue
        row[key] = value
    return row


def project_wezterm(path: Path, day: date) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for f in iter_day_kv_lines(path, day):
        cat = f.get("category", "")
        msg = f.get("message", "")
        ts = f["ts"]

        if cat == "hotkey" and msg == "dispatched":
            hid = f.get("hotkey_id", "")
            if hid in HOTKEY_KIND:
                kind, extra = HOTKEY_KIND[hid]
                out.append(
                    event(
                        ts,
                        kind,
                        "wezterm",
                        hotkey_id=hid,
                        workspace=f.get("workspace"),
                        pane_id=f.get("pane_id"),
                        duration_ms=f.get("duration_ms"),
                        **extra,
                    )
                )
            elif hid.startswith(WORKSPACE_HOTKEY_PREFIX):
                # Prefer workspace open completed for the business event;
                # keep a thin breadcrumb when open-completed is missing.
                out.append(
                    event(
                        ts,
                        "workspace.hotkey",
                        "wezterm",
                        hotkey_id=hid,
                        workspace=f.get("workspace") or hid.split("-", 1)[-1],
                        pane_id=f.get("pane_id"),
                    )
                )
            continue

        if cat == "workspace" and msg == "workspace open completed":
            out.append(
                event(
                    ts,
                    "workspace.enter",
                    "wezterm",
                    workspace=f.get("workspace"),
                    hotkey_id=f.get("hotkey_id"),
                    mode=f.get("mode"),
                    duration_ms=f.get("duration_ms"),
                    trace_id=f.get("trace_id"),
                )
            )
            continue

        if cat == "vscode" and msg == "forwarding Alt+v to tmux-backed pane":
            out.append(
                event(
                    ts,
                    "host.vscode",
                    "wezterm",
                    workspace=f.get("workspace"),
                    trace_id=f.get("trace_id"),
                    via="forward",
                )
            )
            continue

    return out


def project_runtime(path: Path, day: date) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    last_status: dict[str, str] = {}

    for f in iter_day_kv_lines(path, day):
        cat = f.get("category", "")
        msg = f.get("message", "")
        ts = f["ts"]

        if cat == "worktree":
            if msg == "selecting existing worktree window":
                out.append(
                    event(
                        ts,
                        "worktree.select",
                        "runtime",
                        session_name=f.get("session_name"),
                        worktree_root=f.get("worktree_root"),
                        worktree_label=f.get("worktree_label"),
                        window_id=f.get("window_id"),
                        trace_id=f.get("trace_id"),
                    )
                )
            elif msg == "creating worktree window":
                out.append(
                    event(
                        ts,
                        "worktree.create_window",
                        "runtime",
                        session_name=f.get("session_name"),
                        worktree_root=f.get("worktree_root"),
                        worktree_label=f.get("worktree_label"),
                        trace_id=f.get("trace_id"),
                    )
                )
            elif msg == "recreating last_path worktree window":
                out.append(
                    event(
                        ts,
                        "session.focus_restore",
                        "runtime",
                        session_name=f.get("session_name"),
                        worktree_root=f.get("restore_root") or f.get("worktree_root"),
                        restore_path=f.get("restore_path"),
                        restore_label=f.get("restore_label"),
                        trace_id=f.get("trace_id"),
                    )
                )
            elif msg == "worktree switch completed":
                out.append(
                    event(
                        ts,
                        "worktree.switch_done",
                        "runtime",
                        session_name=f.get("session_name"),
                        worktree_root=f.get("worktree_root"),
                        window_id=f.get("window_id"),
                        duration_ms=f.get("duration_ms"),
                        trace_id=f.get("trace_id"),
                    )
                )
            elif msg == "opening worktree popup picker":
                out.append(
                    event(
                        ts,
                        "worktree.picker_open",
                        "runtime",
                        session_name=f.get("session_name"),
                        repo_label=f.get("repo_label"),
                        trace_id=f.get("trace_id"),
                    )
                )
            continue

        if cat == "task":
            if msg == "launch completed":
                out.append(
                    event(
                        ts,
                        "worktree.create",
                        "runtime",
                        worktree_root=f.get("worktree_path") or f.get("worktree_root"),
                        branch=f.get("branch"),
                        duration_ms=f.get("duration_ms"),
                        trace_id=f.get("trace_id"),
                    )
                )
            elif msg == "recycle completed":
                out.append(
                    event(
                        ts,
                        "worktree.recycle",
                        "runtime",
                        worktree_root=f.get("worktree_path") or f.get("worktree_root"),
                        branch=f.get("branch"),
                        before=f.get("before"),
                        after=f.get("after"),
                        remote_sync=f.get("remote_sync"),
                        duration_ms=f.get("duration_ms"),
                        trace_id=f.get("trace_id"),
                    )
                )
            elif msg == "reclaim completed":
                out.append(
                    event(
                        ts,
                        "worktree.reclaim",
                        "runtime",
                        worktree_root=f.get("worktree_path") or f.get("worktree_root"),
                        branch=f.get("branch"),
                        duration_ms=f.get("duration_ms"),
                        trace_id=f.get("trace_id"),
                    )
                )
            continue

        if cat == "primary_pane":
            if msg == "invoking agent":
                cmd = f.get("command", "")
                agent = None
                if "agent-launcher.sh" in cmd:
                    agent = "managed"
                out.append(
                    event(
                        ts,
                        "agent.resume_boot",
                        "runtime",
                        command=Path(cmd).name if cmd else None,
                        agent=agent,
                        pid=f.get("pid"),
                        trace_id=f.get("trace_id"),
                    )
                )
            elif msg == "agent resume boot":
                out.append(
                    event(
                        ts,
                        "agent.resume_boot",
                        "runtime",
                        agent=f.get("agent"),
                        mode=f.get("mode"),
                        cwd=f.get("cwd"),
                        trace_id=f.get("trace_id"),
                    )
                )
            elif msg == "agent resume fallback fresh":
                out.append(
                    event(
                        ts,
                        "agent.resume_fallback_fresh",
                        "runtime",
                        agent=f.get("agent"),
                        mode=f.get("mode"),
                        cwd=f.get("cwd"),
                        trace_id=f.get("trace_id"),
                    )
                )
            continue

        if cat == "hotkey" and msg == "chord pressed":
            hid = f.get("hotkey_id", "")
            if hid in HOTKEY_KIND:
                kind, extra = HOTKEY_KIND[hid]
                out.append(
                    event(
                        ts,
                        kind,
                        "runtime",
                        hotkey_id=hid,
                        via="tmux-chord",
                        trace_id=f.get("trace_id"),
                        **extra,
                    )
                )
            elif hid:
                out.append(
                    event(
                        ts,
                        "hotkey.chord",
                        "runtime",
                        hotkey_id=hid,
                        via="tmux-chord",
                        trace_id=f.get("trace_id"),
                    )
                )
            continue

        if cat == "workspace":
            if msg in {"creating tmux session", "reusing tmux session"}:
                out.append(
                    event(
                        ts,
                        "session.open",
                        "runtime",
                        session_name=f.get("session_name"),
                        worktree_root=f.get("worktree_root"),
                        workspace=f.get("workspace"),
                        mode="create" if msg.startswith("creating") else "reuse",
                        trace_id=f.get("trace_id"),
                    )
                )
            continue

        if cat == "attention" and msg == "hook emitted agent status":
            status = f.get("status", "")
            # User-visible loop statuses only — skip internal mid-turn edges.
            if status not in {"running", "waiting", "done"}:
                continue
            sid = f.get("session_id") or f.get("tmux_session") or f.get("wezterm_pane") or ""
            if not status or not sid:
                continue
            prev = last_status.get(sid)
            if prev == status:
                continue
            last_status[sid] = status
            out.append(
                event(
                    ts,
                    "attention.transition",
                    "runtime",
                    status=status,
                    provider=f.get("provider"),
                    session_id=f.get("session_id"),
                    git_branch=f.get("git_branch"),
                    wezterm_pane=f.get("wezterm_pane"),
                    tmux_pane=f.get("tmux_pane"),
                    raw_event=f.get("raw_event"),
                    trace_id=f.get("trace_id"),
                )
            )
            continue

        if cat == "vscode" and msg == "tmux Alt+v sent helper ipc request":
            out.append(
                event(
                    ts,
                    "host.vscode",
                    "runtime",
                    via="ipc",
                    trace_id=f.get("trace_id"),
                )
            )
            continue

        if cat == "agent_run" and msg == "handoff proposed":
            out.append(
                event(
                    ts,
                    "human_run.propose",
                    "runtime",
                    trace_id=f.get("trace_id"),
                )
            )
            continue

    return out


def project_helper(path: Path, day: date) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for f in iter_day_kv_lines(path, day):
        if f.get("category") != "foreground":
            continue
        if f.get("message") != "foreground changed":
            continue
        out.append(
            event(
                f["ts"],
                "host.foreground",
                "helper",
                from_process=f.get("from_process"),
                to_process=f.get("to_process"),
                from_pid=f.get("from_pid"),
                to_pid=f.get("to_pid"),
                dwell_ms=f.get("dwell_ms"),
            )
        )
    return out


def project_session_bridge(path: Path, day: date) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    start, end = local_day_bounds(day)
    # Interpret naive local bounds as local timezone for ISO compare.
    local_tz = datetime.now().astimezone().tzinfo
    start_aware = start.replace(tzinfo=local_tz)
    end_aware = end.replace(tzinfo=local_tz)

    out: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts_raw = row.get("ts")
            if not isinstance(ts_raw, str):
                continue
            dt = parse_iso_ts(ts_raw)
            if dt is None:
                continue
            if not (start_aware <= dt < end_aware):
                continue
            action = row.get("action") or "unknown"
            # Local wall timestamp for merge-sort with kv logs.
            local_ts = dt.astimezone(local_tz).strftime("%Y-%m-%d %H:%M:%S")
            out.append(
                event(
                    local_ts,
                    f"interop.{action}",
                    "session-bridge",
                    target=row.get("target"),
                    result=row.get("result"),
                    reason=row.get("reason"),
                    identity=row.get("identity"),
                    text_hash=row.get("text_hash") or None,
                    # preview intentionally omitted
                )
            )
    return out


def dedupe_near_duplicates(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop redundant breadcrumbs when a richer event exists nearby."""
    enter_keys = {
        (e["ts"][:19], e.get("workspace"))
        for e in events
        if e["kind"] == "workspace.enter"
    }
    filtered: list[dict[str, Any]] = []
    for e in events:
        if e["kind"] == "workspace.hotkey":
            key = (e["ts"][:19], e.get("workspace"))
            if key in enter_keys:
                continue
        filtered.append(e)

    ipc_times = [
        parse_local_ts(e["ts"])
        for e in filtered
        if e["kind"] == "host.vscode" and e.get("via") == "ipc"
    ]
    ipc_times = [t for t in ipc_times if t is not None]

    # Prefer runtime worktree.picker_open; drop wezterm hotkey twin within 3s.
    runtime_picker_times = [
        parse_local_ts(e["ts"])
        for e in filtered
        if e["kind"] == "worktree.picker_open" and e.get("source") == "runtime"
    ]
    runtime_picker_times = [t for t in runtime_picker_times if t is not None]

    out: list[dict[str, Any]] = []
    for e in filtered:
        t = parse_local_ts(e["ts"])
        if e["kind"] == "host.vscode" and e.get("via") in {"forward", "hotkey"}:
            if t is not None and any(abs((t - it).total_seconds()) <= 3 for it in ipc_times):
                continue
        if (
            e["kind"] == "worktree.picker_open"
            and e.get("source") == "wezterm"
            and t is not None
            and any(abs((t - it).total_seconds()) <= 3 for it in runtime_picker_times)
        ):
            continue
        out.append(e)
    return out


def sort_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def key(e: dict[str, Any]) -> tuple:
        dt = parse_local_ts(e["ts"]) or datetime.min
        return (dt, e.get("kind", ""), e.get("source", ""))

    return sorted(events, key=key)


def format_table(events: Iterable[dict[str, Any]]) -> str:
    rows = list(events)
    if not rows:
        return "(no workflow events)"
    lines = [
        f"{'ts':19}  {'kind':24}  {'source':14}  detail",
        f"{'-'*19}  {'-'*24}  {'-'*14}  {'-'*40}",
    ]
    for e in rows:
        detail_parts = []
        for k in (
            "workspace",
            "session_name",
            "worktree_root",
            "worktree_label",
            "status",
            "hotkey_id",
            "provider",
            "git_branch",
            "target",
            "result",
            "mode",
            "branch",
            "via",
            "slug_kind",
            "restore_label",
            "from_process",
            "to_process",
            "dwell_ms",
            "agent",
            "mode",
            "cwd",
        ):
            if k in e:
                val = str(e[k])
                if k.endswith("_root") or k.endswith("_path") or k == "cwd":
                    # shorten home
                    home = str(Path.home())
                    if val.startswith(home):
                        val = "~" + val[len(home) :]
                detail_parts.append(f"{k}={val}")
        detail = " ".join(detail_parts)
        lines.append(
            f"{e['ts'][:19]:19}  {e['kind'][:24]:24}  {e['source'][:14]:14}  {detail}"
        )
    return "\n".join(lines)


def format_summary(events: list[dict[str, Any]]) -> str:
    c = Counter(e["kind"] for e in events)
    if not c:
        return "(no workflow events)"
    lines = [f"{'count':>6}  kind", f"{'-'*6}  {'-'*28}"]
    for kind, n in c.most_common():
        lines.append(f"{n:6d}  {kind}")
    lines.append(f"{'-'*6}")
    lines.append(f"{sum(c.values()):6d}  TOTAL")
    return "\n".join(lines)


def resolve_day(raw: str) -> date:
    if raw == "today":
        return date.today()
    if raw == "yesterday":
        return date.today() - timedelta(days=1)
    return date.fromisoformat(raw)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--day", default="today", help="today | yesterday | YYYY-MM-DD")
    p.add_argument("--wezterm-log", type=Path, required=True)
    p.add_argument("--runtime-log", type=Path, required=True)
    p.add_argument("--helper-log", type=Path, default=None)
    p.add_argument("--session-bridge-audit", type=Path, default=None)
    p.add_argument("--format", choices=("table", "jsonl", "summary"), default="table")
    p.add_argument("--kind", action="append", default=[], help="filter kind (repeatable)")
    p.add_argument(
        "--include-transitions",
        action="store_true",
        help="keep attention.transition edges (default: omit; use for status forensics)",
    )
    p.add_argument("--write", type=Path, default=None, help="write jsonl to this path")
    p.add_argument("--paths-only", action="store_true")
    args = p.parse_args(argv)

    day = resolve_day(args.day)
    if args.paths_only:
        print(f"day={day.isoformat()}")
        print(f"wezterm_log={args.wezterm_log}")
        print(f"runtime_log={args.runtime_log}")
        print(f"helper_log={args.helper_log or ''}")
        print(f"session_bridge_audit={args.session_bridge_audit or ''}")
        return 0

    events: list[dict[str, Any]] = []
    events.extend(project_wezterm(args.wezterm_log, day))
    events.extend(project_runtime(args.runtime_log, day))
    if args.helper_log:
        events.extend(project_helper(args.helper_log, day))
    if args.session_bridge_audit:
        events.extend(project_session_bridge(args.session_bridge_audit, day))

    events = dedupe_near_duplicates(events)
    events = sort_events(events)

    if not args.include_transitions:
        events = [e for e in events if e["kind"] != "attention.transition"]

    if args.kind:
        allow = set(args.kind)
        events = [e for e in events if e["kind"] in allow]

    if args.write:
        args.write.parent.mkdir(parents=True, exist_ok=True)
        with args.write.open("w", encoding="utf-8") as fh:
            for e in events:
                fh.write(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n")

    try:
        if args.format == "jsonl":
            for e in events:
                print(json.dumps(e, ensure_ascii=False, separators=(",", ":")))
        elif args.format == "summary":
            print(format_summary(events))
        else:
            print(format_table(events))
    except BrokenPipeError:
        try:
            sys.stdout.close()
        except Exception:
            pass
        return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())
