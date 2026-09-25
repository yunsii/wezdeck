"""Optional plugin: Rime/Weasel commit-char × host.foreground."""

from __future__ import annotations

from datetime import date
from typing import Any

from ..rime_commits import collect_rime_commits, resolve_default_paths, rime_user_dirs

NAME = "rime"


def _lua_installed() -> bool:
    for rime_user in rime_user_dirs():
        p = rime_user / "lua/wezdeck_commit_counter.lua"
        if p.is_file():
            return True
    return False


def detect() -> bool:
    """Enable when counter is installed or a commit log file already exists."""
    commit_log, _helper = resolve_default_paths()
    if commit_log is not None and commit_log.is_file():
        return True
    return _lua_installed()


def collect(*, start: date, end: date) -> dict[str, Any]:
    commit_log, helper_log = resolve_default_paths()
    payload = collect_rime_commits(
        start=start,
        end=end,
        commit_log=commit_log,
        helper_log=helper_log,
    )
    payload["ok"] = True
    payload["enabled"] = True
    return payload
