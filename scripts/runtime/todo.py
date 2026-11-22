#!/usr/bin/env python3
"""Repo follow-ups (待办) in a host SQLite table — stdlib only.

A to-do belongs to a repository, not to an agent session: a big change gets a
note while working, and any later session in that repo (or another agent) can
pick it up after the original conversation is gone. Repos are keyed by the git
common dir, so every worktree of one repo shares one list. The phone reads and
writes through the relay (native/wezdeck-wsl, `todos` / signed `todo`); agents
call this CLI from the repo.

  todo.py add [--cwd PATH] [--session ID] [--source agent|phone] [--] TEXT...
  todo.py list [--cwd PATH | --all] [--open | --done] [--json]
  todo.py done ID | reopen ID | delete ID
  todo.py edit ID TEXT...

DB: ${WEZDECK_TODO_DB:-~/.local/state/wezdeck/wezdeck.db}, table `todos`.
--json prints {"v":1,"ok":true,...}; errors {"v":1,"ok":false,"error":...} exit 2.
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS todos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_key    TEXT NOT NULL,   -- git common dir (all worktrees share it)
  repo_label  TEXT NOT NULL,   -- display name
  repo_root   TEXT NOT NULL,   -- main checkout, for opening a session there
  text        TEXT NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT 'agent',  -- agent | phone
  session_id  TEXT,            -- the conversation it was written in (may be gone)
  worktree    TEXT,            -- the checkout it was written in
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  done_at     INTEGER
);
CREATE INDEX IF NOT EXISTS todos_repo ON todos (repo_key, done);
"""
MAX_TEXT = 2000


class TodoError(Exception):
    pass


def db_path() -> Path:
    p = os.environ.get("WEZDECK_TODO_DB")
    return Path(p) if p else Path.home() / ".local/state/wezdeck/wezdeck.db"


def connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    return conn


def git(cwd: str, *args: str) -> str:
    try:
        out = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


def repo_of(cwd: str) -> dict[str, str]:
    common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if not common:
        raise TodoError(f"{cwd} is not inside a git repository")
    common = str(Path(common).resolve())
    root = str(Path(common).parent) if common.endswith("/.git") else common
    return {"repo_key": common, "repo_label": Path(root).name, "repo_root": root,
            "worktree": git(cwd, "rev-parse", "--show-toplevel")}


def row(r: sqlite3.Row) -> dict[str, Any]:
    d = dict(r)
    d["done"] = bool(d["done"])
    return d


def opt(argv: list[str], name: str) -> str | None:
    if name in argv:
        i = argv.index(name)
        if i + 1 >= len(argv):
            raise TodoError(f"{name} needs a value")
        val = argv[i + 1]
        del argv[i : i + 2]
        return val
    return None


def flag(argv: list[str], name: str) -> bool:
    if name in argv:
        argv.remove(name)
        return True
    return False


def get(conn: sqlite3.Connection, tid: str) -> dict[str, Any]:
    if not tid.isdigit():
        raise TodoError("id must be a number")
    r = conn.execute("SELECT * FROM todos WHERE id = ?", (int(tid),)).fetchone()
    if r is None:
        raise TodoError(f"no to-do {tid}")
    return row(r)


def cmd(argv: list[str]) -> dict[str, Any]:
    if not argv:
        raise TodoError("usage: todo.py add|list|done|reopen|delete|edit …")
    verb, argv = argv[0], argv[1:]
    flag(argv, "--json")
    # everything after `--` is text, never an option (the phone's text can
    # start with "--")
    text_args: list[str] = []
    if "--" in argv:
        i = argv.index("--")
        argv, text_args = argv[:i], argv[i + 1 :]
    conn = connect()
    now = int(time.time())
    if verb == "add":
        cwd = opt(argv, "--cwd") or os.getcwd()
        session = opt(argv, "--session")
        source = opt(argv, "--source") or "agent"
        if source not in ("agent", "phone"):
            raise TodoError("--source is agent or phone")
        text = " ".join(argv + text_args).strip()
        if not text:
            raise TodoError("empty to-do")
        if len(text) > MAX_TEXT:
            raise TodoError(f"to-do longer than {MAX_TEXT} characters")
        repo = repo_of(cwd)
        with conn:
            cur = conn.execute(
                "INSERT INTO todos (repo_key, repo_label, repo_root, text, source, session_id, worktree,"
                " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (repo["repo_key"], repo["repo_label"], repo["repo_root"], text, source, session,
                 repo["worktree"], now, now))
        return {"todo": get(conn, str(cur.lastrowid))}
    if verb == "list":
        everything = flag(argv, "--all")
        only_open, only_done = flag(argv, "--open"), flag(argv, "--done")
        cwd = opt(argv, "--cwd") or os.getcwd()
        where, args = [], []
        repo = None
        if not everything:
            repo = repo_of(cwd)
            where.append("repo_key = ?")
            args.append(repo["repo_key"])
        if only_open:
            where.append("done = 0")
        if only_done:
            where.append("done = 1")
        sql = "SELECT * FROM todos" + (" WHERE " + " AND ".join(where) if where else "")
        sql += " ORDER BY done, CASE WHEN done = 0 THEN created_at END DESC, done_at DESC LIMIT 500"
        todos = [row(r) for r in conn.execute(sql, args)]
        return {"repo": repo, "todos": todos}
    if verb in ("done", "reopen", "delete", "edit"):
        if not argv:
            raise TodoError(f"{verb} needs an id")
        tid, rest = argv[0], argv[1:]
        before = get(conn, tid)
        with conn:
            if verb == "done":
                conn.execute("UPDATE todos SET done=1, done_at=?, updated_at=? WHERE id=?", (now, now, int(tid)))
            elif verb == "reopen":
                conn.execute("UPDATE todos SET done=0, done_at=NULL, updated_at=? WHERE id=?", (now, int(tid)))
            elif verb == "delete":
                conn.execute("DELETE FROM todos WHERE id=?", (int(tid),))
                return {"deleted": before}
            else:
                text = " ".join(rest).strip()
                if not text or len(text) > MAX_TEXT:
                    raise TodoError("edit needs 1–2000 characters")
                conn.execute("UPDATE todos SET text=?, updated_at=? WHERE id=?", (text, now, int(tid)))
        return {"todo": get(conn, tid)}
    raise TodoError(f"unknown command {verb}")


def human(result: dict[str, Any]) -> str:
    if "todos" in result:
        lines = []
        for t in result["todos"]:
            lines.append(f"{'✓' if t['done'] else '○'} #{t['id']} [{t['repo_label']}] {t['text']}")
        return "\n".join(lines) or "(no to-dos)"
    t = result.get("todo") or result.get("deleted") or {}
    return f"#{t.get('id')} {'✓' if t.get('done') else '○'} {t.get('text', '')}"


def main(argv: list[str]) -> int:
    as_json = "--json" in argv
    try:
        result = cmd(list(argv))
    except (TodoError, sqlite3.Error) as e:
        if as_json:
            print(json.dumps({"v": 1, "ok": False, "error": str(e)}, ensure_ascii=False))
        else:
            print(f"todo: {e}", file=sys.stderr)
        return 2
    if as_json:
        print(json.dumps({"v": 1, "ok": True, **result}, ensure_ascii=False))
    else:
        print(human(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
