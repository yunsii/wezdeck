from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from datetime import date
from pathlib import Path

from habit_report.work_focus import collect_work_focus


class WorkFocusTests(unittest.TestCase):
    def test_areas_overlap_and_merge_commits_do_not_count(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            self._git(repo, "init", "-q", "-b", "master")
            self._git(repo, "config", "user.name", "Example")
            self._git(repo, "config", "user.email", "example@example.com")

            self._commit(repo, ["web/src/page.ts"], "2026-11-17")
            self._git(repo, "checkout", "-q", "-b", "relay")
            self._commit(repo, ["native/wezdeck-wsl/relay.go"], "2026-11-18")
            self._git(repo, "checkout", "-q", "master")
            self._commit(repo, ["web/src/app.ts", "docs/web.md"], "2026-11-19")
            self._git(repo, "merge", "-q", "--no-ff", "relay", "-m", "merge relay")

            focus = collect_work_focus(
                repo, start=date(2026, 11, 16), end=date(2026, 11, 22)
            )
            self.assertEqual(focus["commits"], 3)
            self.assertEqual(focus["web_related"], 3)
            self.assertEqual(focus["areas"], {"web": 2, "relay": 1, "docs": 1})
            self.assertEqual(
                [row["day"] for row in focus["daily"]],
                ["2026-11-17", "2026-11-18", "2026-11-19"],
            )

    @staticmethod
    def _git(repo: Path, *args: str, env: dict[str, str] | None = None) -> None:
        subprocess.run(
            ["git", "-C", str(repo), *args],
            check=True,
            stdout=subprocess.DEVNULL,
            env=env,
        )

    def _commit(self, repo: Path, paths: list[str], day: str) -> None:
        for name in paths:
            path = repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(day, encoding="utf-8")
        self._git(repo, "add", *paths)
        env = os.environ.copy()
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = f"{day}T12:00:00+08:00"
        self._git(repo, "commit", "-qm", day, env=env)


if __name__ == "__main__":
    unittest.main()
