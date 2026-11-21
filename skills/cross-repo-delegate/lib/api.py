#!/usr/bin/env python3
"""delegate api — read-only JSON contract for collab observers (stdlib only).

Consumers: wezdeck web (wezdeck-wsl bridge → Runtime /api/v1/collab/*), fe1
local service, the tmux badge, humans with jq. Every response carries
``"v": 1`` and is described by ``schema/<command>.schema.json``. Errors are
``{"v":1,"ok":false,"error":{"code","message"}}`` with exit 0.

  api health [--repo R]
  api list [--status S[,S]] [--repo R] [--parent ID] [--since ISO] [--limit N]
  api show --id ID
  api events --after SEQ [--ticket ID] [--limit N]
  api run --run RUN
  api prompt --sha SHA256
  api transcript --run RUN [--tail N]
  api metrics [--window 1h|24h|7d|30d|all] [--ticket ID] [--parent ID] [--repo R]
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ticket_fs  # noqa: E402

V = 1
CAPABILITIES = ["health", "list", "show", "events", "run", "prompt", "transcript", "metrics"]
TERMINAL = {"closed", "rejected", "shipped", "failed"}
WINDOWS = {"1h": 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, "all": None}


class ApiError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def root() -> Path:
    return ticket_fs.tickets_root()


def opt(argv: list[str], name: str, default: str | None = None) -> str | None:
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
        raise ApiError("bad_request", f"{name} needs a value")
    return default


def int_opt(argv: list[str], name: str, default: int) -> int:
    raw = opt(argv, name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ApiError("bad_request", f"{name} must be an integer") from exc


def parse_iso(ts: Any) -> float | None:
    if not isinstance(ts, str) or not ts:
        return None
    try:
        return time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
    except ValueError:
        return None


TID_RE = re.compile(r"req-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}|req-[A-Za-z0-9_-]{1,64}")


def check_tid(tid: str | None) -> str | None:
    if tid is not None and not TID_RE.fullmatch(tid):
        raise ApiError("bad_request", "invalid ticket id")
    return tid


def ticket_ids() -> list[str]:
    d = root() / "_data"
    if not d.is_dir():
        return []
    return sorted(p.name for p in d.iterdir() if p.is_dir() and p.name.startswith("req-") and (p / "ticket.md").is_file())


def load_meta(tid: str) -> tuple[dict[str, Any], str, dict[str, Any]]:
    meta, body = ticket_fs.read_ticket(tid)
    return meta, body, ticket_fs.read_meta_json(tid)


def run_records(tid: str) -> list[dict[str, Any]]:
    d = root() / "_data" / tid / "runs"
    out: list[dict[str, Any]] = []
    if not d.is_dir():
        return out
    for p in sorted(d.glob("run-*.json")):
        if p.name.endswith((".launch.json", ".extra.json")):
            continue
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            continue
    return out


def in_flight_runs(tid: str) -> list[str]:
    d = root() / "_data" / tid / "runs"
    if not d.is_dir():
        return []
    out = []
    for p in d.glob("run-*.launch.json"):
        rid = p.name[: -len(".launch.json")]
        if not (d / f"{rid}.json").exists():
            out.append(rid)
    return sorted(out)


def run_summary(rec: dict[str, Any]) -> dict[str, Any]:
    keys = ("run", "phase", "role", "backend", "model", "started_at", "ended_at", "wall_ms",
            "turns", "tokens", "cache_hit_rate", "cache_ttl", "cost_usd", "tool_calls",
            "denials", "errors", "rss_peak_mb", "exit")
    out = {k: rec.get(k) for k in keys}
    s = rec.get("session") or {}
    out["session"] = {k: s.get(k) for k in ("id", "reuse", "reason", "from")}
    return out


def summary(tid: str) -> dict[str, Any]:
    meta, _body, mj = load_meta(tid)
    prog = ticket_fs.read_progress(tid) or {}
    runs = run_records(tid)
    return {
        "id": tid,
        "title": meta.get("title"),
        "from": meta.get("from"),
        "to": meta.get("to"),
        "status": meta.get("status"),
        "phase": meta.get("phase"),
        "owner": meta.get("owner"),
        "parent": mj.get("parent") or meta.get("parent"),
        "created_at": meta.get("created_at"),
        "updated_at": meta.get("updated_at"),
        "worktree": mj.get("worktree"),
        "branch": mj.get("branch"),
        "progress": {k: prog.get(k) for k in ("step", "message", "ts")} if prog else None,
        "runs": len(runs),
        "running": in_flight_runs(tid),
        "last_run": run_summary(runs[-1]) if runs else None,
    }


def seq_head() -> int:
    try:
        return int(json.loads((root() / "events.head").read_text(encoding="utf-8")).get("seq", 0))
    except (OSError, ValueError, json.JSONDecodeError):
        return 0


# ------------------------------------------------------------------ commands


def cmd_health(argv: list[str]) -> dict[str, Any]:
    repo = opt(argv, "--repo")
    by_status: dict[str, int] = {}
    running = waiting = 0
    for tid in ticket_ids():
        try:
            meta, _b, _m = load_meta(tid)
        except (OSError, ValueError):
            continue
        if repo and repo not in (meta.get("from"), meta.get("to")):
            continue
        st = str(meta.get("status") or "submitted")
        by_status[st] = by_status.get(st, 0) + 1
        if in_flight_runs(tid):
            running += 1
        if st == "waiting_initiator" or (st == "failed"):
            waiting += 1
    return {
        "store": str(root()),
        "tickets": sum(by_status.values()),
        "by_status": by_status,
        "running": running,
        "queued": 0,
        "waiting_human": waiting,
        "seq_head": seq_head(),
        "capabilities": CAPABILITIES,
        "scope": {"repo": repo},
        "observed_at": ticket_fs.now_iso(),
    }


def cmd_list(argv: list[str]) -> dict[str, Any]:
    statuses = set(filter(None, (opt(argv, "--status") or "").split(",")))
    repo = opt(argv, "--repo")
    parent = check_tid(opt(argv, "--parent"))
    since = parse_iso(opt(argv, "--since"))
    limit = int_opt(argv, "--limit", 50)
    rows = []
    for tid in ticket_ids():
        try:
            s = summary(tid)
        except (OSError, ValueError):
            continue
        if statuses and s["status"] not in statuses:
            continue
        if repo and repo not in (s["to"], s["from"]):
            continue
        if parent and s["parent"] != parent:
            continue
        if since is not None and (parse_iso(s["updated_at"]) or 0) < since:
            continue
        rows.append(s)
    rows.sort(key=lambda r: r.get("updated_at") or r.get("created_at") or "", reverse=True)
    return {"total": len(rows), "tickets": rows[: max(limit, 0)]}


def cmd_show(argv: list[str]) -> dict[str, Any]:
    tid = check_tid(opt(argv, "--id"))
    if not tid:
        raise ApiError("bad_request", "--id required")
    if not (root() / "_data" / tid / "ticket.md").is_file():
        raise ApiError("not_found", f"ticket {tid} not found")
    meta, body, mj = load_meta(tid)
    sections = []
    for title, text in ticket_fs.split_markdown_sections(body):
        if title is None:
            continue
        sections.append({"title": title, "text": text if len(text) <= 8000 else text[:7999] + "…"})
    children = [t for t in ticket_ids() if ticket_fs.read_meta_json(t).get("parent") == tid]
    launches = {}
    d = root() / "_data" / tid / "runs"
    for p in d.glob("run-*.launch.json") if d.is_dir() else []:
        try:
            lj = json.loads(p.read_text(encoding="utf-8"))
            launches[lj.get("run")] = lj
        except json.JSONDecodeError:
            pass
    runs = []
    for rec in run_records(tid):
        r = run_summary(rec)
        lj = launches.get(rec.get("run")) or {}
        r["trigger"] = (lj.get("trigger") or {}).get("source")
        r["prompt_sha256"] = (lj.get("prompt") or {}).get("store_sha256")
        runs.append(r)
    return {
        "ticket": summary(tid),
        "meta": {k: v for k, v in meta.items() if k not in ("lease_until",)},
        "sessions": mj.get("sessions") or {},
        "sections": sections,
        "children": children,
        "children_detail": [
            {**summary(c), "depends_on": ticket_fs.read_meta_json(c).get("depends_on") or [],
             "scope": ticket_fs.read_meta_json(c).get("scope") or []}
            for c in children
        ],
        "collab": {"kind": mj.get("kind"), "contract_sha256": mj.get("contract_sha256"),
                   "integration": mj.get("integration")} if mj.get("kind") == "parent" else None,
        "runs": runs,
        "running": in_flight_runs(tid),
    }


def _read_events(path: Path, after: int, limit: int, ticket: str | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not path.is_file():
        return out
    with path.open(encoding="utf-8") as f:
        for line in f:
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            seq = ev.get("seq")
            if seq is None:
                # legacy (pre-v1) row: only in a per-ticket full read
                if after > 0:
                    continue
                ev = {"v": 0, "seq": None, "ticket": ev.get("id"), "kind": ev.get("type"), **ev}
            elif seq <= after:
                continue
            if ticket and ev.get("ticket") != ticket:
                continue
            out.append(ev)
            if len(out) >= limit:
                break
    return out


def cmd_events(argv: list[str]) -> dict[str, Any]:
    after = int_opt(argv, "--after", 0)
    limit = min(int_opt(argv, "--limit", 500), 5000)
    ticket = check_tid(opt(argv, "--ticket"))
    head = seq_head()
    if ticket:
        path = root() / "_data" / ticket / "events.jsonl"
    else:
        path = root() / "events.jsonl"
    events = [] if (after >= head and not (ticket and after == 0)) else _read_events(path, after, limit, ticket)
    seqs = [e["seq"] for e in events if isinstance(e.get("seq"), int)]
    nxt = max(seqs) if seqs else max(after, 0)
    return {"events": events, "next": nxt, "head": head, "more": len(events) >= limit}


def find_run(run_id: str) -> Path | None:
    if not re.fullmatch(r"run-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}|run-[A-Za-z0-9_-]{1,64}", run_id):
        raise ApiError("bad_request", "invalid run id")
    hits = list((root() / "_data").glob(f"*/runs/{run_id}.launch.json"))
    return hits[0].parent if hits else None


def cmd_run(argv: list[str]) -> dict[str, Any]:
    run_id = opt(argv, "--run")
    if not run_id:
        raise ApiError("bad_request", "--run required")
    d = find_run(run_id)
    if d is None:
        raise ApiError("not_found", f"run {run_id} not found")
    launch = json.loads((d / f"{run_id}.launch.json").read_text(encoding="utf-8"))
    rec_p = d / f"{run_id}.json"
    record = json.loads(rec_p.read_text(encoding="utf-8")) if rec_p.is_file() else None
    return {"ticket": d.parent.name, "launch": launch, "record": record, "running": record is None}


def cmd_prompt(argv: list[str]) -> dict[str, Any]:
    sha = opt(argv, "--sha") or ""
    if not re.fullmatch(r"[0-9a-f]{64}", sha):
        raise ApiError("bad_request", "--sha must be 64 hex chars")
    p = root() / "prompts" / f"{sha}.md"
    if not p.is_file():
        raise ApiError("not_found", "prompt not stored (expired or never recorded)")
    text = p.read_text(encoding="utf-8", errors="replace")
    return {"sha256": sha, "bytes": p.stat().st_size, "text": text}


def cmd_transcript(argv: list[str]) -> dict[str, Any]:
    run_id = opt(argv, "--run")
    if not run_id:
        raise ApiError("bad_request", "--run required")
    tail = int_opt(argv, "--tail", 200)
    d = find_run(run_id)
    if d is None:
        raise ApiError("not_found", f"run {run_id} not found")
    tid = d.parent.name
    rows = []
    for ev in _read_events(root() / "_data" / tid / "events.jsonl", 0, 100_000, None):
        if ev.get("run") != run_id:
            continue
        k = ev.get("kind")
        if k in ("tool", "milestone", "error", "warning", "session_init", "run_start", "run_end"):
            rows.append({k2: v for k2, v in ev.items() if k2 not in ("v", "id", "type")})
    rec_p = d / f"{run_id}.json"
    final = None
    if rec_p.is_file():
        final = json.loads(rec_p.read_text(encoding="utf-8")).get("final_text_tail")
    return {"ticket": tid, "run": run_id, "lines": rows[-tail:], "total": len(rows), "final_text_tail": final}


def _pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    vs = sorted(values)
    i = min(int(round(q * (len(vs) - 1))), len(vs) - 1)
    return vs[i]


def cmd_metrics(argv: list[str]) -> dict[str, Any]:
    window = opt(argv, "--window", "24h") or "24h"
    if window not in WINDOWS:
        raise ApiError("bad_request", f"--window must be one of {', '.join(WINDOWS)}")
    only_ticket = check_tid(opt(argv, "--ticket"))
    parent = check_tid(opt(argv, "--parent"))
    repo = opt(argv, "--repo")
    span = WINDOWS[window]
    cutoff = None if span is None else time.time() - span
    runs: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    tickets = [only_ticket] if only_ticket else ticket_ids()
    for tid in tickets:
        if parent and tid != parent and ticket_fs.read_meta_json(tid).get("parent") != parent:
            continue
        try:
            meta, _b, _m = load_meta(tid)
        except (OSError, ValueError):
            continue
        if repo and repo not in (meta.get("from"), meta.get("to")):
            continue
        d = root() / "_data" / tid / "runs"
        for rec in run_records(tid):
            ended = parse_iso(rec.get("ended_at"))
            if cutoff is not None and (ended is None or ended < cutoff):
                continue
            lj = {}
            lp = d / f"{rec.get('run')}.launch.json"
            if lp.is_file():
                try:
                    lj = json.loads(lp.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    lj = {}
            rec = dict(rec)
            rec["_repo"] = meta.get("to")
            runs.append((tid, rec, lj))

    def bump(d: dict[str, Any], key: Any, field: str, val: float | int = 1) -> None:
        k = str(key) if key is not None else "unknown"
        d.setdefault(k, {}).setdefault(field, 0)
        d[k][field] += val

    tok = {"input": 0, "cache_read": 0, "cache_write": 0, "output": 0}
    hit_num = hit_den = 0
    cost = 0.0
    cost_known = 0
    turns = 0
    by_backend: dict[str, Any] = {}
    by_reuse: dict[str, Any] = {}
    by_reason: dict[str, int] = {}
    by_repo: dict[str, Any] = {}
    by_trigger: dict[str, int] = {}
    prompt_by_phase: dict[str, list[int]] = {}
    walls: list[float] = []
    rss: list[float] = []
    sessions: set[str] = set()
    failed = 0
    for _tid, rec, lj in runs:
        t = rec.get("tokens") or {}
        for k in tok:
            if isinstance(t.get(k), (int, float)):
                tok[k] += t[k]
        if isinstance(t.get("cache_read"), (int, float)):
            den = sum(v for v in (t.get("input"), t.get("cache_read"), t.get("cache_write")) if isinstance(v, (int, float)))
            hit_num += t["cache_read"]
            hit_den += den
        if isinstance(rec.get("cost_usd"), (int, float)):
            cost += rec["cost_usd"]
            cost_known += 1
        if isinstance(rec.get("turns"), int):
            turns += rec["turns"]
        s = rec.get("session") or {}
        if s.get("id"):
            sessions.add(s["id"])
        reuse = s.get("reuse") or "fresh"
        backend = rec.get("backend")
        bump(by_backend, backend, "runs")
        bump(by_reuse, reuse, "runs")
        if isinstance(t.get("cache_read"), (int, float)):
            den = sum(v for v in (t.get("input"), t.get("cache_read"), t.get("cache_write")) if isinstance(v, (int, float)))
            bump(by_backend, backend, "cache_read", t["cache_read"])
            bump(by_backend, backend, "cache_den", den)
            bump(by_reuse, reuse, "cache_read", t["cache_read"])
            bump(by_reuse, reuse, "cache_den", den)
        if isinstance(rec.get("cost_usd"), (int, float)):
            bump(by_backend, backend, "cost_usd", rec["cost_usd"])
            bump(by_repo, rec.get("_repo"), "cost_usd", rec["cost_usd"])
        bump(by_repo, rec.get("_repo"), "runs")
        by_reason[str(s.get("reason") or "unknown")] = by_reason.get(str(s.get("reason") or "unknown"), 0) + 1
        trig = (lj.get("trigger") or {}).get("source") or "unknown"
        by_trigger[trig] = by_trigger.get(trig, 0) + 1
        est = (lj.get("prompt") or {}).get("est_tokens")
        if isinstance(est, int):
            prompt_by_phase.setdefault(str(rec.get("phase") or lj.get("phase") or "?"), []).append(est)
        if isinstance(rec.get("wall_ms"), (int, float)):
            walls.append(rec["wall_ms"])
        if isinstance(rec.get("rss_peak_mb"), (int, float)):
            rss.append(rec["rss_peak_mb"])
        if rec.get("exit") not in (0, None):
            failed += 1

    def finish(groups: dict[str, Any]) -> dict[str, Any]:
        for g in groups.values():
            den = g.pop("cache_den", 0)
            num = g.pop("cache_read", 0)
            g["cache_hit_rate"] = round(num / den, 4) if den else None
            if "cost_usd" in g:
                g["cost_usd"] = round(g["cost_usd"], 4)
        return groups

    parallelism = None
    spans = [(parse_iso(r.get("started_at")), parse_iso(r.get("ended_at")), r.get("wall_ms"))
             for _t, r, _l in runs]
    spans = [(a, b, w) for a, b, w in spans if a is not None and b is not None and isinstance(w, (int, float))]
    if parent and spans:
        critical = max(b for _, b, _ in spans) - min(a for a, _, _ in spans)
        if critical > 0:
            parallelism = round(sum(w for _, _, w in spans) / 1000 / critical, 2)
    return {
        "window": window,
        "scope": {"ticket": only_ticket, "parent": parent, "repo": repo},
        "realized_parallelism": parallelism,
        "runs": len(runs),
        "failed_runs": failed,
        "sessions": len(sessions),
        "turns": turns,
        "tokens": tok,
        "cache_hit_rate": round(hit_num / hit_den, 4) if hit_den else None,
        "cost_usd": round(cost, 4) if cost_known else None,
        "wall_ms": {"p50": _pct(walls, 0.5), "p95": _pct(walls, 0.95), "sum": sum(walls) if walls else 0},
        "rss_peak_mb": {"p95": _pct(rss, 0.95), "max": max(rss) if rss else None},
        "by_backend": finish(by_backend),
        "by_reuse": finish(by_reuse),
        "reuse_reasons": by_reason,
        "by_repo": finish(by_repo),
        "by_trigger": by_trigger,
        "prompt_est_tokens_by_phase": {k: {"p50": _pct([float(x) for x in v], 0.5), "max": max(v), "n": len(v)} for k, v in prompt_by_phase.items()},
    }


COMMANDS = {
    "health": cmd_health, "list": cmd_list, "show": cmd_show, "events": cmd_events,
    "run": cmd_run, "prompt": cmd_prompt, "transcript": cmd_transcript, "metrics": cmd_metrics,
}


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__)
        return 0 if argv else 1
    cmd, rest = argv[0], argv[1:]
    fn = COMMANDS.get(cmd)
    try:
        if fn is None:
            raise ApiError("unknown_command", f"unknown api command: {cmd}")
        out = {"v": V, "ok": True, "command": cmd, **fn(rest)}
    except ApiError as exc:
        out = {"v": V, "ok": False, "command": cmd, "error": {"code": exc.code, "message": str(exc)}}
    except Exception as exc:  # noqa: BLE001 - contract: never a traceback on stdout
        out = {"v": V, "ok": False, "command": cmd, "error": {"code": "internal", "message": f"{type(exc).__name__}: {exc}"}}
    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
