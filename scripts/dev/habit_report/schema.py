"""Unified metrics schema emitted by every provider plugin."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from .session import empty_session_acc, merge_session_summaries, summarize_session
from .usage import empty_usage_acc, merge_usage_summaries, summarize_usage


@dataclass
class ProviderMetrics:
    """Cross-provider habit signals.

    skills: Skill tool / SKILL.md loads / user slash·forked invokes (name → count)
    mcp:    MCP server or mcp__server__tool ids
    cli:    high-level CLIs (coco-cli, lark-cli, uxc, chrome-devtools, …)
    tools:  native agent tools (Bash, read_file, exec_command, …)
    session: accumulator for turns / active time / feed / media / goal / rewrites
    usage:  token / cost totals from each agent’s native usage records
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
    session: dict[str, Any] = field(default_factory=empty_session_acc)
    usage: dict[str, Any] = field(default_factory=empty_usage_acc)
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
            "session": summarize_session(self.session),
            "usage": summarize_usage(self.usage),
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
    session_rows: list[dict[str, Any]] = []
    usage_rows: list[dict[str, Any]] = []
    for row in rows:
        as_dict = row.to_dict()
        by_provider[row.provider] = as_dict
        skills.update(row.skills)
        mcp.update(row.mcp)
        cli.update(row.cli)
        tools.update(row.tools)
        verify.update(row.verify)
        session_rows.append(as_dict.get("session") or {})
        usage_rows.append(as_dict.get("usage") or {})
    return {
        "by_provider": by_provider,
        "skills": dict(skills.most_common()),
        "mcp": dict(mcp.most_common()),
        "cli": dict(cli.most_common()),
        "tools": dict(tools.most_common()),
        "verify": dict(verify),
        "session": merge_session_summaries(session_rows),
        "usage": merge_usage_summaries(usage_rows),
    }
