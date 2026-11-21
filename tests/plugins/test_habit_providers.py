"""habit_report provider discovery from WezDeck agent plugins
(scripts/dev/habit_report/providers/__init__.py)."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts/dev"))
from habit_report import providers as hp  # noqa: E402

PKG = REPO / "scripts/dev/habit_report/providers"


def agent(pid: str, enabled: bool, path: Path) -> dict:
    return {"id": pid, "kind": "agent", "enabled": enabled, "agent_files": {"habit_provider": str(path)}}


class HabitProviderDiscovery(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def reg(self, plugins) -> Path:
        p = self.tmp / "registry.json"
        p.write_text(json.dumps({"version": 1, "plugins": plugins}))
        return p

    def test_disabled_agent_plugin_is_dropped(self):
        r = self.reg([agent("agent-claude", True, PKG / "claude.py"),
                      agent("agent-codex", True, PKG / "codex.py"),
                      agent("agent-grok", False, PKG / "grok.py")])
        got = hp.load_providers(r)
        self.assertEqual(sorted(got), ["claude", "codex"])
        self.assertIs(got["claude"], hp.BUILTIN_PROVIDERS["claude"], "built-in imported as package module")

    def test_fallbacks_to_builtins(self):
        self.assertEqual(sorted(hp.load_providers(self.tmp / "absent.json")), ["claude", "codex", "grok"])
        no_agents = self.reg([{"id": "disk-guard", "kind": "guard", "enabled": True}])
        self.assertEqual(sorted(hp.load_providers(no_agents)), ["claude", "codex", "grok"])
        broken = self.tmp / "broken.json"
        broken.write_text("{nope")
        self.assertEqual(sorted(hp.load_providers(broken)), ["claude", "codex", "grok"])

    def test_external_provider_loaded_by_path(self):
        ext = self.tmp / "myai.py"
        ext.write_text(
            "from habit_report.schema import ProviderMetrics\n"
            "def collect(*, start, end, root):\n"
            "    return ProviderMetrics(provider='myai')\n"
        )
        got = hp.load_providers(self.reg([agent("my-ai", True, ext)]))
        self.assertEqual(list(got), ["myai"])
        self.assertEqual(got["myai"](start=None, end=None, root=None).provider, "myai")

    def test_repo_registry_shape(self):
        """With the real compiled registry, every built-in agent plugin resolves."""
        sys.path.insert(0, str(REPO / "scripts/runtime"))
        import plugins_compile as pc
        out = self.tmp / "out"
        reg, errs = pc.compile_plugins(REPO, None, self.tmp / "none.json", out)
        self.assertEqual(errs, [])
        got = hp.load_providers(out / "registry.generated.json")
        self.assertEqual(sorted(got), ["claude", "codex", "grok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
