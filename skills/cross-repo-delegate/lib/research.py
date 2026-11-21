#!/usr/bin/env python3
"""delegate research — one read-only agent run over one or more repos, as a ticket.

The execution + observability substrate for callers that own their own product
semantics (fe1 flag-flows' check step): they keep prompts, result schemas and
evidence checks; delegate owns checkout, invocation, run records and cleanup.

  research --from KEY --repos A[,B…] --title T --prompt-file F
           [--system-file F] [--allow-tool RULE]… [--max-turns N]
           [--backend claude|codex|grok] [--model M] [--result-file OUT.json]
           [--origin JSON]          # caller context, e.g. {"system":"fe1-flows","flow":12,"step":3}

Each repo is fetched and checked out detached at its remote default branch
(``origin/HEAD``, falling back to ``HEAD``). With one repo the agent runs in that
worktree; with several, in a parent dir holding one subdir per repo key. The
ticket (``meta.kind = research``) goes straight to shipped/failed so it never
sits in an inbox; worktrees are removed afterwards. ``{repo}`` in --allow-tool
rules expands per repo (``Bash(git -C {repo} log:*)``).
Prints ``{ok, id, run, result, final_text, repos[], record}``.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import collab  # noqa: E402  (run_sh, set_status, event, target_path, git, opt, csv)
import ticket_fs  # noqa: E402

FETCH_TIMEOUT = int(os.environ.get("DELEGATE_RESEARCH_FETCH_TIMEOUT", "120"))


def parse_json(text: str) -> Any:
    """Last JSON object in the agent's final text (fenced or bare)."""
    for m in reversed(list(re.finditer(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S))):
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
    end = text.rfind("}")
    while end != -1:
        start = text.rfind("{", 0, end)
        while start != -1:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                start = text.rfind("{", 0, start)
        end = text.rfind("}", 0, end)
    return None


def checkout(key: str, dest: Path) -> dict[str, Any]:
    path = collab.target_path(key)
    fetched = True
    try:
        r = subprocess.run(["git", "-C", path, "fetch", "--quiet", "origin"], capture_output=True,
                           text=True, timeout=FETCH_TIMEOUT, check=False)
        fetched = r.returncode == 0
    except subprocess.TimeoutExpired:
        fetched = False
    ref = "origin/HEAD" if collab.git(path, "rev-parse", "--verify", "-q", "origin/HEAD").returncode == 0 else "HEAD"
    r = collab.git(path, "worktree", "add", "--detach", str(dest), ref)
    if r.returncode != 0:
        raise collab.CollabError(f"checkout {key}: {r.stderr.strip()[-300:]}")
    head = collab.git(str(dest), "rev-parse", "HEAD").stdout.strip()
    return {"repo": key, "path": path, "base": ref, "head": head, "fetched": fetched}


def release(states: list[dict[str, Any]], root: Path | None) -> None:
    for s in states:
        collab.git(s["path"], "worktree", "remove", "--force", s["worktree"])
        collab.git(s["path"], "worktree", "prune")
    if root and root.exists():
        shutil.rmtree(root, ignore_errors=True)


