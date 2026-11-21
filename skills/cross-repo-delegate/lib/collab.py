#!/usr/bin/env python3
"""delegate collab — parent/child cross-repo work with a concurrent scheduler.

A parent ticket holds a contract (interfaces, order, per-child path scope).
Children are ordinary tickets (one repo each; several may share a repo, each
in its own delegate-<id> worktree) with ``parent`` / ``depends_on`` / ``scope``
in meta.json, so claim / challenge / reply keep working on them.

  collab plan   --from REPO --title T --contract FILE [--summary S]
  collab add    --parent P --to REPO --title T --observed O --assumed A
                [--depends-on ID,ID] [--scope GLOB,GLOB]
  collab run    --parent P [--max-parallel N] [--per-repo N] [--backend B]
                [--mock] [--detach] [--no-integrate]
  collab status --parent P

Scheduler gates (first failing gate → ``queued`` event with its reason):
deps → slot (global pool .locks/slots, DELEGATE_MAX_PARALLEL=3) → repo_cap
(DELEGATE_MAX_PER_REPO=2) → path_overlap (scope prefixes in the same repo) →
mem (MemAvailable − DELEGATE_RUN_MEM_MB ≥ DELEGATE_MEM_FLOOR_MB). When every
child shipped, the integration step merges child branches per repo
(conflict → waiting on a human) and runs a fresh-session verify agent.
Design: docs/cross-repo-collab.md.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
TOOL_ROOT = HERE.parent
RUN_SH = TOOL_ROOT / "run.sh"
REPO_ROOT = TOOL_ROOT.parent.parent
INVOKE_LIB = REPO_ROOT / "scripts" / "dev" / "host-agent-invoke" / "lib" / "host-agent-invoke.sh"
sys.path.insert(0, str(HERE))
import observe  # noqa: E402
import ticket_fs  # noqa: E402

DONE = {"shipped", "closed"}
FAILED = {"failed", "rejected"}
HUMAN = {"waiting_initiator"}
TICK_S = float(os.environ.get("DELEGATE_COLLAB_TICK", "15"))


class CollabError(Exception):
    pass


def out(obj: dict[str, Any]) -> None:
    print(json.dumps(obj, ensure_ascii=False))


def opt(argv: list[str], name: str, default: str | None = None) -> str | None:
    if name in argv:
        i = argv.index(name)
        if i + 1 >= len(argv):
            raise CollabError(f"{name} needs a value")
        return argv[i + 1]
    return default


def csv(value: str | None) -> list[str]:
    return [x.strip() for x in (value or "").split(",") if x.strip()]


def run_sh(*args: str, env: dict[str, str] | None = None) -> dict[str, Any]:
    proc = subprocess.run(
        [str(RUN_SH), *args], capture_output=True, text=True,
        env={**os.environ, **(env or {})}, check=False,
    )
    if proc.returncode != 0:
        raise CollabError(f"run.sh {args[0]} failed: {proc.stderr.strip()[-400:]}")
    last = [ln for ln in proc.stdout.splitlines() if ln.strip().startswith("{")]
    return json.loads(last[-1]) if last else {}


def status_of(tid: str) -> str:
    meta, _ = ticket_fs.read_ticket(tid)
    return str(meta.get("status") or "submitted")


def set_status(tid: str, status: str, *, owner: str | None = None, phase: str | None = None) -> None:
    args = ["set-status", "--id", tid, "--status", status]
    if owner:
        args += ["--owner", owner]
    if phase:
        args += ["--phase", phase]
    run_sh(*args)


def event(tid: str, kind: str, **data: Any) -> None:
    observe.write_events(tid, [{"type": kind, **data}])


def progress(tid: str, step: str, message: str, **extra: Any) -> None:
    ticket_fs.write_progress(tid, step, message, extra=extra or None)


def children_of(parent: str) -> list[str]:
    data = ticket_fs.tickets_root() / "_data"
    if not data.is_dir():
        return []
    out_ids = []
    for d in sorted(data.iterdir()):
        if d.name.startswith("req-") and ticket_fs.read_meta_json(d.name).get("parent") == parent:
            out_ids.append(d.name)
    return out_ids


def target_path(key: str) -> str:
    proc = subprocess.run(
        ["bash", "-c", '. "$1/lib/common.sh"; delegate_target_path "$2"', "x", str(TOOL_ROOT), key],
        capture_output=True, text=True, check=False,
    )
    path = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
    if proc.returncode != 0 or not path:
        raise CollabError(f"target {key!r} not in config.yml: {proc.stderr.strip()[-200:]}")
    return path


# ------------------------------------------------------------------ plan / add


def cmd_plan(argv: list[str]) -> dict[str, Any]:
    src = opt(argv, "--from")
    title = opt(argv, "--title")
    contract = opt(argv, "--contract")
    if not (src and title and contract):
        raise CollabError("plan needs --from, --title, --contract")
    text = Path(contract).read_text(encoding="utf-8")
    created = run_sh(
        "create", "--to", src, "--from", src, "--title", title,
        "--observed", "cross-repo collab parent (children carry the per-repo work)",
        "--assumed", "contract.md is the shared interface; children stay inside their scope",
        "--summary", opt(argv, "--summary") or title,
    )
    pid = created["id"]
    (ticket_fs.data_dir(pid) / "contract.md").write_text(text, encoding="utf-8")
    stored = observe.store_text(text)
    mj = ticket_fs.read_meta_json(pid)
    mj.update({"kind": "parent", "contract_sha256": stored["sha256"]})
    ticket_fs.write_meta_json(pid, mj)
    set_status(pid, "in_progress", owner="initiator", phase="planning")
    event(pid, "contract", sha256=stored["sha256"], bytes=stored["bytes"])
    return {"id": pid, "contract_sha256": stored["sha256"]}


def cmd_add(argv: list[str]) -> dict[str, Any]:
    parent = observe_tid(opt(argv, "--parent"))
    if ticket_fs.read_meta_json(parent).get("kind") != "parent":
        raise CollabError(f"{parent} is not a collab parent (use collab plan)")
    pmeta, _ = ticket_fs.read_ticket(parent)
    to = opt(argv, "--to")
    title = opt(argv, "--title")
    if not (to and title):
        raise CollabError("add needs --to and --title")
    deps = csv(opt(argv, "--depends-on"))
    siblings = set(children_of(parent))
    unknown = [d for d in deps if d not in siblings]
    if unknown:
        raise CollabError(f"--depends-on must name children of {parent}: {unknown}")
    created = run_sh(
        "create", "--to", to, "--from", str(pmeta.get("from")), "--title", title,
        "--observed", opt(argv, "--observed") or f"child of {parent}",
        "--assumed", opt(argv, "--assumed") or "see parent contract",
        *(["--summary", opt(argv, "--summary") or ""] if opt(argv, "--summary") else []),
    )
    cid = created["id"]
    scope = csv(opt(argv, "--scope"))
    mj = ticket_fs.read_meta_json(cid)
    mj.update({"parent": parent, "depends_on": deps, "scope": scope})
    ticket_fs.write_meta_json(cid, mj)
    event(parent, "child_added", child=cid, to=to, depends_on=deps, scope=scope)
    return {"id": cid, "parent": parent, "depends_on": deps, "scope": scope}


def observe_tid(tid: str | None) -> str:
    if not tid or not re.fullmatch(r"req-[A-Za-z0-9_-]{1,64}", tid):
        raise CollabError("invalid or missing ticket id")
    if not (ticket_fs.data_dir(tid) / "ticket.md").is_file():
        raise CollabError(f"ticket not found: {tid}")
    return tid


# ------------------------------------------------------------------ gates


def scope_prefixes(scope: list[str]) -> list[str]:
    if not scope:
        return [""]  # whole repo
    out_p = []
    for g in scope:
        m = re.split(r"[*?\[{]", g, maxsplit=1)[0]
        out_p.append(m.rstrip("/"))
    return out_p


def scopes_overlap(a: list[str], b: list[str]) -> bool:
    for x in scope_prefixes(a):
        for y in scope_prefixes(b):
            if x == "" or y == "" or x == y or x.startswith(y + "/") or y.startswith(x + "/"):
                return True
    return False


def mem_available_mb() -> int | None:
    path = os.environ.get("DELEGATE_MEMINFO_PATH", "/proc/meminfo")
    try:
        for line in Path(path).read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def topo_order(children: list[str], deps: dict[str, list[str]]) -> list[str]:
    seen: dict[str, int] = {}
    order: list[str] = []

    def visit(n: str) -> None:
        state = seen.get(n, 0)
        if state == 1:
            raise CollabError(f"dependency cycle at {n}")
        if state == 2:
            return
        seen[n] = 1
        for d in deps.get(n, []):
            visit(d)
        seen[n] = 2
        order.append(n)

    for c in children:
        visit(c)
    return order


class Slot:
    def __init__(self, index: int, fh: Any):
        self.index = index
        self.fh = fh

    def release(self) -> None:
        try:
            fcntl.flock(self.fh, fcntl.LOCK_UN)
        finally:
            self.fh.close()


def try_slot(pool: int) -> Slot | None:
    d = ticket_fs.tickets_root() / ".locks" / "slots"
    d.mkdir(parents=True, exist_ok=True)
    for i in range(pool):
        fh = open(d / f"{i}.lock", "a+")
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return Slot(i, fh)
        except OSError:
            fh.close()
    return None


# ------------------------------------------------------------------ scheduler


class Scheduler:
    def __init__(self, parent: str, argv: list[str]):
        self.parent = parent
        self.pool = int(os.environ.get("DELEGATE_MAX_PARALLEL", "3"))
        self.cap = int(opt(argv, "--max-parallel") or self.pool)
        self.per_repo = int(opt(argv, "--per-repo") or os.environ.get("DELEGATE_MAX_PER_REPO", "2"))
        self.backend = opt(argv, "--backend") or "claude"
        self.mock = "--mock" in argv
        self.integrate = "--no-integrate" not in argv
        self.run_mem = int(os.environ.get("DELEGATE_RUN_MEM_MB", "1500"))
        self.mem_floor = int(os.environ.get("DELEGATE_MEM_FLOOR_MB", "2048"))
        self.running: dict[str, dict[str, Any]] = {}
        self.attempts: dict[str, int] = {}
        self.last_gate: dict[str, str] = {}
        self.queued_at: dict[str, float] = {}
        self.peak = 0
        self.last_progress = ""

    def info(self, cid: str) -> dict[str, Any]:
        mj = ticket_fs.read_meta_json(cid)
        meta, _ = ticket_fs.read_ticket(cid)
        return {"to": meta.get("to"), "deps": mj.get("depends_on") or [], "scope": mj.get("scope") or []}

    def gate(self, cid: str, kids: dict[str, dict[str, Any]]) -> str | None:
        me = kids[cid]
        if any(status_of(d) not in DONE for d in me["deps"]):
            return "deps"
        if len(self.running) >= self.cap:
            return "slot"
        same = [r for r in self.running if kids[r]["to"] == me["to"]]
        if len(same) >= self.per_repo:
            return "repo_cap"
        if any(scopes_overlap(me["scope"], kids[r]["scope"]) for r in same):
            return "path_overlap"
        avail = mem_available_mb()
        if avail is not None and avail - self.run_mem < self.mem_floor:
            return "mem"
        return None

    def child_cmd(self, cid: str) -> list[str]:
        override = os.environ.get("DELEGATE_COLLAB_RUN_CMD")
        if override:
            return [*shlex.split(override), cid]
        cmd = [str(RUN_SH), "run", "--id", cid, "--phase", "auto", "--backend", self.backend]
        return cmd + (["--mock"] if self.mock else [])

    def dispatch(self, cid: str, kids: dict[str, dict[str, Any]]) -> bool:
        slot = try_slot(self.pool)
        if slot is None:
            self.note_gate(cid, "slot", "global pool busy (other parents)")
            return False
        log = (ticket_fs.data_dir(cid) / "scheduler.log").open("a", encoding="utf-8")
        env = {**os.environ, "DELEGATE_PARENT_SCHEDULER": self.parent, "DELEGATE_TRIGGER_SOURCE": "parent"}
        proc = subprocess.Popen(self.child_cmd(cid), stdout=log, stderr=subprocess.STDOUT, env=env,
                                start_new_session=True)
        self.attempts[cid] = self.attempts.get(cid, 0) + 1
        wait_ms = int((time.time() - self.queued_at.pop(cid, time.time())) * 1000)
        self.running[cid] = {"proc": proc, "slot": slot, "log": log, "t0": time.time()}
        self.peak = max(self.peak, len(self.running))
        self.last_gate.pop(cid, None)
        event(self.parent, "dispatched", child=cid, to=kids[cid]["to"], slot=slot.index,
              queue_wait_ms=wait_ms, attempt=self.attempts[cid], pid=proc.pid,
              mem_available_mb=mem_available_mb())
        return True

    def note_gate(self, cid: str, gate: str, detail: str = "") -> None:
        self.queued_at.setdefault(cid, time.time())
        if self.last_gate.get(cid) == gate:
            return
        self.last_gate[cid] = gate
        event(self.parent, "queued", child=cid, gate=gate, detail=detail,
              mem_available_mb=mem_available_mb() if gate == "mem" else None)

    def reap(self) -> None:
        for cid in list(self.running):
            r = self.running[cid]
            rc = r["proc"].poll()
            if rc is None:
                continue
            r["slot"].release()
            r["log"].close()
            del self.running[cid]
            st = status_of(cid)
            event(self.parent, "child_exit", child=cid, exit=rc, status=st,
                  wall_ms=int((time.time() - r["t0"]) * 1000))
            if st in DONE | HUMAN | FAILED:
                continue
            if self.attempts.get(cid, 0) < 2:
                event(self.parent, "retry", child=cid, after_exit=rc, status=st)
                continue  # stays eligible; next tick re-dispatches (resume when warm)
            set_status(cid, "failed", owner="initiator")
            event(self.parent, "error", where="child", child=cid, message=f"failed twice (last exit {rc}, status {st})")

    def run(self) -> dict[str, Any]:
        kids_ids = children_of(self.parent)
        if not kids_ids:
            raise CollabError("parent has no children (collab add first)")
        kids = {c: self.info(c) for c in kids_ids}
        order = topo_order(kids_ids, {c: kids[c]["deps"] for c in kids_ids})
        set_status(self.parent, "in_progress", owner="worker", phase="running")
        event(self.parent, "scheduler_start", children=len(order), cap=self.cap, pool=self.pool,
              per_repo=self.per_repo, backend=self.backend, mock=self.mock)
        progress(self.parent, "scheduler_start", f"{len(order)} children · cap {self.cap}")
        t0 = time.time()
        while True:
            self.reap()
            states = {c: status_of(c) for c in order}
            pending = [c for c in order if c not in self.running and states[c] not in DONE | HUMAN | FAILED]
            dispatched = False
            waiting_on_capacity = False
            for cid in pending:
                if any(states[d] in FAILED | HUMAN for d in kids[cid]["deps"]):
                    self.note_gate(cid, "blocked", "a dependency failed or waits on a human")
                    continue
                g = self.gate(cid, kids)
                if g:
                    self.note_gate(cid, g)
                    waiting_on_capacity |= g in ("slot", "mem") and not self.running
                    continue
                dispatched |= self.dispatch(cid, kids)
            if not self.running and not dispatched and not waiting_on_capacity:
                break  # nothing in flight and nothing can start: done or needs a human
            done_n = sum(1 for c in order if states[c] in DONE)
            msg = f"{done_n}/{len(order)} done · {len(self.running)} running"
            if msg != self.last_progress:  # only on change: no per-tick event spam
                self.last_progress = msg
                progress(self.parent, "scheduling", msg, running=sorted(self.running))
            time.sleep(TICK_S if self.running or waiting_on_capacity else 0)
        states = {c: status_of(c) for c in order}
        summary = {
            "done": [c for c, s in states.items() if s in DONE],
            "waiting_human": [c for c, s in states.items() if s in HUMAN],
            "failed": [c for c, s in states.items() if s in FAILED],
            "blocked": [c for c, s in states.items() if s not in DONE | HUMAN | FAILED],
            "peak_parallel": self.peak,
            "wall_ms": int((time.time() - t0) * 1000),
        }
        event(self.parent, "scheduler_end", **summary)
        if len(summary["done"]) != len(order):
            set_status(self.parent, "waiting_initiator", owner="human", phase="running")
            progress(self.parent, "waiting_human",
                     f"{len(summary['waiting_human'])} child(ren) wait on a human, {len(summary['failed'])} failed; "
                     "reply/fix then rerun `delegate collab run --parent`",
                     **{k: summary[k] for k in ("waiting_human", "failed", "blocked")})
            return {"parent": self.parent, "result": "waiting_human", **summary}
        if not self.integrate:
            set_status(self.parent, "waiting_initiator", owner="initiator", phase="children_done")
            return {"parent": self.parent, "result": "children_done", **summary}
        integ = Integration(self.parent, order, self.backend, self.mock).run()
        return {"parent": self.parent, "result": integ["result"], "integration": integ, **summary}


# ------------------------------------------------------------------ integration


def git(path: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", path, *args], capture_output=True, text=True, check=False)


class Integration:
    def __init__(self, parent: str, order: list[str], backend: str, mock: bool):
        self.parent, self.order, self.backend, self.mock = parent, order, backend, mock

    def worktree_for(self, repo_key: str, repo_path: str) -> tuple[str, str, str]:
        branch = f"delegate/{self.parent}-integration"
        root = Path(repo_path)
        path = root.parent / ".worktrees" / root.name / f"delegate-{self.parent}-integration"
        prev = (ticket_fs.read_meta_json(self.parent).get("integration") or {}).get(repo_key) or {}
        if not path.is_dir():
            ref = "origin/HEAD" if git(repo_path, "rev-parse", "--verify", "-q", "origin/HEAD").returncode == 0 else "HEAD"
            path.parent.mkdir(parents=True, exist_ok=True)
            r = git(repo_path, "worktree", "add", "-B", branch, str(path), ref)
            if r.returncode != 0:
                raise CollabError(f"integration worktree for {repo_key}: {r.stderr.strip()[-300:]}")
            base = git(str(path), "rev-parse", "HEAD").stdout.strip()
        else:
            base = prev.get("base") or git(str(path), "rev-parse", "HEAD").stdout.strip()
        return str(path), branch, base

    def child_branch(self, cid: str) -> str | None:
        """The child's delegate/<id> branch, with its worktree changes committed.

        Implement workers edit but do not commit (initiators review before
        shipping), so integration snapshots the uncommitted work onto the
        child's own delegate branch first (never `.delegate/` scratch)."""
        mj = ticket_fs.read_meta_json(cid)
        wt = mj.get("worktree")
        if not wt or not Path(wt).is_dir():
            return mj.get("branch")
        branch = git(wt, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip() or mj.get("branch")
        git(wt, "add", "-A", "--", ".", ":(exclude).delegate")
        staged = git(wt, "diff", "--cached", "--name-only").stdout.split()
        if staged:
            meta, _ = ticket_fs.read_ticket(cid)
            r = git(wt, "-c", "user.name=delegate", "-c", "user.email=delegate@localhost",
                    "commit", "-q", "-m", f"collab {self.parent}: {meta.get('title') or cid}\n\nticket {cid}")
            event(self.parent, "snapshot", child=cid, branch=branch, files=len(staged),
                  result="ok" if r.returncode == 0 else "failed", message=r.stderr.strip()[-200:] or None)
        if branch and branch != mj.get("branch"):
            mj["branch"] = branch
            ticket_fs.write_meta_json(cid, mj)
        return branch

    def run(self) -> dict[str, Any]:
        set_status(self.parent, "in_progress", owner="worker", phase="integrating")
        by_repo: dict[str, list[str]] = {}
        for cid in self.order:
            meta, _ = ticket_fs.read_ticket(cid)
            by_repo.setdefault(str(meta.get("to")), []).append(cid)
        report: dict[str, Any] = {}
        mj = ticket_fs.read_meta_json(self.parent)
        for repo_key, kids in by_repo.items():
            branches = [(c, self.child_branch(c)) for c in kids]
            if not any(b for _, b in branches):
                report[repo_key] = {"skipped": "no child branches (mock / no-worktree)"}
                event(self.parent, "merge", repo=repo_key, result="skipped")
                continue
            path, branch, base = self.worktree_for(repo_key, target_path(repo_key))
            merged = []
            for cid, b in branches:
                if not b:
                    continue
                if git(path, "merge-base", "--is-ancestor", b, "HEAD").returncode == 0:
                    merged.append(cid)
                    continue
                r = git(path, "merge", "--no-ff", "--no-edit", "-m", f"collab {self.parent}: merge {cid}", b)
                if r.returncode != 0:
                    files = git(path, "diff", "--name-only", "--diff-filter=U").stdout.split()
                    git(path, "merge", "--abort")
                    event(self.parent, "merge", repo=repo_key, branch=b, into=branch, result="conflict", files=files[:20])
                    report[repo_key] = {"worktree": path, "branch": branch, "base": base, "merged": merged,
                                        "conflict": {"child": cid, "files": files}}
                    mj["integration"] = report
                    ticket_fs.write_meta_json(self.parent, mj)
                    set_status(self.parent, "waiting_initiator", owner="human", phase="integration_conflict")
                    progress(self.parent, "integration_conflict",
                             f"{repo_key}: merging {cid} conflicts in {len(files)} file(s); resolve in {path} then rerun")
                    return {"result": "conflict", "repos": report}
                merged.append(cid)
                event(self.parent, "merge", repo=repo_key, branch=b, into=branch, result="ok")
            report[repo_key] = {"worktree": path, "branch": branch, "base": base, "merged": merged,
                                "head": git(path, "rev-parse", "HEAD").stdout.strip()}
        mj["integration"] = report
        ticket_fs.write_meta_json(self.parent, mj)
        verdict = self.verify(report)
        if verdict.get("verdict") == "skipped":
            set_status(self.parent, "shipped", owner="initiator", phase="done_unmerged")
            progress(self.parent, "done_unmerged", "children shipped; nothing to merge, verify skipped")
            return {"result": "done_unmerged", "repos": report, "verify": verdict}
        if verdict.get("verdict") == "pass":
            set_status(self.parent, "shipped", owner="initiator", phase="done")
            progress(self.parent, "done", "children merged and verified against the contract")
            return {"result": "done", "repos": report, "verify": verdict}
        set_status(self.parent, "waiting_initiator", owner="human", phase="verify_failed")
        progress(self.parent, "verify_failed", "; ".join(str(f) for f in verdict.get("findings") or [])[:300] or "verify failed")
        return {"result": "verify_failed", "repos": report, "verify": verdict}

    def verify(self, report: dict[str, Any]) -> dict[str, Any]:
        targets = [(k, v) for k, v in report.items() if v.get("worktree")]
        if not targets:
            v = {"verdict": "skipped", "findings": ["no child branches to merge"], "mock": self.mock}
            event(self.parent, "verify", **v)
            return v
        if self.mock:
            v = {"verdict": "pass", "findings": [], "mock": True}
            event(self.parent, "verify", **v)
            return v
        contract = (ticket_fs.data_dir(self.parent) / "contract.md").read_text(encoding="utf-8")
        template = (TOOL_ROOT / "prompts" / "integrate.md").read_text(encoding="utf-8")
        verdicts = []
        for repo_key, info in targets:
            stat = git(info["worktree"], "diff", "--stat", info["base"], "HEAD").stdout[-3000:]
            prompt = (template.replace("{{PARENT_ID}}", self.parent).replace("{{REPO}}", repo_key)
                      .replace("{{CONTRACT}}", contract).replace("{{MERGED}}", ", ".join(info["merged"]))
                      .replace("{{DIFFSTAT}}", stat))
            pfile = ticket_fs.data_dir(self.parent) / f"prompt-integrate-{repo_key}.md"
            pfile.write_text(prompt, encoding="utf-8")
            prep = json.loads(subprocess.run(
                [sys.executable, str(HERE / "observe.py"), "prepare-run", "--ticket", self.parent,
                 "--phase", "integrate", "--role", f"integration-{repo_key}", "--backend", self.backend,
                 "--prompt-file", str(pfile), "--worktree", info["worktree"],
                 "--template", str(TOOL_ROOT / "prompts" / "integrate.md"), "--force-fresh",
                 "--contract-file", str(ticket_fs.data_dir(self.parent) / "contract.md")],
                capture_output=True, text=True, check=True,
                env={**os.environ, "DELEGATE_TRIGGER_SOURCE": "parent"}).stdout)
            subprocess.run(
                ["bash", "-c", '. "$1"; shift; host_agent_invoke_run "$@"', "x", str(INVOKE_LIB),
                 "--backend", self.backend, "--mode", "read", "--cwd", info["worktree"],
                 "--prompt-file", str(pfile), "--run-dir", prep["run_dir"], "--run-id", prep["run_id"],
                 "--launch-extra", prep["extra"], "--sink-py", str(HERE / "observe.py"), "--sink-arg", self.parent,
                 "--log", str(ticket_fs.data_dir(self.parent) / "integrate.log")],
                env={**os.environ, "DELEGATE_TRIGGER_SOURCE": "parent"}, check=False)
            subprocess.run([sys.executable, str(HERE / "observe.py"), "finish-run", "--ticket", self.parent,
                            "--role", f"integration-{repo_key}", "--run-id", prep["run_id"]],
                           capture_output=True, check=False)
            final = Path(prep["run_dir"]) / f"{prep['run_id']}.final.txt"
            verdicts.append(parse_verdict(final.read_text(encoding="utf-8") if final.is_file() else ""))
        findings = [f for v in verdicts for f in v.get("findings") or []]
        result = {"verdict": "pass" if verdicts and all(v.get("verdict") == "pass" for v in verdicts) else "fail",
                  "findings": findings[:20], "repos": [k for k, _ in targets]}
        event(self.parent, "verify", **result)
        return result


def parse_verdict(text: str) -> dict[str, Any]:
    for m in reversed(list(re.finditer(r"\{[^{}]*\"verdict\"[^{}]*(?:\[[^\]]*\][^{}]*)?\}", text, re.S))):
        try:
            data = json.loads(m.group(0))
            if data.get("verdict") in ("pass", "fail"):
                return data
        except json.JSONDecodeError:
            continue
    return {"verdict": "fail", "findings": ["verify agent returned no parseable verdict JSON"]}


# ------------------------------------------------------------------ run / status


def cmd_run(argv: list[str]) -> dict[str, Any]:
    parent = observe_tid(opt(argv, "--parent"))
    if ticket_fs.read_meta_json(parent).get("kind") != "parent":
        raise CollabError(f"{parent} is not a collab parent")
    if "--detach" in argv:
        rest = [a for a in argv if a != "--detach"]
        log = (ticket_fs.data_dir(parent) / "scheduler.log").open("a", encoding="utf-8")
        proc = subprocess.Popen([sys.executable, str(Path(__file__)), "run", *rest],
                                stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        return {"parent": parent, "detached": True, "pid": proc.pid,
                "log": str(ticket_fs.data_dir(parent) / "scheduler.log")}
    lock_dir = ticket_fs.tickets_root() / ".locks"
    lock_dir.mkdir(parents=True, exist_ok=True)
    with open(lock_dir / f"scheduler.{parent}.lock", "a+") as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise CollabError(f"a scheduler is already running for {parent}") from exc
        pidf = ticket_fs.data_dir(parent) / "scheduler.pid"
        pidf.write_text(str(os.getpid()), encoding="utf-8")
        try:
            return Scheduler(parent, argv).run()
        finally:
            pidf.unlink(missing_ok=True)


def cmd_status(argv: list[str]) -> dict[str, Any]:
    parent = observe_tid(opt(argv, "--parent"))
    pidf = ticket_fs.data_dir(parent) / "scheduler.pid"
    pid = int(pidf.read_text()) if pidf.is_file() else None
    alive = bool(pid) and Path(f"/proc/{pid}").exists()
    kids = []
    for cid in children_of(parent):
        meta, _ = ticket_fs.read_ticket(cid)
        mj = ticket_fs.read_meta_json(cid)
        kids.append({"id": cid, "to": meta.get("to"), "title": meta.get("title"), "status": meta.get("status"),
                     "phase": meta.get("phase"), "depends_on": mj.get("depends_on") or [],
                     "scope": mj.get("scope") or [], "branch": mj.get("branch")})
    meta, _ = ticket_fs.read_ticket(parent)
    return {"parent": parent, "status": meta.get("status"), "phase": meta.get("phase"),
            "scheduler": {"pid": pid if alive else None, "alive": alive},
            "children": kids, "integration": ticket_fs.read_meta_json(parent).get("integration")}


COMMANDS = {"plan": cmd_plan, "add": cmd_add, "run": cmd_run, "status": cmd_status}


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__)
        return 0 if argv else 1
    fn = COMMANDS.get(argv[0])
    try:
        if fn is None:
            raise CollabError(f"unknown collab command: {argv[0]}")
        out({"ok": True, **fn(argv[1:])})
        return 0
    except CollabError as exc:
        out({"ok": False, "error": str(exc)})
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
