"""Provider plugin registry."""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import Any

from ..schema import ProviderMetrics
from . import claude, codex, grok

ProviderFn = Callable[..., ProviderMetrics]

PROVIDERS: dict[str, ProviderFn] = {
    "claude": claude.collect,
    "grok": grok.collect,
    "codex": codex.collect,
}


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
