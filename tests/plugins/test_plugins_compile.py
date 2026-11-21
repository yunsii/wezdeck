"""Unit tests for scripts/runtime/plugins_compile.py (driven by
tests/hook-units/test_plugins_compile.sh)."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts/runtime"))
import plugins_compile as pc  # noqa: E402


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def plugin(root: Path, pid: str, **manifest) -> Path:
    d = root / pid
    m = {"id": pid, "requires": {"host": ["hybrid-wsl"]}}
    m.update(manifest)
    write(d / "plugin.json", json.dumps(m))
    if "badge" in m:
        write(d / m["badge"]["module"], "return {}")
    for rel in (m.get("cli") or {}).values():
        write(d / rel, "#!/bin/sh\n")
    if "producer" in m:
        write(d / m["producer"]["install"].split()[0], "#!/bin/sh\n")
    for rel in (m.get("agent") or {}).values():
        write(d / rel, "")
    return d


def badge(order: int, **cfg) -> dict:
    return {"module": "lua/badge.lua", "order": order, "config": cfg}


class CompileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "repo"
        self.builtin = self.repo / "wezterm-x/plugins"
        self.builtin.mkdir(parents=True)
        self.ext = self.tmp / "ext"
        self.local = self.tmp / "local.json"
        self.out = self.tmp / "out"

    def run_compile(self):
        return pc.compile_plugins(self.repo, self.ext, self.local, self.out)

    def test_enabled_badges_sorted_and_lua_parses(self):
        plugin(self.builtin, "b-two", badge=badge(20, state_file="${runtime_state_dir}/b.json"))
        plugin(self.builtin, "a-one", badge=badge(10, n=1))
        reg, errs = self.run_compile()
        self.assertEqual(errs, [])
        lua = (self.out / "registry.generated.lua").read_text()
        self.assertLess(lua.index('"a-one"'), lua.index('"b-two"'))
        self.assertIn('"${runtime_state_dir}/b.json"', lua)
        # Generated Lua must load with the real interpreter.
        r = subprocess.run(["lua5.4", "-e", f"local r=dofile('{self.out}/registry.generated.lua'); assert(#r.badges==2); assert(r.badges[1].id=='a-one')"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        js = json.loads((self.out / "registry.generated.json").read_text())
        self.assertEqual([p["id"] for p in js["plugins"]], ["a-one", "b-two"])

    def test_local_disable_enable_and_config_merge(self):
        plugin(self.builtin, "on", badge=badge(10, warn=1, keep="x"))
        plugin(self.builtin, "off", default_enabled=False, badge=badge(20))
        plugin(self.builtin, "gone", badge=badge(30))
        write(self.local, json.dumps({"disabled": ["gone"], "enabled": ["off"], "config": {"on": {"warn": 5}}}))
        reg, errs = self.run_compile()
        self.assertEqual(errs, [])
        state = {p["id"]: p["enabled"] for p in reg["plugins"]}
        self.assertEqual(state, {"gone": False, "off": True, "on": True})
        on = next(p for p in reg["plugins"] if p["id"] == "on")
        self.assertEqual(on["badge"]["config"], {"warn": 5, "keep": "x"})
        self.assertNotIn('"gone"', (self.out / "registry.generated.lua").read_text())

    def test_unknown_local_id_is_an_error(self):
        plugin(self.builtin, "real", badge=badge(10))
        write(self.local, json.dumps({"disabled": ["typo"]}))
        _, errs = self.run_compile()
        self.assertTrue(any("unknown plugin id 'typo'" in e for e in errs), errs)

    def test_validation_errors(self):
        d = plugin(self.builtin, "bad", badge=badge(10))
        (d / "lua/badge.lua").unlink()
        plugin(self.builtin, "Wrong_ID")
        write(self.builtin / "mismatch/plugin.json", json.dumps({"id": "other", "requires": {"host": []}}))
        write(self.builtin / "broken/plugin.json", "{not json")
        plugin(self.builtin, "blind", producer={"install": "bin/install.sh"})
        plugin(self.builtin, "host", requires={"host": ["macos"]})
        plugin(self.builtin, "extra", surprise=True)
        _, errs = self.run_compile()
        text = "\n".join(errs)
        for needle in ["badge.module 'lua/badge.lua' not found", "id must match", "must equal directory name",
                       "invalid JSON", "blind background work", "requires.host", "unknown keys"]:
            self.assertIn(needle, text)
        self.assertFalse((self.out / "registry.generated.lua").exists(), "no output on error")

    def test_duplicate_badge_order_among_enabled(self):
        plugin(self.builtin, "x", badge=badge(10))
        plugin(self.builtin, "y", badge=badge(10))
        _, errs = self.run_compile()
        self.assertTrue(any("badge.order 10" in e for e in errs), errs)
        write(self.local, json.dumps({"disabled": ["y"]}))
        _, errs = self.run_compile()
        self.assertEqual(errs, [], "a disabled plugin does not claim its order")

    def test_external_plugin_copied_and_duplicate_id_rejected(self):
        plugin(self.ext, "mine", badge=badge(50))
        reg, errs = self.run_compile()
        self.assertEqual(errs, [])
        self.assertTrue((self.out / ".external/mine/lua/badge.lua").is_file())
        self.assertIn('"plugins/.external/mine"', (self.out / "registry.generated.lua").read_text())
        plugin(self.builtin, "mine", badge=badge(60))
        _, errs = self.run_compile()
        self.assertTrue(any("duplicate id 'mine'" in e for e in errs), errs)

    def test_agent_and_producer_files_checked(self):
        plugin(self.builtin, "agent-x", kind="agent", agent={"habit_provider": "habit.py"},
               cli={"status": "bin/status.sh"}, producer={"install": "bin/install.sh --flag"})
        reg, errs = self.run_compile()
        self.assertEqual(errs, [])
        entry = next(p for p in reg["plugins"] if p["id"] == "agent-x")
        self.assertEqual(entry["agent_files"]["habit_provider"], str((self.builtin / "agent-x/habit.py").resolve()))

    def test_repo_builtin_plugins_compile(self):
        """The real built-in plugins in this repo must always validate."""
        reg, errs = pc.compile_plugins(REPO, None, self.tmp / "none.json", self.out)
        self.assertEqual(errs, [])
        ids = [p["id"] for p in reg["plugins"]]
        for pid in ("oppo-remote", "disk-guard", "mem-guard", "load-guard", "session-bridge",
                    "agent-claude", "agent-codex", "agent-grok"):
            self.assertIn(pid, ids)
        for p in reg["plugins"]:
            for f in p.get("agent_files", {}).values():
                self.assertTrue(Path(f).is_file(), f)


if __name__ == "__main__":
    unittest.main(verbosity=2)