def run(argv: list[str]) -> dict[str, Any]:
    src = collab.opt(argv, "--from")
    repos = collab.csv(collab.opt(argv, "--repos"))
    title = collab.opt(argv, "--title")
    prompt_file = collab.opt(argv, "--prompt-file")
    if not (src and repos and title and prompt_file and Path(prompt_file).is_file()):
        raise collab.CollabError("research needs --from, --repos, --title and an existing --prompt-file")
    system_file = collab.opt(argv, "--system-file")
    backend = collab.opt(argv, "--backend") or "claude"
    origin = json.loads(collab.opt(argv, "--origin") or "{}")
    allow = [argv[i + 1] for i, a in enumerate(argv) if a == "--allow-tool" and i + 1 < len(argv)]

    created = collab.run_sh(
        "create", "--to", repos[0], "--from", src, "--title", title,
        "--observed", f"read-only research over {', '.join(repos)}",
        "--assumed", "caller owns prompt, result schema and evidence checks",
    )
    tid = created["id"]
    mj = ticket_fs.read_meta_json(tid)
    mj.update({"kind": "research", "repos": repos, "origin": origin or None})
    ticket_fs.write_meta_json(tid, mj)
    collab.set_status(tid, "in_progress", owner="worker", phase="researching")

    root = Path(tempfile.mkdtemp(prefix="delegate-research-"))
    states: list[dict[str, Any]] = []
    t0 = time.time()
    try:
        for key in repos:
            dest = root / key if len(repos) > 1 else root / "wt"
            st = checkout(key, dest)
            st["worktree"] = str(dest)
            states.append(st)
            collab.event(tid, "checkout", repo=key, base=st["base"], head=st["head"], fetched=st["fetched"])
        cwd = str(root) if len(repos) > 1 else states[0]["worktree"]
        rules: list[str] = []
        for r in allow:
            rules += [r.replace("{repo}", k) for k in repos] if "{repo}" in r else [r]

        prep_args = [sys.executable, str(HERE / "observe.py"), "prepare-run", "--ticket", tid, "--phase", "research",
                     "--role", "research", "--backend", backend, "--prompt-file", prompt_file, "--worktree", cwd,
                     "--force-fresh", "--fresh-reason", "research_oneshot", "--part", f"task={prompt_file}"]
        if system_file:
            prep_args += ["--part", f"system={system_file}"]
        env = {**os.environ}
        env.setdefault("DELEGATE_TRIGGER_SOURCE", origin.get("system") or "cli")
        prep = json.loads(subprocess.run(prep_args, capture_output=True, text=True, check=True, env=env).stdout)

        inv = ["--backend", backend, "--mode", "read", "--cwd", cwd, "--prompt-file", prompt_file,
               "--run-dir", prep["run_dir"], "--run-id", prep["run_id"], "--launch-extra", prep["extra"],
               "--sink-py", str(HERE / "observe.py"), "--sink-arg", tid,
               "--log", str(ticket_fs.data_dir(tid) / "research.log")]
        if system_file:
            inv += ["--append-system-file", system_file]
        for r in rules:
            inv += ["--allow-tool", r]
        if collab.opt(argv, "--max-turns"):
            inv += ["--max-turns", collab.opt(argv, "--max-turns") or ""]
        if collab.opt(argv, "--model"):
            inv += ["--model", collab.opt(argv, "--model") or ""]
        rc = subprocess.run(["bash", "-c", '. "$1"; shift; host_agent_invoke_run "$@"', "x", str(collab.INVOKE_LIB), *inv],
                            env=env, check=False).returncode
        subprocess.run([sys.executable, str(HERE / "observe.py"), "finish-run", "--ticket", tid, "--role", "research",
                        "--run-id", prep["run_id"]], capture_output=True, check=False)
    except Exception:
        collab.set_status(tid, "failed", owner="initiator", phase="research_failed")
        raise
    finally:
        release(states, root)

    run_dir = Path(prep["run_dir"])
    final = (run_dir / f"{prep['run_id']}.final.txt")
    text = final.read_text(encoding="utf-8") if final.is_file() else ""
    rec_p = run_dir / f"{prep['run_id']}.json"
    record = json.loads(rec_p.read_text(encoding="utf-8")) if rec_p.is_file() else {}
    result = parse_json(text)
    ok = rc == 0 and result is not None
    collab.set_status(tid, "shipped" if ok else "failed", owner="initiator",
                      phase="research_done" if ok else "research_failed")
    collab.event(tid, "research_done", ok=ok, exit=rc, parsed=result is not None,
                 wall_ms=int((time.time() - t0) * 1000))
    out = {
        "id": tid, "run": prep["run_id"], "ok_result": ok, "result": result, "final_text": text,
        "repos": [{k: s[k] for k in ("repo", "base", "head", "fetched")} for s in states],
        "record": {k: record.get(k) for k in ("model", "turns", "tokens", "cache_hit_rate", "cost_usd",
                                               "wall_ms", "tool_calls", "denials", "exit", "session")},
    }
    result_file = collab.opt(argv, "--result-file")
    if result_file:
        Path(result_file).write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__)
        return 0 if argv else 1
    try:
        collab.out({"ok": True, **run(argv)})
        return 0
    except (collab.CollabError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        collab.out({"ok": False, "error": str(exc)[-500:]})
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
