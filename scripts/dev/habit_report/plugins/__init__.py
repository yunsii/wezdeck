"""Optional habit collectors (auto-detect + explicit override).

Agent providers (claude/grok/codex) stay under ``providers/``.
Side signals that may be absent on a machine — Rime commit counts,
future IME backends, etc. — register here.

Each plugin module exposes:
  - ``NAME: str``
  - ``detect() -> bool`` — True if this machine looks configured
  - ``collect(*, start, end) -> dict`` — JSON-serializable section payload
"""

from __future__ import annotations

from datetime import date
from typing import Any, Protocol

from . import git_churn, rime


class OptionalPlugin(Protocol):
    NAME: str

    def detect(self) -> bool: ...

    def collect(self, *, start: date, end: date) -> dict[str, Any]: ...


PLUGINS: dict[str, Any] = {
    rime.NAME: rime,
    git_churn.NAME: git_churn,
}


def available_plugins() -> list[str]:
    return sorted(PLUGINS)


def detect_enabled(names: list[str] | None = None) -> list[str]:
    """Return plugin names that should run (detected on this machine)."""
    wanted = names if names is not None else list(PLUGINS)
    out: list[str] = []
    for name in wanted:
        mod = PLUGINS.get(name)
        if mod is None:
            continue
        try:
            if mod.detect():
                out.append(name)
        except OSError:
            continue
    return out


def run_plugins(
    *,
    start: date,
    end: date,
    names: list[str] | None = None,
    mode: str = "auto",
) -> dict[str, Any]:
    """Run optional plugins.

    mode:
      - ``auto``: only plugins that ``detect()``
      - ``all``: every registered plugin (still records errors in payload)
      - ``off``: nothing
      - comma list handled by caller via ``names``
    """
    if mode == "off":
        return {}
    if mode == "auto":
        to_run = detect_enabled(names)
    elif mode == "all":
        to_run = list(names) if names is not None else list(PLUGINS)
    else:
        to_run = list(names) if names is not None else detect_enabled()

    out: dict[str, Any] = {}
    for name in to_run:
        mod = PLUGINS.get(name)
        if mod is None:
            out[name] = {"ok": False, "error": f"unknown plugin: {name}"}
            continue
        try:
            payload = mod.collect(start=start, end=end)
            if isinstance(payload, dict):
                payload.setdefault("plugin", name)
                payload.setdefault("detected", True)
            out[name] = payload
        except Exception as exc:  # noqa: BLE001 — isolate optional collectors
            out[name] = {
                "plugin": name,
                "ok": False,
                "detected": True,
                "error": str(exc),
            }
    return out
