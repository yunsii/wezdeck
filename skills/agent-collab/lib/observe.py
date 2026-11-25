#!/usr/bin/env python3
"""Collab observability for ticket (stdlib only).

Owns:
  * event envelope + global monotonic ``seq`` (``events.jsonl`` / ``events.head``)
  * the run-event sink called by host-agent-invoke's run_observe.py
  * content-addressed, redacted prompt store (``prompts/<sha256>.md``)
  * session reuse decision + per-role session state in ``meta.json``
  * per-run launch extras (trigger chain, prompt composition, reuse)

CLI (used by worker.sh):
  observe.py prepare-run --ticket ID --phase P --role R --backend B
      --prompt-file F [--worktree W] [--template T] [--view-file V] [--force-fresh]
  observe.py finish-run --ticket ID --role R --run-id RUN
  observe.py legacy-check [--force]   (pre-rename worktree detector; daily from common.sh)
  observe.py legacy-migrate [--dry-run]  (delegate-* → ticket-* worktrees, branches, manifests)
  observe.py retention [--force]      (also runs at most daily from prepare-run)
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

SCHEMA_VERSION = 1
TEXT_CAP = 400
RESUME_MAX_TOKENS_DEFAULT = 80_000
TTL_SECONDS = {"1h": 3600, "5m": 300}

# Mirrors skills/repo-hygiene/lib/secrets-heuristics.sh + common token shapes.
REDACT_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("private_key", re.compile(r"-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----.*?-----END[^-]*-----", re.S)),
    ("aws_key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("github_token", re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}")),
    ("slack_token", re.compile(r"xox[baprs]-[0-9A-Za-z-]{10,}")),
    ("api_key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}")),
    ("assignment", re.compile(r"(?i)\b([A-Z0-9_]*(?:api[_-]?key|token|secret|password|passphrase))(\s*[:=]\s*)['\"]?([^\s'\"]{12,})")),
]


def root() -> Path:
    return Path(os.environ.get("TICKETS_ROOT", Path.home() / ".agent" / "tickets"))


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def cap(text: Any, n: int = TEXT_CAP) -> str:
    s = "" if text is None else str(text)
    return s if len(s) <= n else s[: n - 1] + "…"


@contextmanager
def file_lock(name: str) -> Iterator[None]:
    d = root() / ".locks"
    d.mkdir(parents=True, exist_ok=True)
    with open(d / name, "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _data_dir(tid: str) -> Path:
    return root() / "_data" / tid


def _meta_json(tid: str) -> dict[str, Any]:
    p = _data_dir(tid) / "meta.json"
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def _write_meta_json(tid: str, meta: dict[str, Any]) -> None:
    p = _data_dir(tid) / "meta.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(p)


# ------------------------------------------------------------------ events


def _shrink(ev: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in ev.items():
        if isinstance(v, str):
            out[k] = cap(v)
        else:
            out[k] = v
    raw = json.dumps(out, ensure_ascii=False)
    if len(raw) > 20_000:
        out = {k: out[k] for k in ("type", "ts", "id") if k in out}
        out["truncated"] = True
    return out


# Kinds mirrored into runtime.log (category ``collab``) so diagnostics,
# workflow-timeline and habit-report see collab transitions without tool noise.
LOG_KINDS = {
    "created", "claimed", "renewed", "released", "status", "reply", "challenge", "closed",
    "research_start", "research_done", "implement_start", "implement_done",
    "worktree_ready", "run_start", "run_end", "error", "queued", "dispatched", "child_joined", "merge",
    "legacy_compat",
}
VIA_KINDS = {"created", "claimed", "released", "reply", "challenge", "status", "closed"}
LOG_FIELDS = (
    "status", "phase", "owner", "decision", "verdict", "backend", "model", "reuse",
    "reuse_reason", "trigger", "exit", "turns", "cache_hit_rate", "cost_usd", "wall_ms",
    "rss_peak_mb", "tool_calls", "where", "message", "gate", "result", "from", "to", "via",
)


def _runtime_log(rows: list[dict[str, Any]]) -> None:
    if os.environ.get("TICKET_RUNTIME_LOG", "1") == "0" or not rows:
        return
    lib = Path(__file__).resolve().parents[3] / "scripts" / "runtime" / "runtime-log-lib.sh"
    if not lib.is_file():
        return
    script = [". \"$1\"", "shift"]
    args: list[str] = [str(lib)]
    for row in rows:
        level = "warn" if row.get("type") == "error" or (row.get("type") == "run_end" and row.get("exit") not in (0, None)) else "info"
        fields = [f"ticket={row.get('id')}"]
        if row.get("run"):
            fields.append(f"run={row['run']}")
        for k in LOG_FIELDS:
            v = row.get(k)
            if v is None or isinstance(v, (dict, list)):
                continue
            fields.append(f"{k}={cap(v, 160)}")
        tokens = row.get("tokens")
        if isinstance(tokens, dict):
            for k in ("input", "cache_read", "cache_write", "output"):
                if tokens.get(k) is not None:
                    fields.append(f"tokens_{k}={tokens[k]}")
        start = len(args)
        args.extend([level, f"collab {row.get('type')}", *fields])
        script.append(f'runtime_log_emit "${{@:{start}:1}}" collab "${{@:{start + 1}:1}}" "${{@:{start + 2}:{len(fields)}}}"')
    try:
        subprocess.run(
            ["bash", "-c", "\n".join(script), "ticket-log", *args],
            env={**os.environ, "WEZTERM_RUNTIME_LOG_SOURCE": "ticket"},
            capture_output=True, timeout=5, check=False,
        )
    except Exception:  # noqa: BLE001 - logging must never break the store
        pass


def write_events(tid: str, events: list[dict[str, Any]], *, run: str | None = None) -> list[int]:
    """Append events (legacy flat dicts with ``type``) to the ticket file and
    the global stream. Adds the v1 envelope: v, seq, ts, ticket, parent, run, kind."""
    if not events:
        return []
    parent = _meta_json(tid).get("parent")
    r = root()
    r.mkdir(parents=True, exist_ok=True)
    d = _data_dir(tid)
    d.mkdir(parents=True, exist_ok=True)
    seqs: list[int] = []
    with file_lock("events.lock"):
        head_p = r / "events.head"
        try:
            seq = int(json.loads(head_p.read_text(encoding="utf-8")).get("seq", 0))
        except (OSError, ValueError, json.JSONDecodeError):
            seq = 0
        lines = []
        for ev in events:
            seq += 1
            ev = _shrink(dict(ev))
            kind = ev.get("type") or ev.get("kind") or "event"
            # who drove a lifecycle change (terminal vs fe1 web vs scheduler): TICKET_TRIGGER_SOURCE
            if kind in VIA_KINDS and os.environ.get("TICKET_TRIGGER_SOURCE"):
                ev.setdefault("via", os.environ["TICKET_TRIGGER_SOURCE"])
            ev["type"] = kind
            ev.setdefault("ts", now_iso())
            ev.setdefault("id", tid)
            env = {"v": SCHEMA_VERSION, "seq": seq, "ticket": tid, "kind": kind}
            if parent:
                env["parent"] = parent
            if run or ev.get("run"):
                env["run"] = run or ev.get("run")
            env.update(ev)
            lines.append(json.dumps(env, ensure_ascii=False))
            seqs.append(seq)
        blob = "\n".join(lines) + "\n"
        with (d / "events.jsonl").open("a", encoding="utf-8") as f:
            f.write(blob)
        with (r / "events.jsonl").open("a", encoding="utf-8") as f:
            f.write(blob)
        tmp = head_p.with_suffix(".tmp")
        tmp.write_text(json.dumps({"seq": seq, "ts": now_iso()}) + "\n", encoding="utf-8")
        tmp.replace(head_p)
    rows = []
    for ln in lines:
        row = json.loads(ln)
        if row.get("type") in LOG_KINDS:
            rows.append(row)
    _runtime_log(rows)
    return seqs


def sink_events(tid: str, run_id: str, batch: list[dict[str, Any]]) -> None:
    """Called by host-agent-invoke run_observe.py with {kind, data, ts} items."""
    events = []
    for item in batch:
        data = item.get("data") or {}
        ev = {"type": item.get("kind") or "event", "ts": item.get("ts") or now_iso()}
        for k, v in data.items():
            if k not in ev:
                ev[k] = v
        events.append(ev)
    write_events(tid, events, run=run_id)


# ------------------------------------------------------------------ prompts


def redact(text: str) -> tuple[str, list[str]]:
    hits: list[str] = []

    def sub_rule(name: str, pat: re.Pattern[str], s: str) -> str:
        def repl(m: re.Match[str]) -> str:
            hits.append(name)
            if name == "assignment":
                return f"{m.group(1)}{m.group(2)}«redacted:{name}»"
            return f"«redacted:{name}»"
        return pat.sub(repl, s)

    for name, pat in REDACT_RULES:
        text = sub_rule(name, pat, text)
    return text, sorted(set(hits))


def store_text(text: str) -> dict[str, Any]:
    body, hits = redact(text)
    raw = body.encode("utf-8")
    sha = hashlib.sha256(raw).hexdigest()
    d = root() / "prompts"
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{sha}.md"
    if not p.exists():
        tmp = p.with_suffix(".tmp")
        tmp.write_bytes(raw)
        tmp.replace(p)
    return {"sha256": sha, "bytes": len(raw), "redactions": hits}


def _git_blob(path: str) -> str | None:
    try:
        out = subprocess.run(["git", "hash-object", path], capture_output=True, text=True, timeout=5, check=False)
        return out.stdout.strip() or None
    except Exception:  # noqa: BLE001
        return None


# ------------------------------------------------------------------ sessions


def decide_reuse(tid: str, role: str, backend: str, worktree: str | None, *,
                 force_fresh: bool = False, fresh_reason: str = "forced_independent") -> dict[str, Any]:
    if os.environ.get("TICKET_SESSION_REUSE", "1") == "0":
        return {"reuse": "fresh", "reason": "disabled"}
    if force_fresh:
        return {"reuse": "fresh", "reason": fresh_reason}
    prev = (_meta_json(tid).get("sessions") or {}).get(role)
    if not prev or not prev.get("id"):
        return {"reuse": "fresh", "reason": "no_prior"}
    if prev.get("backend") != backend:
        return {"reuse": "fresh", "reason": "backend_changed"}
    if (prev.get("worktree") or None) != (worktree or None):
        return {"reuse": "fresh", "reason": "worktree_changed"}
    idle = int(time.time()) - int(prev.get("last_used_epoch") or 0)
    ttl = TTL_SECONDS.get(prev.get("cache_ttl") or "", 300)
    base = {"from": prev["id"], "idle_s": idle, "history_tokens": prev.get("history_tokens")}
    if idle < ttl:
        return {"reuse": "resume", "reason": "warm_cache", **base}
    limit = int(os.environ.get("TICKET_RESUME_MAX_TOKENS", RESUME_MAX_TOKENS_DEFAULT))
    hist = prev.get("history_tokens")
    if isinstance(hist, int) and hist < limit:
        return {"reuse": "resume", "reason": "small_history", **base}
    return {"reuse": "fresh", "reason": "stale_cache", **base}


def record_session(tid: str, role: str, run_record: dict[str, Any], worktree: str | None) -> None:
    sid = (run_record.get("session") or {}).get("id")
    if not sid:
        return
    meta = _meta_json(tid)
    sessions = meta.setdefault("sessions", {})
    sessions[role] = {
        "backend": run_record.get("backend"),
        "id": sid,
        "worktree": worktree or None,
        "last_used_epoch": int(time.time()),
        "history_tokens": run_record.get("last_context_tokens"),
        "cache_ttl": run_record.get("cache_ttl"),
        "last_run": run_record.get("run"),
    }
    _write_meta_json(tid, meta)


def new_run_id() -> str:
    return "run-" + time.strftime("%Y%m%d-%H%M%S", time.gmtime()) + "-" + os.urandom(3).hex()


def trigger_from_env() -> dict[str, Any]:
    src = os.environ.get("TICKET_TRIGGER_SOURCE")
    if not src:
        if os.environ.get("TICKET_PARENT_SCHEDULER"):
            src = "parent"
        elif os.environ.get("AI_AGENT") or os.environ.get("CLAUDE_CODE_SESSION_ID"):
            src = "agent-tui"
        elif os.environ.get("TMUX_PANE"):
            src = "human-cli"
        else:
            src = "cli"
    return {
        "source": src,
        "actor": os.environ.get("AI_AGENT") or ("human" if src == "human-cli" else None),
        "origin_session": os.environ.get("CLAUDE_CODE_SESSION_ID") or os.environ.get("WEZDECK_RESUME_SESSION_ID"),
        "origin_cwd": os.environ.get("TICKET_ORIGIN_CWD"),
        "cmdline": cap(os.environ.get("TICKET_CMDLINE"), 300) or None,
    }


# ------------------------------------------------------------------ retention


def retention(*, force: bool = False) -> dict[str, int]:
    """Prune run streams / launch records / global events older than
    TICKET_KEEP_DAYS (default 30) and prompts no launch record references.
    Run records (``runs/<run>.json``) stay until the ticket is archived.
    Throttled to once a day via ``.locks/retention.stamp`` unless forced."""
    days = int(os.environ.get("TICKET_KEEP_DAYS", "30"))
    r = root()
    stamp = r / ".locks" / "retention.stamp"
    now = time.time()
    if not force and stamp.is_file() and now - stamp.stat().st_mtime < 86400:
        return {"skipped": 1}
    stamp.parent.mkdir(parents=True, exist_ok=True)
    stamp.touch()
    cutoff = now - days * 86400
    out = {"streams": 0, "launches": 0, "prompts": 0, "events": 0}
    referenced: set[str] = set()
    for runs in (r / "_data").glob("*/runs"):
        for p in runs.iterdir():
            if p.name.endswith((".stream.jsonl", ".events.jsonl", ".final.txt")):
                if p.stat().st_mtime < cutoff:
                    p.unlink(missing_ok=True)
                    out["streams"] += 1
            elif p.name.endswith(".launch.json"):
                if p.stat().st_mtime < cutoff:
                    p.unlink(missing_ok=True)
                    out["launches"] += 1
                    continue
                try:
                    sha = (json.loads(p.read_text(encoding="utf-8")).get("prompt") or {}).get("store_sha256")
                    if sha:
                        referenced.add(sha)
                except (OSError, json.JSONDecodeError):
                    pass
    pd = r / "prompts"
    if pd.is_dir():
        for p in pd.glob("*.md"):
            if p.stem not in referenced and p.stat().st_mtime < cutoff:
                p.unlink(missing_ok=True)
                out["prompts"] += 1
    ev = r / "events.jsonl"
    if ev.is_file():
        cut_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(cutoff))
        with file_lock("events.lock"):
            keep, dropped = [], 0
            with ev.open(encoding="utf-8") as f:
                for line in f:
                    try:
                        ts = json.loads(line).get("ts") or ""
                    except json.JSONDecodeError:
                        ts = ""
                    if ts and ts < cut_iso:
                        dropped += 1
                    else:
                        keep.append(line)
            if dropped:
                tmp = ev.with_suffix(".jsonl.tmp")
                tmp.write_text("".join(keep), encoding="utf-8")
                tmp.replace(ev)
            out["events"] = dropped
    return out


# ------------------------------------------------------------------ rename compat reminder


def _target_paths() -> list[str]:
    cfg = root() / "config.yml"
    if not cfg.is_file():
        return []
    paths = re.findall(r"^\s+path:\s*(\S+)\s*$", cfg.read_text(encoding="utf-8"), flags=re.M)
    return [str(Path(p).expanduser()) for p in paths]


def legacy_worktrees() -> list[str]:
    """Pre-rename `delegate-*` worktrees still registered in any configured target repo."""
    out: list[str] = []
    for repo in _target_paths():
        try:
            r = subprocess.run(["git", "-C", repo, "worktree", "list", "--porcelain"],
                               capture_output=True, text=True, timeout=10, check=False)
        except Exception:  # noqa: BLE001
            continue
        for line in r.stdout.splitlines():
            if line.startswith("worktree ") and Path(line[9:]).name.startswith("delegate-"):
                out.append(line[9:])
    return out


def legacy_migrate(*, dry_run: bool = False) -> dict[str, Any]:
    """One-time rename migration of pre-rename worktrees: delegate-<id> → ticket-<id>.

    Moves the worktree (`git worktree move`), renames a `delegate/<id>` branch to
    `ticket/<id>` (any other branch, e.g. a pushed feature branch, keeps its name),
    renames the `.delegate/` scratch dir to `.ticket/`, and rewrites the
    worktree-task manifest (`.task-meta/<slug>.json`) and the ticket's meta.json.
    Refuses a worktree with uncommitted changes outside `.delegate/` or a process
    whose cwd is inside it."""
    done: list[dict[str, Any]] = []
    for w in legacy_worktrees():
        old = Path(w)
        new = old.with_name("ticket-" + old.name[len("delegate-"):])
        tid = old.name[len("delegate-"):]
        common = subprocess.run(["git", "-C", w, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                                capture_output=True, text=True, check=False).stdout.strip()
        repo = str(Path(common).parent)
        branch = subprocess.run(["git", "-C", w, "rev-parse", "--abbrev-ref", "HEAD"],
                                capture_output=True, text=True, check=False).stdout.strip()
        dirty = [ln for ln in subprocess.run(["git", "-C", w, "status", "--porcelain"], capture_output=True,
                                             text=True, check=False).stdout.splitlines() if ".delegate" not in ln]
        busy = []
        for proc in Path("/proc").iterdir():
            if proc.name.isdigit():
                try:
                    if os.readlink(proc / "cwd").startswith(w):
                        busy.append(proc.name)
                except OSError:
                    pass
        row: dict[str, Any] = {"from": w, "to": str(new), "ticket": tid, "branch": branch}
        if dirty or busy or new.exists():
            row["skipped"] = "dirty" if dirty else ("in use by pid " + ",".join(busy[:3])) if busy else "target exists"
            done.append(row)
            continue
        new_branch = "ticket/" + branch[len("delegate/"):] if branch.startswith("delegate/") else branch
        row["new_branch"] = new_branch
        if not dry_run:
            if new_branch != branch:
                subprocess.run(["git", "-C", repo, "branch", "-m", branch, new_branch], check=True, capture_output=True)
            subprocess.run(["git", "-C", repo, "worktree", "move", w, str(new)], check=True, capture_output=True)
            if (new / ".delegate").is_dir() and not (new / ".ticket").exists():
                (new / ".delegate").rename(new / ".ticket")
            tm_old = old.parent / ".task-meta" / f"{old.name}.json"
            if tm_old.is_file():
                tm = json.loads(tm_old.read_text(encoding="utf-8"))
                tm.update({"task_slug": new.name, "worktree_path": str(new), "branch_name": new_branch})
                (old.parent / ".task-meta" / f"{new.name}.json").write_text(json.dumps(tm, indent=2) + "\n", encoding="utf-8")
                tm_old.unlink()
            if (_data_dir(tid) / "meta.json").is_file():
                meta = _meta_json(tid)
                meta["worktree"] = str(new)
                meta["branch"] = new_branch
                _write_meta_json(tid, meta)
                write_events(tid, [{"type": "worktree_migrated", "from": w, "to": str(new), "branch": new_branch}])
        row["migrated"] = not dry_run
        done.append(row)
    # kept branches of already-reclaimed tickets: rename local-only delegate/* (pushed ones keep their name)
    branches: list[dict[str, Any]] = []
    for repo in _target_paths():
        if not Path(repo, ".git").exists():
            continue
        out = subprocess.run(["git", "-C", repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/delegate/"],
                             capture_output=True, text=True, check=False).stdout.split()
        remote = set(subprocess.run(["git", "-C", repo, "for-each-ref", "--format=%(refname:short)", "refs/remotes/"],
                                    capture_output=True, text=True, check=False).stdout.split())
        for b in out:
            row = {"repo": repo, "branch": b, "new_branch": "ticket/" + b[len("delegate/"):]}
            if any(r.endswith("/" + b) for r in remote):
                row["skipped"] = "pushed"
            elif not dry_run:
                r = subprocess.run(["git", "-C", repo, "branch", "-m", b, row["new_branch"]], capture_output=True, text=True, check=False)
                row["renamed"] = r.returncode == 0
                if r.returncode:
                    row["skipped"] = r.stderr.strip()[-160:]
            branches.append(row)
    return {"dry_run": dry_run, "worktrees": done, "branches": branches}


def legacy_reminder(*, force: bool = False) -> dict[str, Any]:
    """Once a day: if pre-rename delegate-* worktrees still exist (e.g. on another
    machine), tell the user the exact migration command (stderr + runtime.log)."""
    stamp = root() / ".locks" / "legacy-delegate.stamp"
    if not force and stamp.is_file() and time.time() - stamp.stat().st_mtime < 86400:
        return {"skipped": True}
    stamp.parent.mkdir(parents=True, exist_ok=True)
    stamp.touch()
    left = legacy_worktrees()
    if left:
        here = Path(__file__).resolve()
        print(f"[ticket] 发现 {len(left)} 个改名前的 delegate-* worktree（delegate → ticket 已改名），迁移："
              f"python3 {here} legacy-migrate [--dry-run]。不想再看到：TICKET_LEGACY_NOTICE=0。", file=sys.stderr)
        _runtime_log([{"type": "legacy_compat", "id": "-", "message": f"{len(left)} pre-rename delegate-* worktree(s); run legacy-migrate"}])
    return {"remaining": len(left), "worktrees": left}


# ------------------------------------------------------------------ CLI


def _opt(argv: list[str], name: str, default: str | None = None) -> str | None:
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
    return default


def cmd_prepare_run(argv: list[str]) -> int:
    tid = _opt(argv, "--ticket")
    phase = _opt(argv, "--phase") or "?"
    role = _opt(argv, "--role") or "worker"
    backend = _opt(argv, "--backend") or "claude"
    prompt_file = _opt(argv, "--prompt-file")
    worktree = _opt(argv, "--worktree") or None
    template = _opt(argv, "--template")
    view_file = _opt(argv, "--view-file")
    force_fresh = "--force-fresh" in argv
    if not tid or not prompt_file:
        print(json.dumps({"ok": False, "error": "--ticket and --prompt-file required"}))
        return 2
    try:
        retention()
    except Exception as exc:  # noqa: BLE001 - housekeeping never blocks a run
        print(f"[observe] retention failed: {exc}", file=sys.stderr)
    run_id = new_run_id()
    run_dir = _data_dir(tid) / "runs"
    run_dir.mkdir(parents=True, exist_ok=True)
    prompt_text = Path(prompt_file).read_text(encoding="utf-8", errors="replace")
    stored = store_text(prompt_text)
    composition: list[dict[str, Any]] = []
    if template and Path(template).is_file():
        t = Path(template).read_bytes()
        composition.append({
            "kind": "template", "source": str(template), "git_blob": _git_blob(template),
            "bytes": len(t), "sha256": hashlib.sha256(t).hexdigest(),
        })
    if view_file and Path(view_file).is_file():
        v = Path(view_file).read_bytes()
        composition.append({
            "kind": "phase_view", "source": f"ticket:{tid}#{phase}",
            "bytes": len(v), "sha256": hashlib.sha256(v).hexdigest(),
        })
    # generic parts: --part kind=path (repeatable), e.g. system=…/system.md task=…/task.md
    for i, a in enumerate(argv):
        if a == "--part" and i + 1 < len(argv) and "=" in argv[i + 1]:
            kind, path = argv[i + 1].split("=", 1)
            if Path(path).is_file():
                b = Path(path).read_bytes()
                composition.append({"kind": kind, "source": Path(path).name, "bytes": len(b),
                                    "sha256": hashlib.sha256(b).hexdigest()})
    contract_file = _opt(argv, "--contract-file")
    if contract_file and Path(contract_file).is_file():
        c = Path(contract_file).read_bytes()
        composition.append({
            "kind": "contract", "source": f"parent:{Path(contract_file).parent.name}/contract.md",
            "bytes": len(c), "sha256": hashlib.sha256(c).hexdigest(),
        })
    known = sum(c["bytes"] for c in composition)
    composition.append({"kind": "glue", "bytes": max(stored["bytes"] - known, 0)})
    reuse = decide_reuse(tid, role, backend, worktree, force_fresh=force_fresh,
                         fresh_reason=_opt(argv, "--fresh-reason") or "forced_independent")
    extra = {
        "ticket": tid,
        "parent": _meta_json(tid).get("parent"),
        "phase": phase,
        "role": role,
        "trigger": trigger_from_env(),
        "prompt": {"store_sha256": stored["sha256"], "redactions": stored["redactions"]},
        "composition": composition,
        "session": reuse,
    }
    extra_path = run_dir / f"{run_id}.extra.json"
    extra_path.write_text(json.dumps(extra, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True, "run_id": run_id, "run_dir": str(run_dir), "extra": str(extra_path),
        "reuse": reuse["reuse"], "reason": reuse["reason"],
        "resume_id": reuse.get("from") if reuse["reuse"] == "resume" else "",
    }, ensure_ascii=False))
    return 0


def cmd_finish_run(argv: list[str]) -> int:
    tid = _opt(argv, "--ticket")
    role = _opt(argv, "--role") or "worker"
    run_id = _opt(argv, "--run-id")
    worktree = _opt(argv, "--worktree") or None
    if not tid or not run_id:
        print(json.dumps({"ok": False, "error": "--ticket and --run-id required"}))
        return 2
    run_dir = _data_dir(tid) / "runs"
    p = run_dir / f"{run_id}.json"
    extra = run_dir / f"{run_id}.extra.json"
    if extra.is_file():
        extra.unlink()  # merged into launch.json already
    if not p.is_file():
        print(json.dumps({"ok": False, "error": "run record missing", "run": run_id}))
        return 0
    rec = json.loads(p.read_text(encoding="utf-8"))
    record_session(tid, role, rec, worktree)
    t = rec.get("tokens") or {}
    out = {
        "ok": True, "run": run_id, "exit": rec.get("exit"), "backend": rec.get("backend"),
        "reuse": (rec.get("session") or {}).get("reuse"),
        "reason": (rec.get("session") or {}).get("reason"),
        "turns": rec.get("turns"), "input": t.get("input"), "cache_read": t.get("cache_read"),
        "cache_write": t.get("cache_write"), "output": t.get("output"),
        "cache_hit_rate": rec.get("cache_hit_rate"), "cost_usd": rec.get("cost_usd"),
        "wall_ms": rec.get("wall_ms"), "rss_peak_mb": rec.get("rss_peak_mb"),
        "tool_calls": rec.get("tool_calls"),
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "prepare-run":
        return cmd_prepare_run(rest)
    if cmd == "finish-run":
        return cmd_finish_run(rest)
    if cmd == "legacy-migrate":
        print(json.dumps(legacy_migrate(dry_run="--dry-run" in rest), ensure_ascii=False, indent=2))
        return 0
    if cmd == "legacy-check":
        print(json.dumps(legacy_reminder(force="--force" in rest), ensure_ascii=False))
        return 0
    if cmd == "retention":
        print(json.dumps(retention(force="--force" in rest)))
        return 0
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
