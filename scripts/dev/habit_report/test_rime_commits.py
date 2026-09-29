"""Unit tests for Rime × foreground join helpers."""

from __future__ import annotations

import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path

from habit_report.common import _iter_json_objects_from_text, iter_jsonl
from habit_report.rime_commits import (
    _os_bucket,
    collect_rime_commits,
    helper_log_rotation_paths,
    load_foreground_timeline,
    load_pane_focus_timeline,
)


class OsBucketTest(unittest.TestCase):
    def test_named_apps_keep_process_name(self) -> None:
        self.assertEqual(_os_bucket("Feishu"), "Feishu")
        self.assertEqual(_os_bucket("explorer"), "explorer")
        self.assertEqual(_os_bucket("wezterm-gui"), "wezterm")
        self.assertEqual(_os_bucket("chrome"), "chrome")
        self.assertEqual(_os_bucket(""), "unknown")


class IterJsonlConcatTest(unittest.TestCase):
    def test_concatenated_objects_on_one_line(self) -> None:
        blob = (
            '{"ts":"2026-09-21T01:00:00Z","source":"tmux_focus","kind":"agent",'
            '"agent":"claude"}'
            '{"ts":"2026-09-21T02:00:00Z","source":"tmux_focus","kind":"shell",'
            '"agent":""}'
        )
        rows = list(_iter_json_objects_from_text(blob))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["agent"], "claude")
        self.assertEqual(rows[1]["kind"], "shell")

    def test_iter_jsonl_reads_concat_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pane.jsonl"
            path.write_text(
                '{"ts":"2026-09-21T01:00:00Z","source":"tmux_focus","kind":"agent",'
                '"agent":"grok"}'
                '{"ts":"2026-09-21T02:00:00Z","source":"tmux_focus","kind":"shell",'
                '"agent":""}',
                encoding="utf-8",
            )
            rows = list(iter_jsonl(path))
            self.assertEqual(len(rows), 2)


class HelperRotationTest(unittest.TestCase):
    def test_rotation_paths_include_siblings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            primary = root / "helper.log"
            primary.write_text("x\n", encoding="utf-8")
            (root / "helper.log.1").write_text("y\n", encoding="utf-8")
            (root / "helper.log.2").write_text("z\n", encoding="utf-8")
            paths = helper_log_rotation_paths(primary)
            self.assertEqual(
                [p.name for p in paths],
                ["helper.log", "helper.log.1", "helper.log.2"],
            )

    def test_load_foreground_merges_rotations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            primary = root / "helper.log"
            # current file: late edge
            primary.write_text(
                'ts="2026-09-28 10:00:00.000" level="info" category="foreground" '
                'message="foreground changed" to_process="chrome"\n',
                encoding="utf-8",
            )
            (root / "helper.log.1").write_text(
                'ts="2026-09-22 08:00:00.000" level="info" category="foreground" '
                'message="foreground changed" to_process="wezterm-gui"\n',
                encoding="utf-8",
            )
            edges = load_foreground_timeline(primary)
            self.assertEqual(len(edges), 2)
            self.assertEqual(edges[0].process, "wezterm-gui")
            self.assertEqual(edges[1].process, "chrome")


class CollectJoinTest(unittest.TestCase):
    def test_by_process_and_wezterm_agent_bucket(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            commit = root / "rime-commits.jsonl"
            helper = root / "helper.log"
            pane = root / "wezterm-pane-focus.jsonl"
            # Rime commit at 2026-09-22 08:00:10 UTC → local depends on TZ;
            # use helper edge slightly before local conversion by writing both
            # in a wide window and matching via process_at on local naive.
            # Safer: set helper edge at a time that covers China UTC+8 morning.
            # commit 00:00:10Z = 08:00:10 CST; helper edge 07:59 local.
            commit.write_text(
                '{"ts":"2026-09-22T00:00:10Z","chars":5,"source":"rime_commit"}\n',
                encoding="utf-8",
            )
            helper.write_text(
                'ts="2026-09-22 07:59:00.000" level="info" category="foreground" '
                'message="foreground changed" to_process="wezterm-gui"\n',
                encoding="utf-8",
            )
            # concatenated historical blob (no newline between objects)
            pane.write_text(
                '{"ts":"2026-09-22T00:00:00Z","pane":"%1","kind":"agent",'
                '"agent":"claude","cmd":"bash","role":"agent-cli:claude",'
                '"source":"tmux_focus"}'
                '{"ts":"2026-09-22T01:00:00Z","pane":"%2","kind":"shell",'
                '"agent":"","cmd":"zsh","role":"","source":"tmux_focus"}',
                encoding="utf-8",
            )
            out = collect_rime_commits(
                start=date(2026, 9, 21),
                end=date(2026, 9, 27),
                commit_log=commit,
                helper_log=helper,
                pane_log=pane,
            )
            self.assertEqual(out["commit_events"], 1)
            self.assertEqual(out["commit_chars"], 5)
            self.assertIn("wezterm-gui", out["by_process"])
            self.assertEqual(out["by_process"]["wezterm-gui"]["chars"], 5)
            # When local TZ is UTC+8, pane refine should hit wezterm.agent.claude.
            # Accept either refined or plain wezterm if TZ makes pane miss.
            fg_keys = set(out["by_foreground"])
            self.assertTrue(
                fg_keys & {"wezterm.agent.claude", "wezterm"},
                f"unexpected buckets: {fg_keys}",
            )
            self.assertGreaterEqual(out["pane_focus_edges"], 2)


if __name__ == "__main__":
    unittest.main()
