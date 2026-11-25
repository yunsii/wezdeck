#!/usr/bin/env python3
"""ticket attach — resume a ticket's headless agent session in a tmux window.

  ticket attach --id ID [--role ROLE] [--select] [--dry-run] [--force]

The escape hatch when a structured question is not enough: the ticket's
agent conversation (meta.json `sessions.<role>`) opens as an ordinary
interactive agent in a new window of the target repo's tmux session, so
attention, the phone session page and the keyboard all treat it like any
other managed agent.

  session  newest `sessions.<role>` with an id (or --role)
  cwd      the ticket worktree, else the cwd recorded in the agent's own
           transcript (research-only tickets run in the main checkout)
  tmux     the live session whose name ends with the repo's hash
           (scripts/runtime/tmux-worktree/print-session-names.sh), most
           recently active first; none open → error, open the repo first
  command  scripts/runtime/agent-launcher.sh <backend> with
           WEZDECK_RESUME_SESSION_ID=<id> (the F5 typed-resume path), so the
           AGENTS.md rule "every agent launch goes through agent-launcher"
           holds and the window gets the same env as any managed pane

A non-terminal ticket is then session-claimed (`claim --by tmux:<pane>`), which
makes `reply --continue` / `run` refuse instead of writing into the same
conversation from a second process. Refuses while a headless run is in flight
unless --force. Prints one JSON object; exit 0 ok, 2 not found / not
attachable, 3 conflict (run in flight).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import unquote

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ticket_fs  # noqa: E402

TOOL_ROOT = Path(__file__).resolve().parent.parent
REPO = Path(os.environ.get("WEZDECK_REPO") or TOOL_ROOT.parent.parent)
TERMINAL = {"closed", "rejected", "shipped", "failed"}
PROFILES = {"claude": "claude", "codex": "codex", "grok": "grok"}
COPIES: list[tuple[Path, Path]] = []  # transcript moves, done only on a real attach
# an agent CLI session id: meta.json is written by ticket workers, and the id
# is joined into globs, file copies and tmux -e, so nothing else gets through
SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def fail(code: int, error: str, **extra: Any) -> None:
    print(json.dumps({"ok": False, "error": error, **extra}, ensure_ascii=False))
    sys.exit(code)


def opt(argv: list[str], name: str) -> str | None:
    if name in argv:
        i = argv.index(name)
        return argv[i + 1] if i + 1 < len(argv) else None
    return None


def pick_session(sessions: dict[str, Any], role: str | None) -> tuple[str, dict[str, Any]]:
    cands = [(r, s) for r, s in sessions.items() if isinstance(s, dict) and s.get("id")]
    if role:
        cands = [c for c in cands if c[0] == role]
    if not cands:
        fail(2, "no agent session recorded for this ticket" + (f" (role {role})" if role else ""))
    return max(cands, key=lambda c: c[1].get("last_used_epoch") or 0)


def first_json_lines(path: Path, limit: int = 200):
    try:
        with path.open(encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i >= limit:
                    return
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except OSError:
        return


def transcript_cwd(backend: str, sid: str) -> str:
    home = Path.home()
    if backend == "claude":
        for p in home.glob(f".claude/projects/*/{sid}.jsonl"):
            for obj in first_json_lines(p):
                if isinstance(obj, dict) and obj.get("cwd"):
                    return str(obj["cwd"])
    elif backend == "codex":
        for p in home.glob(f".codex/sessions/*/*/*/rollout-*-{sid}.jsonl"):
            for obj in first_json_lines(p, 5):
                cwd = (obj.get("payload") or {}).get("cwd") if isinstance(obj, dict) else None
                if cwd:
                    return str(cwd)
    elif backend == "grok":
        for p in home.glob(f".grok/sessions/*/{sid}"):
            return unquote(p.parent.name)
    return ""


def target_repo_path(key: str) -> str:
    out = run(["bash", "-c", 'source "$1/lib/common.sh"; ticket_target_path "$2"', "_", str(TOOL_ROOT), key])
    path = out.stdout.strip()
    return path if out.returncode == 0 and Path(path).is_dir() else ""


def claude_project_dir(cwd: str) -> Path:
    # Claude Code's project-dir encoding: every / and . becomes -
    return Path.home() / ".claude" / "projects" / cwd.replace("/", "-").replace(".", "-")


def session_cwd(meta: dict[str, Any], mj: dict[str, Any], sess: dict[str, Any],
                backend: str, sid: str) -> tuple[str, str]:
    for source, path in (("ticket_worktree", mj.get("worktree")), ("session_worktree", sess.get("worktree"))):
        if path and Path(path).is_dir():
            return str(path), source
    cwd = transcript_cwd(backend, sid)
    if cwd and Path(cwd).is_dir():
        return cwd, "transcript"
    # Research runs in a throwaway worktree (/tmp/delegate-research-*/wt) that
    # is gone by now: continue in the target repo's main checkout instead.
    repos = mj.get("repos") or []
    repo = target_repo_path(str(meta.get("to") or (repos[0] if repos else "")))
    if not repo:
        fail(2, "cannot tell which directory the session ran in (no worktree, no transcript cwd, no target repo path)")
    if backend == "claude" and cwd:
        # claude --resume looks only in the cwd's project dir; carry the
        # conversation over (a copy — the original dir no longer exists)
        COPIES.append((claude_project_dir(cwd) / f"{sid}.jsonl", claude_project_dir(repo) / f"{sid}.jsonl"))
        return repo, "target_repo (transcript copied from a removed worktree)"
    if backend == "grok":
        fail(2, "the grok session ran in a worktree that no longer exists; grok resumes per directory")
    return repo, "target_repo"


def run(cmd: list[str], **kw: Any) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def tmux_session_for(cwd: str) -> str:
    names = run(["bash", str(REPO / "scripts/runtime/tmux-worktree/print-session-names.sh"), "x", cwd])
    line = (names.stdout.strip().splitlines() or [""])[0]
    name = line.split("\t", 1)[1] if "\t" in line else ""
    if not name:
        fail(2, f"cannot derive the tmux session name for {cwd}")
    # wezterm_<workspace>_<repo>_<hash>: the workspace part varies, the rest does not
    suffix = "_" + name.split("_", 2)[2]
    live = run(["tmux", "list-sessions", "-F", "#{session_activity}\t#{session_name}"])
    matches = sorted(
        (ln.split("\t", 1) for ln in live.stdout.splitlines() if "\t" in ln and ln.endswith(suffix)),
        reverse=True,
    )
    if not matches:
        fail(2, "the target repo has no tmux session open; open it from its workspace first",
             expected_suffix=suffix, cwd=cwd)
    return matches[0][1]


def main(argv: list[str]) -> None:
    tid = opt(argv, "--id")
    if not tid or not ticket_fs.data_dir(tid).joinpath("ticket.md").is_file():
        fail(2, f"ticket {tid} not found")
    role = opt(argv, "--role")
    dry = "--dry-run" in argv
    meta, _ = ticket_fs.read_ticket(tid)
    mj = ticket_fs.read_meta_json(tid)
    runs_dir = ticket_fs.data_dir(tid) / "runs"
    running = sorted(
        p.name[: -len(".launch.json")] for p in runs_dir.glob("run-*.launch.json")
        if not (runs_dir / p.name.replace(".launch.json", ".json")).exists()
    ) if runs_dir.is_dir() else []
    if running and "--force" not in argv:
        fail(3, "a headless run is still in flight; wait for it or pass --force", running=running)

    sess_role, sess = pick_session(mj.get("sessions") or {}, role)
    backend = str(sess.get("backend") or "claude")
    profile = PROFILES.get(backend)
    if not profile:
        fail(2, f"backend {backend} cannot be resumed interactively")
    sid = str(sess["id"])
    if not SESSION_ID.match(sid):
        fail(2, "the recorded session id is not a valid agent session id")
    cwd, cwd_source = session_cwd(meta, mj, sess, backend, sid)
    tmux_session = tmux_session_for(cwd)
    launcher = REPO / "scripts/runtime/agent-launcher.sh"
    window_name = f"ticket-{tid.rsplit('-', 1)[-1]}"
    plan = {
        "id": tid, "role": sess_role, "backend": backend, "session_id": sid,
        "cwd": cwd, "cwd_source": cwd_source, "tmux_session": tmux_session,
        "window_name": window_name, "command": [str(launcher), profile],
    }
    if dry:
        print(json.dumps({"ok": True, "dry_run": True, **plan}, ensure_ascii=False))
        return

    for src, dst in COPIES:
        if src.is_file() and not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(src.read_bytes())
    created = run([
        "tmux", "new-window", "-d", "-P", "-F", "#{window_id}\t#{pane_id}",
        "-t", f"{tmux_session}:", "-c", cwd, "-n", window_name,
        "-e", f"WEZDECK_RESUME_SESSION_ID={sid}", str(launcher), profile,
    ])
    if created.returncode != 0 or "\t" not in created.stdout:
        fail(1, "tmux new-window failed", stderr=created.stderr.strip()[:400])
    window_id, pane_id = created.stdout.strip().split("\t", 1)
    # same tag managed windows carry, so Ctrl+n / attention see an agent pane
    run(["tmux", "set-option", "-p", "-t", pane_id, "@wezterm_pane_role", f"agent-cli:{profile}"])
    if "--select" in argv:
        run(["tmux", "select-window", "-t", window_id])

    claimed = False
    if meta.get("status") not in TERMINAL:
        c = run([str(TOOL_ROOT / "run.sh"), "claim", "--id", tid, "--by", f"tmux:{pane_id}", "--steal", "--any-cwd"])
        claimed = c.returncode == 0
    mj = ticket_fs.read_meta_json(tid)
    mj["attached"] = {"tmux_session": tmux_session, "window_id": window_id, "pane_id": pane_id,
                      "session_id": sid, "role": sess_role, "at": ticket_fs.now_iso()}
    ticket_fs.write_meta_json(tid, mj)
    ticket_fs.append_event(tid, {"type": "attached", "tmux_session": tmux_session, "pane": pane_id,
                                 "session_id": sid, "role": sess_role, "claimed": claimed})
    print(json.dumps({"ok": True, **plan, "window_id": window_id, "pane_id": pane_id,
                      "claimed": claimed}, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])
