"""Provider plugin registry.

Providers come from enabled `kind: agent` WezDeck plugins
(wezterm-x/plugins/<id>/plugin.json → agent.habit_provider), so a machine
that disables e.g. agent-grok in wezterm-x/local/plugins.json drops it from
the habit report. A provider file inside this package is imported as
`habit_report.providers.<name>`; a machine plugin's file is loaded by path and
must use absolute imports (`from habit_report.schema import ...`).
No registry, or one that declares no agent plugins → the built-ins.
Docs: docs/plugin-architecture.md#agent-providers
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import os
from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import Any

from ..schema import ProviderMetrics
from . import claude, codex, grok

ProviderFn = Callable[..., ProviderMetrics]

BUILTIN_PROVIDERS: dict[str, ProviderFn] = {
    "claude": claude.collect,
    "grok": grok.collect,
    "codex": codex.collect,
}

_PKG_DIR = Path(__file__).resolve().parent
_REPO = _PKG_DIR.parents[3]


def registry_path() -> Path:
    env = os.environ.get("WEZDECK_PLUGIN_REGISTRY")
    return Path(env) if env else _REPO / "wezterm-x/plugins/registry.generated.json"


def _load_collect(path: Path) -> ProviderFn:
    path = path.resolve()
    if path.parent == _PKG_DIR:
        return importlib.import_module(f"{__name__}.{path.stem}").collect
    spec = importlib.util.spec_from_file_location(f"habit_report_plugin_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load habit provider {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.collect


def load_providers(reg: Path | None = None) -> dict[str, ProviderFn]:
    reg = reg or registry_path()
    try:
        plugins = json.loads(reg.read_text(encoding="utf-8")).get("plugins", [])
    except (OSError, ValueError):
        return dict(BUILTIN_PROVIDERS)
    agents = [p for p in plugins if "habit_provider" in p.get("agent_files", {})]
    if not agents:
        return dict(BUILTIN_PROVIDERS)
    out: dict[str, ProviderFn] = {}
    for p in agents:
        if p.get("enabled"):
            f = Path(p["agent_files"]["habit_provider"])
            out[f.stem] = _load_collect(f)
    return out


PROVIDERS: dict[str, ProviderFn] = load_providers()


def available_providers() -> list[str]:
    return sorted(PROVIDERS)


def run_providers(
    names: list[str],
    *,
    start: date,
    end: date,
    roots: dict[str, Path | None],
) -> list[ProviderMetrics]:
    out: list[ProviderMetrics] = []
    for name in names:
        fn = PROVIDERS.get(name)
        if fn is None:
            m = ProviderMetrics(provider=name)
            m.errors.append(f"unknown provider: {name}")
            out.append(m)
            continue
        root = roots.get(name)
        out.append(fn(start=start, end=end, root=root))
    return out
