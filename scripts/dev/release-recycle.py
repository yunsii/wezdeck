#!/usr/bin/env python3
"""Persist and reconcile workstation recycle intents after release."""

import argparse
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


def same_repo(repo: Path, source: Path) -> bool:
    try:
        return (
            source != repo
            and Path(git(source, "rev-parse", "--path-format=absolute", "--git-common-dir"))
            == Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"))
        )
    except (OSError, subprocess.CalledProcessError):
        return False


def record_path(state: Path, source: Path, expected: str) -> Path:
    digest = hashlib.sha256(f"{source}\0{expected}".encode()).hexdigest()[:24]
    return state / "release" / "recycle" / f"{digest}.json"


def write_record(path: Path, record: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    record["updated_at"] = int(time.time())
    fd, temporary = tempfile.mkstemp(prefix=".recycle-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(record, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_record(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def state_deployed(state: Path) -> str:
    try:
        with (state / "release" / "state.json").open(encoding="utf-8") as stream:
            return json.load(stream).get("deployed_sha", "")
    except (OSError, ValueError):
        return ""


def is_ancestor(repo: Path, old: str, new: str) -> bool:
    return subprocess.run(
        ["git", "-C", str(repo), "merge-base", "--is-ancestor", old, new],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0


def transition(path: Path, record: dict, status: str, reason: str = "") -> None:
    record["status"] = status
    record["reason"] = reason[:240]
    write_record(path, record)
    print(f"recycle {path.stem}: {status}{' (' + reason[:120] + ')' if reason else ''}")
    with (path.parents[2] / "release.log").open("a", encoding="utf-8") as stream:
        stream.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} event=recycle id={path.stem} status={status}\n")


def reconcile_one(path: Path, record: dict, repo: Path, deployed: str) -> None:
    status = record.get("status")
    if status in ("done", "skipped"):
        return
    if status == "failed" and time.time() - record.get("last_attempt_at", 0) < 30:
        return
    source = Path(record["source"])
    expected = record["expected_head"]
    if not deployed or not is_ancestor(repo, expected, deployed):
        return
    if not same_repo(repo, source):
        transition(path, record, "skipped", "source checkout is missing or changed")
        return
    try:
        head = git(source, "rev-parse", "HEAD")
        branch = git(source, "branch", "--show-current")
        if status == "running" and head != expected and branch.startswith("dev/"):
            try:
                remote_branch = git(source, "rev-parse", f"refs/remotes/origin/{branch}")
            except subprocess.CalledProcessError:
                remote_branch = ""
            if head == remote_branch and is_ancestor(repo, head, deployed):
                transition(path, record, "done", "already recycled")
                return
        if head != expected:
            if status in ("running", "failed"):
                if status == "running":
                    transition(path, record, "failed", "recycle changed HEAD before completion; inspect remote sync")
                return
            transition(path, record, "skipped", "source HEAD changed")
            return
        if git(source, "status", "--porcelain", "--untracked-files=normal"):
            transition(path, record, "skipped", "source checkout is dirty")
            return
    except (OSError, subprocess.CalledProcessError):
        transition(path, record, "skipped", "source checkout cannot be inspected")
        return
    record["status"] = "running"
    record["attempts"] = record.get("attempts", 0) + 1
    record["last_attempt_at"] = int(time.time())
    write_record(path, record)
    command = [
        str(repo / "scripts/runtime/worktree/worktree-task"),
        "recycle",
        "--cwd", str(source),
        "-y", "--require-delivered", "--no-clean-files", "--keep-temp-branches",
    ]
    try:
        result = subprocess.run(command, cwd=repo, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        transition(path, record, "failed", "recycle command timed out")
        return
    except OSError:
        transition(path, record, "failed", "recycle command could not start")
        return
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().splitlines()
        reason = detail[-1] if detail else "recycle command failed"
        reason = reason.replace(str(source), "<worktree>").replace(str(repo), "<repo>")
        transition(path, record, "failed", reason)
    else:
        transition(path, record, "done")


def reconcile(state: Path, repo: Path, selected: Path | None = None) -> int:
    directory = state / "release" / "recycle"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (state / "release" / "recycle.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        deployed = state_deployed(state)
        paths = [selected] if selected else sorted(directory.glob("*.json"))
        for path in paths:
            if path.exists():
                reconcile_one(path, read_record(path), repo, deployed)
        if selected and selected.exists():
            return 0 if read_record(selected).get("status") == "done" else 4
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("record", "cancel", "reconcile", "watch", "status"))
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--expected")
    args = parser.parse_args()
    state = args.state.resolve()
    repo = args.repo.resolve()
    source = args.source.resolve() if args.source else None
    selected = record_path(state, source, args.expected) if source and args.expected else None
    if args.action in ("record", "cancel") and not selected:
        parser.error("record and cancel require --source and --expected")
    if args.action == "record":
        if not same_repo(repo, source) or git(source, "rev-parse", "HEAD") != args.expected:
            parser.error("source is not an unchanged linked checkout of this repository")
        if not selected.exists():
            write_record(selected, {
                "source": str(source), "expected_head": args.expected,
                "status": "pending", "reason": "", "attempts": 0,
                "created_at": int(time.time()),
            })
        print(f"recycle recorded: {selected.stem}")
        return 0
    if args.action == "cancel":
        if selected.exists() and read_record(selected).get("status") == "pending":
            selected.unlink()
        return 0
    if args.action == "reconcile":
        return reconcile(state, repo, selected)
    if args.action == "status":
        directory = state / "release" / "recycle"
        records = [read_record(path) for path in sorted(directory.glob("*.json"))]
        active = [row for row in records if row.get("status") != "done"]
        print(f"recycle:        {len(active)} pending/skipped/failed")
        for row in active[-8:]:
            print(f"  {Path(row['source']).name}: {row['status']} ({row['expected_head'][:8]}) {row.get('reason', '')}")
        return 0
    lock_path = state / "release" / "recycle-watch.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        deadline = time.monotonic() + 3600
        while time.monotonic() < deadline:
            reconcile(state, repo)
            directory = state / "release" / "recycle"
            if not any(read_record(path).get("status") in ("pending", "running", "failed") for path in directory.glob("*.json")):
                return 0
            time.sleep(5)
    return 0


if __name__ == "__main__":
    sys.exit(main())
