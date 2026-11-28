#!/usr/bin/env python3
"""Unit tests for P3 ticket manager workspace, charter, park/resume, and dead_ends."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

LIB_DIR = Path(__file__).resolve().parent / "lib"
sys.path.insert(0, str(LIB_DIR))

import dead_ends  # noqa: E402
import manager  # noqa: E402
import ticket_fs  # noqa: E402


class TestManagerAndDeadEnds(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.prev_root = os.environ.get("TICKETS_ROOT")
        self.prev_settings_dir = os.environ.get("WEZDECK_AGENT_PROFILE_SETTINGS_DIR")
        self.prev_profile = os.environ.get("MANAGED_AGENT_PROFILE")
        os.environ["TICKETS_ROOT"] = str(self.root)
        os.environ["WEZDECK_AGENT_PROFILE_SETTINGS_DIR"] = str(self.root / "profiles")
        os.environ.pop("MANAGED_AGENT_PROFILE", None)

        self.tid = "req-20261127-150001-mgr001"
        data_dir = self.root / "_data" / self.tid
        data_dir.mkdir(parents=True, exist_ok=True)
        (data_dir / "ticket.md").write_text(
            f"---\nid: {self.tid}\ntitle: Test Manager\nfrom: wezdeck\nto: coco-forge\nstatus: in_progress\n---\n\n## Summary\nDemo\n",
            encoding="utf-8",
        )
        (data_dir / "contract.md").write_text("# Contract\n", encoding="utf-8")
        (data_dir / "meta.json").write_text(
            json.dumps({"kind": "parent", "repos": ["coco-forge"]}),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        if self.prev_root is None:
            os.environ.pop("TICKETS_ROOT", None)
        else:
            os.environ["TICKETS_ROOT"] = self.prev_root
        if self.prev_settings_dir is None:
            os.environ.pop("WEZDECK_AGENT_PROFILE_SETTINGS_DIR", None)
        else:
            os.environ["WEZDECK_AGENT_PROFILE_SETTINGS_DIR"] = self.prev_settings_dir
        if self.prev_profile is None:
            os.environ.pop("MANAGED_AGENT_PROFILE", None)
        else:
            os.environ["MANAGED_AGENT_PROFILE"] = self.prev_profile
        self.tmp.cleanup()

    def test_workspace_charter_and_dry_run_start(self) -> None:
        out = manager.cmd_start(["--id", self.tid, "--profile", "claude", "--dry-run"])
        self.assertTrue(out["ok"])
        self.assertEqual(out["action"], "dry_run")
        ws = self.root / "workspaces" / self.tid
        self.assertTrue((self.root / "workspaces" / "AGENTS.md").is_file())
        self.assertTrue((self.root / "workspaces" / "CLAUDE.md").is_symlink())
        self.assertTrue((ws / "CLAUDE.md").is_file())
        self.assertTrue((ws / "ticket.md").is_symlink())
        self.assertTrue((ws / "contract.md").is_symlink())
        self.assertTrue((ws / "notes").is_dir())
        self.assertIn(self.tid, (ws / "CLAUDE.md").read_text(encoding="utf-8"))

    def test_default_profile_and_disabled_profile(self) -> None:
        os.environ["MANAGED_AGENT_PROFILE"] = "codex"
        out = manager.cmd_start(["--id", self.tid, "--dry-run"])
        self.assertEqual(out["manager_session"]["profile"], "codex")

        settings_dir = self.root / "profiles"
        settings_dir.mkdir()
        (settings_dir / "claude.json").write_text('{"disabled": true}', encoding="utf-8")
        with self.assertRaises(SystemExit) as error:
            manager.cmd_start(["--id", self.tid, "--profile", "claude", "--dry-run"])
        self.assertEqual(error.exception.code, 3)
        self.assertNotIn("manager_session", ticket_fs.read_meta_json(self.tid))

    def test_switch_backend_drops_incompatible_resume_id(self) -> None:
        mj = ticket_fs.read_meta_json(self.tid)
        mj["manager_session"] = {
            "backend": "claude", "profile": "claude", "id": "claude-session",
            "state": "parked",
        }
        ticket_fs.write_meta_json(self.tid, mj)
        out = manager.cmd_start(["--id", self.tid, "--profile", "codex", "--dry-run"], resume_mode=True)
        self.assertEqual(out["manager_session"]["id"], "")

    def test_park_does_not_kill_reused_pane(self) -> None:
        mj = ticket_fs.read_meta_json(self.tid)
        mj["manager_session"] = {"state": "live", "tmux_pane": "%195"}
        ticket_fs.write_meta_json(self.tid, mj)

        def fake_tmux(*args: str) -> subprocess.CompletedProcess[str]:
            if args[-1] == "#{pane_id}":
                return subprocess.CompletedProcess(args, 0, "%195\n", "")
            if args[-1] == "#{@wezdeck_ticket_id}":
                return subprocess.CompletedProcess(args, 0, "another-ticket\n", "")
            raise AssertionError(f"unexpected tmux call: {args}")

        with patch.object(manager, "tmux_cmd", side_effect=fake_tmux):
            out = manager.cmd_park(["--id", self.tid])
        self.assertEqual(out["action"], "parked")
        self.assertEqual(ticket_fs.read_meta_json(self.tid)["manager_session"]["tmux_pane"], "")

    def test_dead_ends_record_and_bounded_read(self) -> None:
        dead_ends.record_dead_end(
            self.tid,
            role="worker",
            source_id="run-1",
            tried="implement via codex",
            reason="typecheck failed on missing export",
        )
        text = dead_ends.read_dead_ends(self.tid)
        self.assertIn("Dead Ends", text)
        self.assertIn("typecheck failed on missing export", text)

        # Verify bounded tail when many entries accumulate
        for i in range(40):
            dead_ends.record_dead_end(
                self.tid,
                role="proposal",
                source_id=f"prop-{i}",
                tried=f"split attempt {i} " + ("x" * 80),
                reason=f"rejected reason {i}",
            )
        bounded = dead_ends.read_dead_ends(self.tid, max_bytes=1024)
        self.assertLessEqual(len(bounded.encode("utf-8")), 1150)
        self.assertIn("rejected reason 39", bounded)

    def test_park_and_gc_on_terminal_ticket(self) -> None:
        mj = ticket_fs.read_meta_json(self.tid)
        mj["manager_session"] = {
            "backend": "claude",
            "profile": "claude",
            "id": "sess-old",
            "cwd": str(self.root / "workspaces" / self.tid),
            "tmux_session": "wezterm_collab_tickets",
            "tmux_window": "ticket-mgr001",
            "tmux_pane": "",
            "state": "live",
            "updated_at": "2025-01-01T00:00:00Z",
        }
        ticket_fs.write_meta_json(self.tid, mj)
        meta, body = ticket_fs.read_ticket(self.tid)
        meta["status"] = "closed"
        ticket_fs.write_ticket(self.tid, meta, body)

        gc_out = manager.cmd_gc(["--idle-minutes", "30"])
        self.assertEqual(gc_out["parked"], [self.tid])
        after = ticket_fs.read_meta_json(self.tid)
        self.assertEqual(after["manager_session"]["state"], "parked")
        self.assertEqual(after["manager_session"]["id"], "sess-old")

    def test_split_parse_backends(self) -> None:
        import fanout  # noqa: F401, PLC0415
        import split  # noqa: PLC0415

        self.assertEqual(split.parse_backends("a=codex,b=claude,c=grok"), {
            "a": "codex",
            "b": "claude",
            "c": "grok",
        })
        self.assertEqual(split.parse_backends(None), {})
        with self.assertRaises(Exception):
            split.parse_backends("a=unknown")


if __name__ == "__main__":
    unittest.main()
