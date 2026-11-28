#!/usr/bin/env python3
"""ticket manager — repo-neutral top-level Manager Session lifecycle (stdlib only).

  ticket manager start  --id ID [--profile claude] [--prompt-file F] [--dry-run]
  ticket manager resume --id ID [--profile P] [--dry-run]
  ticket manager park   --id ID [--force] [--dry-run]
  ticket manager status --id ID
  ticket manager gc     [--idle-minutes 30] [--dry-run]

Every interactive agent launch goes strictly through
`scripts/runtime/agent-launcher.sh <profile>` inside the dedicated tmux session
`wezterm_collab_tickets`, with workspace `~/.agent/tickets/workspaces/<id>/`.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import observe  # noqa: E402
import ticket_fs  # noqa: E402

TOOL_ROOT = Path(__file__).resolve().parent.parent
REPO = Path(os.environ.get("WEZDECK_REPO") or TOOL_ROOT.parent.parent)
MANAGER_TMUX_SESSION = os.environ.get("WEZDECK_MANAGER_TMUX_SESSION", "wezterm_collab_tickets")
TERMINAL = {"closed", "rejected", "shipped", "failed"}
PROFILE_RE = re.compile(r"^[A-Za-z0-9_-]{1,48}$")
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def fail(code: int, error: str, **extra: Any) -> None:
    print(json.dumps({"ok": False, "error": error, **extra}, ensure_ascii=False))
    sys.exit(code)


def opt(argv: list[str], name: str, default: str | None = None) -> str | None:
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
    return default


def workspaces_root() -> Path:
    return ticket_fs.tickets_root() / "workspaces"


def workspace_dir(tid: str) -> Path:
    return workspaces_root() / tid


def ensure_charter() -> Path:
    ws_root = workspaces_root()
    ws_root.mkdir(parents=True, exist_ok=True)
    template = TOOL_ROOT / "templates" / "manager-agents.md"
    agents_md = ws_root / "AGENTS.md"
    if template.is_file():
        content = template.read_text(encoding="utf-8")
        if not agents_md.is_file() or agents_md.read_text(encoding="utf-8") != content:
            agents_md.write_text(content, encoding="utf-8")
    claude_link = ws_root / "CLAUDE.md"
    if not claude_link.exists() and not claude_link.is_symlink():
        claude_link.symlink_to("AGENTS.md")
    return agents_md


def _ensure_symlink(link: Path, target: Path) -> None:
    if link.is_symlink() or link.exists():
        if link.is_symlink() and os.readlink(link) == str(target):
            return
        try:
            link.unlink()
        except OSError:
            return
    link.symlink_to(target)


def prepare_workspace(tid: str) -> tuple[Path, dict[str, Any], dict[str, Any]]:
    try:
        meta, _body = ticket_fs.read_ticket(tid)
    except FileNotFoundError:
        fail(2, f"ticket not found: {tid}")
    mj = ticket_fs.read_meta_json(tid)
    ensure_charter()
    ws = workspace_dir(tid)
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "notes").mkdir(exist_ok=True)

    data_dir = ticket_fs.tickets_root() / "_data" / tid
    ticket_md = data_dir / "ticket.md"
    if ticket_md.is_file():
        _ensure_symlink(ws / "ticket.md", ticket_md)
    contract_md = data_dir / "contract.md"
    if contract_md.is_file():
        _ensure_symlink(ws / "contract.md", contract_md)

    repos = [str(r) for r in (mj.get("repos") or []) if r]
    if not repos and meta.get("to"):
        repos = [str(meta["to"])]
    title = str(meta.get("title") or tid)
    entry_lines = [
        f"# Ticket Manager Entrypoint — {tid}",
        "",
        "Follow the shared Manager Charter in `../AGENTS.md`.",
        "",
        f"- **Ticket ID**: `{tid}`",
        f"- **Title**: {title}",
        f"- **Target repos**: {', '.join(repos) if repos else '(identify during planning)'}",
        f"- **Inspect state**: `ticket api show --id {tid}`",
        f"- **Dead ends ledger**: `ticket show --id {tid}` / `../../_data/{tid}/dead_ends.md`",
        "",
        "Use `ticket research`, `ticket fanout`, `ticket reply`, and `ticket close` for all mutations.",
        "",
    ]
    (ws / "CLAUDE.md").write_text("\n".join(entry_lines), encoding="utf-8")
    return ws, meta, mj


def tmux_cmd(*args: str) -> subprocess.CompletedProcess[str]:
    cmd = ["tmux"]
    sock = os.environ.get("WEZDECK_MANAGER_TMUX_SOCKET", "").strip()
    if sock:
        cmd.extend(["-S", sock])
    cmd.extend(args)
    return subprocess.run(cmd, capture_output=True, text=True, check=False)


def pane_alive(pane_id: str | None) -> bool:
    if not pane_id:
        return False
    res = tmux_cmd("display-message", "-p", "-t", pane_id, "#{pane_id}")
    return res.returncode == 0 and res.stdout.strip() == pane_id


def pane_owned_by_ticket(pane_id: str | None, tid: str) -> bool:
    if not pane_alive(pane_id):
        return False
    res = tmux_cmd("display-message", "-p", "-t", str(pane_id), "#{@wezdeck_ticket_id}")
    return res.returncode == 0 and res.stdout.strip() == tid


def profile_family(profile: str) -> str:
    low = profile.lower()
    for fam in ("claude", "codex", "grok", "agy"):
        if low == fam or low.startswith(f"{fam}_") or low.startswith(f"{fam}-"):
            return fam
    return low


def default_profile() -> str:
    value = os.environ.get("MANAGED_AGENT_PROFILE", "").strip()
    if value:
        return value.removesuffix("-resume").removesuffix("_resume")
    path = REPO / "wezterm-x" / "local" / "shared.env"
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("MANAGED_AGENT_PROFILE="):
                parts = shlex.split(line.partition("=")[2], comments=True)
                if parts:
                    return parts[0].removesuffix("-resume").removesuffix("_resume")
    return "claude"


def check_profile_enabled(profile: str) -> None:
    settings_dir = Path(os.environ.get("WEZDECK_AGENT_PROFILE_SETTINGS_DIR") or
                        Path.home() / ".config/wezdeck/agent-profiles")
    path = settings_dir / f"{profile.replace('-', '_')}.json"
    if not path.exists():
        return
    try:
        settings = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        fail(2, f"cannot read manager agent settings: {profile}")
    if not isinstance(settings, dict) or not isinstance(settings.get("disabled", False), bool):
        fail(2, f"invalid manager agent settings: {profile}")
    if settings.get("disabled"):
        fail(3, f"manager agent {profile} is disabled")


def launcher_script() -> Path:
    return REPO / "scripts" / "runtime" / "agent-launcher.sh"


def launch_tmux_manager(
    tid: str,
    ws: Path,
    profile: str,
    resume_id: str | None = None,
) -> tuple[str, str]:
    launcher = launcher_script()
    if not launcher.is_file():
        fail(2, f"agent-launcher.sh missing: {launcher}")
    win_name = f"ticket-{tid[-6:]}"
    env_args: list[str] = [
        "-e", f"WEZDECK_TICKET_ID={tid}",
        "-e", "WEZDECK_ROLE=ticket-manager",
        "-e", f"WEZDECK_REPO={REPO}",
    ]
    if resume_id and SESSION_ID_RE.fullmatch(resume_id):
        env_args.extend(["-e", f"WEZDECK_RESUME_SESSION_ID={resume_id}"])

    has_sess = tmux_cmd("has-session", "-t", MANAGER_TMUX_SESSION).returncode == 0
    if not has_sess:
        res = tmux_cmd(
            "new-session", "-d", "-s", MANAGER_TMUX_SESSION, "-n", win_name,
            "-c", str(ws), *env_args, "-P", "-F", "#{pane_id}",
            str(launcher), profile,
        )
    else:
        res = tmux_cmd(
            "new-window", "-d", "-t", MANAGER_TMUX_SESSION, "-n", win_name,
            "-c", str(ws), *env_args, "-P", "-F", "#{pane_id}",
            str(launcher), profile,
        )
    if res.returncode != 0 or not res.stdout.strip():
        fail(2, f"failed to start manager tmux pane: {res.stderr.strip() or 'tmux error'}")
    pane_id = res.stdout.strip().splitlines()[0].strip()

    tmux_cmd("set-option", "-p", "-t", pane_id, "@wezdeck_ticket_id", tid)
    tmux_cmd("set-option", "-p", "-t", pane_id, "@wezdeck_role", "ticket-manager")
    tmux_cmd("set-option", "-p", "-t", pane_id, "@wezterm_pane_role", f"agent-cli:{profile}")
    tmux_cmd("set-option", "-p", "-t", pane_id, "@wezterm_agent_profile", profile)
    return win_name, pane_id


def attention_status_for_pane(pane_id: str | None) -> str:
    if not pane_id:
        return ""
    att_file = os.environ.get("WEZDECK_ATTENTION_FILE", "").strip()
    candidates = [Path(att_file)] if att_file else [
        Path.home() / ".local/state/wezterm-runtime/state/agent-attention/attention.json"
    ]
    for path in candidates:
        if not path.is_file():
            continue
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for entry in (doc.get("entries") or {}).values():
            if isinstance(entry, dict) and entry.get("tmux_pane") == pane_id:
                return str(entry.get("status") or "")
    return ""


def cmd_start(argv: list[str], *, resume_mode: bool = False) -> dict[str, Any]:
    tid = opt(argv, "--id")
    if not tid:
        fail(1, "--id is required")
    dry_run = "--dry-run" in argv
    ws, _meta, mj = prepare_workspace(tid)
    existing = mj.get("manager_session") if isinstance(mj.get("manager_session"), dict) else {}

    profile = opt(argv, "--profile") or str(existing.get("profile") or default_profile())
    if not PROFILE_RE.fullmatch(profile):
        fail(1, f"invalid profile: {profile}")
    check_profile_enabled(profile)
    backend = profile_family(profile)
    same_backend = not existing or backend == str(existing.get("backend") or profile_family(str(existing.get("profile") or "")))
    resume_id = str(existing.get("id") or "") if resume_mode and same_backend else ""

    # Idempotent: if already live and pane still exists, return existing record.
    if existing.get("state") == "live" and pane_owned_by_ticket(existing.get("tmux_pane"), tid):
        return {"ok": True, "id": tid, "action": "already_live", "manager_session": existing}

    win_name = f"ticket-{tid[-6:]}"
    pane_id = "%dry" if dry_run else ""
    if not dry_run:
        win_name, pane_id = launch_tmux_manager(tid, ws, profile, resume_id=resume_id or None)

    record = {
        "backend": backend,
        "profile": profile,
        "id": str(existing.get("id") or "") if same_backend else "",
        "cwd": str(ws),
        "tmux_session": MANAGER_TMUX_SESSION,
        "tmux_window": win_name,
        "tmux_pane": pane_id,
        "state": "live",
        "updated_at": ticket_fs.now_iso(),
    }
    if not dry_run:
        mj["manager_session"] = record
        ticket_fs.write_meta_json(tid, mj)
        ev_kind = "manager_resumed" if resume_mode else "manager_started"
        observe.write_events(tid, [{"kind": ev_kind, "profile": profile, "backend": backend, "tmux_pane": pane_id}])

    return {
        "ok": True,
        "id": tid,
        "action": "dry_run" if dry_run else ("resumed" if resume_mode else "started"),
        "manager_session": record,
    }


def cmd_park(argv: list[str]) -> dict[str, Any]:
    tid = opt(argv, "--id")
    if not tid:
        fail(1, "--id is required")
    force = "--force" in argv
    dry_run = "--dry-run" in argv
    try:
        ticket_fs.read_ticket(tid)
    except FileNotFoundError:
        fail(2, f"ticket not found: {tid}")
    mj = ticket_fs.read_meta_json(tid)
    ms = mj.get("manager_session") if isinstance(mj.get("manager_session"), dict) else None
    if not ms:
        return {"ok": True, "id": tid, "action": "none", "reason": "no manager session"}

    pane = ms.get("tmux_pane")
    alive = pane_owned_by_ticket(pane, tid)
    if alive and not force:
        st = attention_status_for_pane(pane)
        if st == "running":
            fail(3, "manager session is currently running (use --force to park anyway)", id=tid)

    if not dry_run:
        if alive and pane:
            tmux_cmd("kill-pane", "-t", str(pane))
        ms["state"] = "parked"
        ms["tmux_pane"] = ""
        ms["updated_at"] = ticket_fs.now_iso()
        mj["manager_session"] = ms
        ticket_fs.write_meta_json(tid, mj)
        observe.write_events(tid, [{"kind": "manager_parked", "force": force}])

    return {
        "ok": True,
        "id": tid,
        "action": "dry_run" if dry_run else "parked",
        "manager_session": ms,
    }


def cmd_status(argv: list[str]) -> dict[str, Any]:
    tid = opt(argv, "--id")
    if not tid:
        fail(1, "--id is required")
    mj = ticket_fs.read_meta_json(tid)
    ms = mj.get("manager_session") if isinstance(mj.get("manager_session"), dict) else None
    alive = bool(ms and pane_owned_by_ticket(ms.get("tmux_pane"), tid))
    return {"ok": True, "id": tid, "manager_session": ms, "pane_alive": alive}


def cmd_gc(argv: list[str]) -> dict[str, Any]:
    idle_min = int(opt(argv, "--idle-minutes", "30") or "30")
    dry_run = "--dry-run" in argv
    cutoff = time.time() - idle_min * 60
    data_dir = ticket_fs.tickets_root() / "_data"
    parked: list[str] = []
    if not data_dir.is_dir():
        return {"ok": True, "parked": parked, "dry_run": dry_run}
    for entry in sorted(data_dir.iterdir()):
        if not entry.is_dir() or not entry.name.startswith("req-"):
            continue
        tid = entry.name
        mj = ticket_fs.read_meta_json(tid)
        ms = mj.get("manager_session") if isinstance(mj.get("manager_session"), dict) else None
        if not ms or ms.get("state") != "live":
            continue
        try:
            meta, _ = ticket_fs.read_ticket(tid)
        except (OSError, ValueError):
            continue
        if str(meta.get("status") or "") not in TERMINAL:
            continue
        updated = str(ms.get("updated_at") or meta.get("updated_at") or "")
        try:
            ts = time.mktime(time.strptime(updated[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
        except ValueError:
            ts = 0
        if ts <= cutoff:
            if not dry_run:
                args = ["--id", tid]
                cmd_park(args)
            parked.append(tid)
    return {"ok": True, "parked": parked, "dry_run": dry_run}


def main(argv: list[str]) -> int:
    if not argv:
        fail(1, "usage: ticket manager start|resume|park|status|gc ...")
    sub, rest = argv[0], argv[1:]
    if sub == "start":
        out = cmd_start(rest, resume_mode=False)
    elif sub == "resume":
        out = cmd_start(rest, resume_mode=True)
    elif sub == "park":
        out = cmd_park(rest)
    elif sub == "status":
        out = cmd_status(rest)
    elif sub == "gc":
        out = cmd_gc(rest)
    else:
        fail(1, f"unknown manager subcommand: {sub}")
        return 1
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
