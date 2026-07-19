#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

DEFAULT_CONFIG = Path.home() / ".openclaw" / "tasks-allowlist.json"

FALLBACK_MAIN_ROOTS = [
    "$HOME/work/team-repo",
    "$HOME/work/.worktrees/team-repo",
    "$HOME/github/wezterm-config",
    "$HOME/github/.worktrees/wezterm-config",
    "$HOME/work/wezterm-config",
    "$HOME/work/.worktrees/wezterm-config",
]


def config_path() -> Path:
    raw = os.environ.get("OPENCLAW_TASKS_ALLOWLIST_FILE", "").strip()
    if raw:
        return Path(os.path.expanduser(raw)).expanduser()
    return DEFAULT_CONFIG


def expand_root(s: str) -> str:
    s = (s or "").strip()
    if not s:
        return ""
    s = os.path.expandvars(s)
    s = os.path.expanduser(s)
    return str(Path(s).expanduser().resolve(strict=False))


def load_doc(path: Path) -> dict:
    if not path.is_file():
        return {
            "version": 1,
            "defaultAgent": "main",
            "agents": {"main": {"allowedRoots": list(FALLBACK_MAIN_ROOTS)}},
            "_source": "builtin-fallback",
        }
    with path.open(encoding="utf-8") as f:
        doc = json.load(f)
    if not isinstance(doc, dict):
        raise SystemExit(f"error: allowlist config must be a JSON object: {path}")
    doc["_source"] = str(path)
    return doc


def agent_id(doc: dict, explicit: str | None) -> str:
    if explicit:
        return explicit.strip()
    env = os.environ.get("OPENCLAW_TASKS_AGENT", "").strip()
    if env:
        return env
    return str(doc.get("defaultAgent") or "main")


def roots_for(doc: dict, agent: str) -> list[str]:
    agents = doc.get("agents") or {}
    if not isinstance(agents, dict):
        return []
    entry = agents.get(agent)
    if entry is None:
        if agent == "main" and doc.get("_source") == "builtin-fallback":
            raw = FALLBACK_MAIN_ROOTS
        else:
            return []
    elif isinstance(entry, dict):
        raw = entry.get("allowedRoots") or []
    elif isinstance(entry, list):
        raw = entry
    else:
        raw = []
    out: list[str] = []
    for r in raw:
        e = expand_root(str(r))
        if e:
            out.append(e)
    return out


def path_allowed(path: str, roots: list[str]) -> bool:
    if not path:
        return False
    resolved = expand_root(path)
    for root in roots:
        if resolved == root or resolved.startswith(root + os.sep):
            return True
    return False


def main() -> None:
    ap = argparse.ArgumentParser(description="OpenClaw tasks allowlist resolver")
    ap.add_argument("command", choices=["roots", "check", "show", "path"])
    ap.add_argument("path", nargs="?")
    ap.add_argument("--agent", default=None)
    args = ap.parse_args()
    cfg = config_path()
    if args.command == "path":
        print(cfg)
        return
    doc = load_doc(cfg)
    agent = agent_id(doc, args.agent)
    roots = roots_for(doc, agent)
    if args.command == "roots":
        print(":".join(roots))
        return
    if args.command == "show":
        print(f"config: {doc.get("_source")}")
        print(f"agent:  {agent}")
        if not roots:
            print("roots:  (none - write denied)")
        else:
            print("roots:")
            for r in roots:
                print(f"  - {r}")
        return
    if args.command == "check":
        if not args.path:
            print("error: check requires PATH", file=sys.stderr)
            raise SystemExit(2)
        ok = path_allowed(args.path, roots)
        print("allow" if ok else "deny")
        raise SystemExit(0 if ok else 1)
    raise SystemExit(2)


if __name__ == "__main__":
    main()
