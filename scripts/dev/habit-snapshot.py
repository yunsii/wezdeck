#!/usr/bin/env python3
"""Build atomic, browser-readable habit snapshots from the weekly skill."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import subprocess
import tempfile
import time
from datetime import date, timedelta
from pathlib import Path


def snapshot_dir() -> Path:
    override = os.environ.get("WEZDECK_HABIT_SNAPSHOT_DIR")
    if override:
        return Path(override)
    state = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state")))
    return state / "wezterm-runtime/state/workflow/habit-weekly"


def run_report(repo: Path, *args: str) -> dict:
    result = subprocess.run(
        [str(repo / "skills/habit-weekly/run.sh"), *args, "--json-only"],
        check=True, capture_output=True, text=True, timeout=180,
    )
    return json.loads(result.stdout)


def render_report(repo: Path, report: dict, directory: Path) -> str:
    source = directory / "report.json"
    output = directory / "report.md"
    source.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
    subprocess.run(
        ["python3", str(repo / "skills/habit-weekly/render.py"),
         "--input", str(source), "--output", str(output)],
        check=True, capture_output=True, text=True, timeout=30,
    )
    return output.read_text(encoding="utf-8")


def write_snapshot(repo: Path, target: Path, report: dict) -> None:
    with tempfile.TemporaryDirectory(dir=target.parent) as temporary:
        markdown = render_report(repo, report, Path(temporary))
    payload = {"report": report, "markdown": markdown}
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=target.parent, delete=False
    ) as temporary:
        json.dump(payload, temporary, ensure_ascii=False)
        temporary.write("\n")
        temporary_path = Path(temporary.name)
    try:
        os.replace(temporary_path, target)
    finally:
        temporary_path.unlink(missing_ok=True)


def current_week(today: date) -> tuple[date, date]:
    return today - timedelta(days=today.weekday()), today


def last_week(today: date) -> tuple[date, date]:
    end = today - timedelta(days=today.weekday() + 1)
    return end - timedelta(days=6), end


def snapshot_matches(path: Path, start: date, end: date) -> bool:
    try:
        report = json.loads(path.read_text(encoding="utf-8"))["report"]
        return report["window"] == {
            "start": start.isoformat(), "end": end.isoformat(),
            "label": f"{start.isoformat()}→{end.isoformat()}",
        }
    except (OSError, ValueError, KeyError, TypeError):
        return False


def generate(repo: Path, directory: Path, today: date, archive: bool) -> None:
    periods = [
        ("this", current_week(today)),
        ("14d", (today - timedelta(days=13), today)),
        ("last", last_week(today)),
    ]
    for name, (start, end) in periods:
        target = directory / f"{name}.json"
        if name == "last" and snapshot_matches(target, start, end):
            continue
        began = time.monotonic()
        report = run_report(
            repo, "--since", start.isoformat(), "--until", end.isoformat()
        )
        write_snapshot(repo, target, report)
        print(
            f"category=habit_snapshot event=generated period={name} "
            f"duration_ms={int((time.monotonic() - began) * 1000)}",
            flush=True,
        )

    last_end = last_week(today)[1].isoformat()
    marker = directory / "archive-until"
    if not archive or (marker.exists() and marker.read_text().strip() == last_end):
        return
    began = time.monotonic()
    subprocess.run(
        [str(repo / "skills/habit-weekly/run.sh"), "--week", "last",
         "--no-catch-up", "--write", "--push"],
        check=True, capture_output=True, text=True, timeout=300,
    )
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=directory, delete=False
    ) as temporary:
        temporary.write(last_end + "\n")
        temporary_path = Path(temporary.name)
    os.replace(temporary_path, marker)
    print(
        f"category=habit_snapshot event=archived until={last_end} "
        f"duration_ms={int((time.monotonic() - began) * 1000)}",
        flush=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-archive", action="store_true")
    args = parser.parse_args()
    repo = Path(os.environ.get("WEZDECK_REPO", Path(__file__).resolve().parents[2]))
    directory = snapshot_dir()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    with (directory / ".snapshot.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            generate(repo, directory, date.today(), not args.no_archive)
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            print(
                f"category=habit_snapshot event=failed reason={type(error).__name__}",
                flush=True,
            )
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
