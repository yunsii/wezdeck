"""Unified metrics schema emitted by every provider plugin."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ProviderMetrics:
    """Cross-provider habit signals.

    skills: Skill tool / SKILL.md loads (name → count)
    mcp:    MCP server or mcp__server__tool ids
    cli:    high-level CLIs (coco-cli, lark-cli, uxc, chrome-devtools, …)
    tools:  native agent tools (Bash, read_file, exec_command, …)
    """

    provider: str
    sessions_scanned: int = 0
    files_scanned: int = 0
    skills: Counter[str] = field(default_factory=Counter)
    mcp: Counter[str] = field(default_factory=Counter)
    cli: Counter[str] = field(default_factory=Counter)
    tools: Counter[str] = field(default_factory=Counter)
    verify: Counter[str] = field(default_factory=Counter)
    # verify keys: cdp_sessions, cdp_calls, iterate_after_cdp
    notes: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "sessions_scanned": self.sessions_scanned,
            "files_scanned": self.files_scanned,
            "skills": dict(self.skills.most_common()),
            "mcp": dict(self.mcp.most_common()),
            "cli": dict(self.cli.most_common()),
            "tools": dict(self.tools.most_common()),
            "verify": dict(self.verify),
            "notes": list(self.notes),
            "errors": list(self.errors),
        }


def empty_metrics(provider: str) -> ProviderMetrics:
    return ProviderMetrics(provider=provider)


def merge_metrics(rows: list[ProviderMetrics]) -> dict[str, Any]:
    skills: Counter[str] = Counter()
    mcp: Counter[str] = Counter()
    cli: Counter[str] = Counter()
    tools: Counter[str] = Counter()
    verify: Counter[str] = Counter()
    by_provider: dict[str, Any] = {}
    for row in rows:
        by_provider[row.provider] = row.to_dict()
        skills.update(row.skills)
        mcp.update(row.mcp)
        cli.update(row.cli)
        tools.update(row.tools)
        verify.update(row.verify)
    return {
        "by_provider": by_provider,
        "skills": dict(skills.most_common()),
        "mcp": dict(mcp.most_common()),
        "cli": dict(cli.most_common()),
        "tools": dict(tools.most_common()),
        "verify": dict(verify),
    }
