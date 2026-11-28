from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("habit-snapshot.py")
SPEC = importlib.util.spec_from_file_location("habit_snapshot", SCRIPT)
assert SPEC and SPEC.loader
snapshot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(snapshot)


def report_for(*args: str) -> dict:
    start = args[args.index("--since") + 1]
    end = args[args.index("--until") + 1]
    return {
        "window": {"start": start, "end": end, "label": f"{start}→{end}"},
        "generated_at": "2026-11-28T01:00:00Z",
    }


class HabitSnapshotTests(unittest.TestCase):
    def test_periods_and_complete_week_reuse(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            with (
                patch.object(
                    snapshot, "run_report",
                    side_effect=lambda _repo, *args: report_for(*args),
                ) as run,
                patch.object(snapshot, "render_report", return_value="# Week\n"),
            ):
                snapshot.generate(path, path, date(2026, 11, 28), archive=False)
                self.assertEqual(run.call_count, 3)
                current = json.loads((path / "this.json").read_text())
                last = json.loads((path / "last.json").read_text())
                self.assertEqual(current["report"]["window"]["start"], "2026-11-23")
                self.assertEqual(last["report"]["window"]["end"], "2026-11-22")
                self.assertEqual(last["markdown"], "# Week\n")
                snapshot.generate(path, path, date(2026, 11, 28), archive=False)
                self.assertEqual(run.call_count, 5)

    def test_failed_render_preserves_last_good_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "this.json"
            path.write_text('{"previous":true}', encoding="utf-8")
            with patch.object(snapshot, "render_report", side_effect=OSError("failed")):
                with self.assertRaises(OSError):
                    snapshot.write_snapshot(
                        Path(directory), path,
                        report_for("--since", "2026-11-23", "--until", "2026-11-28"),
                    )
            self.assertEqual(json.loads(path.read_text()), {"previous": True})

    def test_private_archive_retries_until_success_marker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            with (
                patch.object(
                    snapshot, "run_report",
                    side_effect=lambda _repo, *args: report_for(*args),
                ),
                patch.object(snapshot, "render_report", return_value="# Week\n"),
                patch.object(snapshot.subprocess, "run") as run,
            ):
                run.side_effect = snapshot.subprocess.CalledProcessError(1, "archive")
                with self.assertRaises(snapshot.subprocess.CalledProcessError):
                    snapshot.generate(path, path, date(2026, 11, 28), archive=True)
                self.assertFalse((path / "archive-until").exists())
                self.assertTrue((path / "this.json").exists())
                run.side_effect = None
                snapshot.generate(path, path, date(2026, 11, 28), archive=True)
                self.assertEqual(run.call_count, 2)
                self.assertIn("--no-catch-up", run.call_args.args[0])
                self.assertEqual(
                    (path / "archive-until").read_text().strip(), "2026-11-22"
                )


if __name__ == "__main__":
    unittest.main()
