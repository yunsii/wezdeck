"""Compact ticket reference for agents (the web console's 复制引用 on a ticket).

Mirrors the session reference (`native/wezdeck-wsl/remote_reference.go`): 5–6
lines of core metadata (title, id/kind, route/status, data dir, active worktree
or integration branch, and the `ticket api show` command) so agents can act
immediately without flooding conversation context.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def _short(p: Any) -> str:
    s = str(p or "")
    home = os.path.expanduser("~")
    if home and home != "/" and s.startswith(home + "/"):
        return "~" + s[len(home):]
    return s


def _join(*parts: Any) -> str:
    return " · ".join(str(p) for p in parts if p not in (None, "", [], {}))


def build(
    tid: str,
    data_dir: Path,
    meta: dict[str, Any],
    mj: dict[str, Any],
    ticket: dict[str, Any],
    recs: list[dict[str, Any]],
    launches: dict[str, dict[str, Any]],
    children: list[dict[str, Any]],
) -> str:
    del meta, recs, launches
    kind = ticket.get("kind") or "ticket"
    lines = [
        f"[wezdeck 工单] {ticket.get('title') or tid}",
        "id: "
        + _join(
            tid,
            f"类型 {kind}",
            f"父单 {ticket['parent']}" if ticket.get("parent") else None,
            f"子单 {len(children)} 个" if children else None,
        ),
        "路由: "
        + _join(
            f"{ticket.get('from') or '?'} → {', '.join(ticket.get('repos') or []) or ticket.get('to') or '?'}",
            f"状态 {ticket.get('status')}"
            + (f"（phase {ticket['phase']}）" if ticket.get("phase") else ""),
        ),
        f"目录: {_short(data_dir)}/",
    ]
    if ticket.get("worktree"):
        lines.append(
            f"工作树: {_short(ticket['worktree'])}"
            + (f"（分支 {ticket['branch']}）" if ticket.get("branch") else "")
        )
    elif ticket.get("branch"):
        lines.append(f"分支: {ticket['branch']}")
    for name, integ in (mj.get("integration") or {}).items():
        if isinstance(integ, dict) and (integ.get("branch") or integ.get("worktree")):
            lines.append(
                f"集成 {name}: "
                + _join(
                    integ.get("branch"),
                    _short(integ.get("worktree")),
                    "冲突" if integ.get("conflict") else None,
                )
            )
    lines.append(f"查看: ticket api show --id {tid}")
    return "\n".join(lines)
