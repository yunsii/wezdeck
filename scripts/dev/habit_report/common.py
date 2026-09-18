"""Shared parsing helpers for provider plugins."""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

# Match CLI invocations at statement starts (avoid path-segment false positives
# like .../coco-platform/... inside cd/workdir).
_CLI_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?:^|[;&|`\n])\s*(?:sudo\s+)?coco-cli\b"), "coco-cli"),
    (re.compile(r"(?:^|[;&|`\n])\s*(?:sudo\s+)?lark-cli\b"), "lark-cli"),
    (re.compile(r"(?:^|[;&|`\n])\s*(?:sudo\s+)?wd-run\b"), "human-run"),
    (re.compile(r"(?:^|[;&|`\n])\s*(?:sudo\s+)?gh\b"), "gh"),
    (re.compile(r"(?:^|[;&|`\n])\s*uxc\b"), "uxc"),
    (
        re.compile(
            r"\bchrome-devtools-mcp(?:-cli)?\b|\bchrome-devtools-mcp-skill\b|"
            r"(?:^|[;&|`\n])\s*npx\s+(?:-y\s+)?chrome-devtools-mcp\b"
        ),
        "chrome-devtools",
    ),
]

# Match SKILL.md under agent skill roots (incl. Codex `.system/`), platform
# `scripts/dev/<skill>/`, generic `skills/<skill>/`, or trailing `/<skill>/SKILL.md`.
_SKILL_PATH_RE = re.compile(
    r"(?:^|/)(?:\.agents|\.claude|\.grok|\.codex)/skills/(?:\.system/)?"
    r"([A-Za-z0-9_-]+)/SKILL\.md\b|"
    r"(?:^|/)(?:skills|scripts/dev)/([A-Za-z0-9_-]+)/SKILL\.md\b|"
    r"(?:^|/)([A-Za-z0-9_-]+)/SKILL\.md\b"
)
_MCP_TOOL_RE = re.compile(r"^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)$")

# Leading `/name` in a user prompt (slash command / user-invocable skill).
_SLASH_PROMPT_RE = re.compile(r"^\s*/([A-Za-z][A-Za-z0-9_:-]{0,64})\b")
# Claude Code embeds slash invokes as <command-name>/foo</command-name>.
_CLAUDE_COMMAND_NAME_RE = re.compile(
    r"<command-name>\s*/?([A-Za-z][A-Za-z0-9_:-]{0,64})\s*</command-name>",
    re.IGNORECASE,
)
_CLAUDE_FORKED_SKILL_RE = re.compile(
    r"<forked-skill-launch>\s*(\{.*?\})\s*</forked-skill-launch>",
    re.DOTALL,
)

# Session chrome / pager builtins — not habit "tools". Keep skill-like
# user invokes (goal, code-review, coco-*, human-run, …) out of this set.
_SLASH_CHROME = frozenset(
    {
        "agents-dashboard",
        "bug",
        "btw",
        "clear",
        "compact",
        "config",
        "context",
        "copy",
        "cost",
        "dashboard",
        "doctor",
        "effort",
        "exit",
        "export",
        "fork",
        "help",
        "home",
        "info",
        "init",
        "issue",
        "keybindings",
        "login",
        "logout",
        "mcp",
        "memory",
        "migrate",
        "model",
        "new",
        "permissions",
        "plugin",
        "plugins",
        "quit",
        "reload",
        "resume",
        "rewind",
        "session-info",
        "sessions",
        "settings",
        "status",
        "theme",
        "todos",
        "undo",
        "vim",
        "vim-mode",
        "welcome",
    }
)


def parse_iso_ts(ts: str | None) -> datetime | None:
    if not ts or not isinstance(ts, str):
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def parse_local_ts(ts: str | None) -> datetime | None:
    if not ts:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(ts, fmt)
        except ValueError:
            continue
    return None


def day_bounds_utc(start: date, end: date) -> tuple[datetime, datetime]:
    start_dt = datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
    end_dt = datetime(end.year, end.month, end.day, tzinfo=timezone.utc) + timedelta(
        days=1
    )
    return start_dt, end_dt


def in_window(ts: datetime | None, start: datetime, end: datetime) -> bool:
    return ts is not None and start <= ts < end


def classify_command(cmd: str) -> list[str]:
    """Return zero or more CLI labels for a shell command string."""
    if not cmd:
        return []
    hits: list[str] = []
    seen: set[str] = set()
    for pat, label in _CLI_RULES:
        if pat.search(cmd) and label not in seen:
            hits.append(label)
            seen.add(label)
    return hits


def skill_from_path(path: str) -> str | None:
    if not path:
        return None
    m = _SKILL_PATH_RE.search(path.replace("\\", "/"))
    if not m:
        return None
    return m.group(1) or m.group(2) or m.group(3)


def slash_command_name(text: str) -> str | None:
    """Return slash command stem from a leading `/name …` prompt, or None."""
    if not text:
        return None
    m = _SLASH_PROMPT_RE.match(text)
    if not m:
        return None
    name = m.group(1).strip().lstrip("/").lower()
    # Drop plugin-qualified prefix noise: keep `login` from `plugin:login`
    # only when counting; prefer full token for skill ids with hyphens.
    if not name or name in _SLASH_CHROME:
        return None
    # Path-like false positives: /home/yuns, /mnt/c, /api/v1
    if "/" in name or name in {"home", "mnt", "api", "usr", "var", "tmp", "opt"}:
        return None
    return name


def iter_claude_command_names(text: str) -> list[str]:
    """Yield user-invoked command names from Claude <command-name> blocks."""
    if not text:
        return []
    out: list[str] = []
    for m in _CLAUDE_COMMAND_NAME_RE.finditer(text):
        name = m.group(1).strip().lstrip("/").lower()
        if name and name not in _SLASH_CHROME:
            out.append(name)
    return out


def iter_claude_forked_skills(text: str) -> list[str]:
    """Yield skillName values from Claude <forked-skill-launch> payloads."""
    if not text:
        return []
    out: list[str] = []
    for m in _CLAUDE_FORKED_SKILL_RE.finditer(text):
        try:
            payload = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        name = str(payload.get("skillName") or payload.get("skill") or "").strip()
        name = name.lstrip("/").lower()
        if name and name not in _SLASH_CHROME:
            out.append(name)
    return out


def classify_mcp_tool(name: str) -> tuple[str, str] | None:
    m = _MCP_TOOL_RE.match(name or "")
    if not m:
        return None
    return m.group(1), f"mcp__{m.group(1)}__{m.group(2)}"


def iter_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(row, dict):
                    yield row
    except OSError:
        return


def mtime_in_window(path: Path, start: datetime, end: datetime) -> bool:
    try:
        mt = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    except OSError:
        return False
    # Keep files touched in-window or slightly before (session may span days).
    return mt >= (start - timedelta(days=1)) and mt < (end + timedelta(days=1))
