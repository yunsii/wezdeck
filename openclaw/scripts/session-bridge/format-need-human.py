#!/usr/bin/env python3
"""Format pane capture into a readable Feishu need_human message.

stdin: raw tmux capture-pane text
argv: target kind [note]
stdout: message body (plain text; light markdown Feishu accepts)
"""
from __future__ import annotations

import re
import sys

RULE_RE = re.compile(r"^[─═\-━_]{6,}\s*$")
OPT_RE = re.compile(r"^(?:❯\s*|>\s*)?(\d+)\.\s+(.*)$")
TITLE_RE = re.compile(r"^[☐✔□✓]\s*(.+)$")
FOOTER_HINTS = (
    "enter to select",
    "esc to cancel",
    "to navigate",
    "tab to amend",
)


def _is_footer(s: str) -> bool:
    low = s.lower()
    return any(h in low for h in FOOTER_HINTS)


def _clean_lines(text: str) -> list[str]:
    lines = [ln.rstrip() for ln in text.replace("\r", "").splitlines()]
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def _slice_prompt_block(lines: list[str]) -> list[str]:
    """Prefer the last UI box (rules / checkbox / numbered list + footer)."""
    if not lines:
        return []
    footer_i = None
    for i in range(len(lines) - 1, -1, -1):
        if _is_footer(lines[i]):
            footer_i = i
            break
    end = (footer_i + 1) if footer_i is not None else len(lines)

    rules = [i for i, ln in enumerate(lines[:end]) if RULE_RE.match(ln.strip())]
    start = 0
    if len(rules) >= 2:
        start = rules[-2]
    elif rules:
        # single rule: take some context above
        start = max(0, rules[0] - 4)
    else:
        # no box: last ~24 lines or from first numbered option
        start = max(0, end - 24)
        for i, ln in enumerate(lines[:end]):
            if OPT_RE.match(ln.strip()) or TITLE_RE.match(ln.strip()):
                start = i
                break
    return lines[start:end]


def _parse_block(chunk: list[str]) -> dict:
    title = ""
    question_parts: list[str] = []
    opts: list[dict] = []
    footer = ""
    cur: dict | None = None

    def flush() -> None:
        nonlocal cur
        if cur is not None:
            opts.append(cur)
            cur = None

    for ln in chunk:
        s = ln.strip()
        if not s or RULE_RE.match(s):
            continue
        if _is_footer(s):
            footer = s
            continue
        m_title = TITLE_RE.match(s)
        if m_title and not opts:
            title = m_title.group(1).strip()
            continue
        m_opt = OPT_RE.match(s)
        if m_opt:
            flush()
            cur = {"n": m_opt.group(1), "head": m_opt.group(2).strip(), "body": []}
            continue
        # continuation under current option (Claude indents descriptions)
        if cur is not None and not OPT_RE.match(s):
            cur["body"].append(s)
            continue
        if not opts and not cur:
            question_parts.append(s)
            continue
        if cur is not None:
            cur["body"].append(s)

    flush()
    question = " ".join(question_parts).strip()
    # collapse multi-space from wrap
    question = re.sub(r"\s+", " ", question)
    return {"title": title, "question": question, "opts": opts, "footer": footer}


def _format_permissionish(chunk: list[str], target: str, kind: str, note: str) -> str:
    """Fallback: cleaned last block, not raw dump."""
    body_lines = []
    for ln in chunk:
        s = ln.rstrip()
        if not s.strip() or RULE_RE.match(s.strip()):
            continue
        body_lines.append(s.strip())
    # de-dupe consecutive empties already handled
    body = "\n".join(body_lines[:40])
    parts = [
        "🔔 需要确认",
        "",
        f"会话: `{target}`",
        f"类型: {kind}",
    ]
    if note:
        parts.append(f"备注: {note}")
    parts += ["", body, "", "→ 回对应 tmux pane 处理"]
    return "\n".join(parts)


def format_message(text: str, target: str, kind: str, note: str = "") -> str:
    lines = _clean_lines(text)
    chunk = _slice_prompt_block(lines)
    parsed = _parse_block(chunk)

    if not parsed["opts"] and not parsed["question"] and not parsed["title"]:
        return _format_permissionish(chunk or lines[-20:], target, kind, note)

    parts: list[str] = ["🔔 需要确认", ""]
    parts.append(f"会话: `{target}`")
    parts.append(f"类型: {kind}")
    if note:
        parts.append(f"备注: {note}")
    parts.append("")

    if parsed["title"]:
        parts.append(f"【{parsed['title']}】")
    if parsed["question"]:
        parts.append(parsed["question"])
        parts.append("")

    if parsed["opts"]:
        parts.append("选项:")
        for o in parsed["opts"]:
            mark = "▸" if o["n"] else "•"
            # detect current selection from original chunk
            selected = any(
                OPT_RE.match(ln.strip())
                and OPT_RE.match(ln.strip()).group(1) == o["n"]
                and ("❯" in ln or ln.lstrip().startswith(">"))
                for ln in chunk
            )
            prefix = "▶" if selected else mark
            head = o["head"]
            parts.append(f"{prefix} {o['n']}. {head}")
            detail = " ".join(o["body"]).strip()
            detail = re.sub(r"\s+", " ", detail)
            if detail:
                if len(detail) > 200:
                    detail = detail[:197] + "..."
                parts.append(f"    {detail}")
        parts.append("")

    if parsed["footer"]:
        parts.append(f"操作提示: {parsed['footer']}")
    parts.append("→ 回对应 tmux pane 选择/确认（本通知不代按键）")
    return "\n".join(parts).rstrip() + "\n"


def main() -> int:
    target = sys.argv[1] if len(sys.argv) > 1 else "?"
    kind = sys.argv[2] if len(sys.argv) > 2 else "?"
    note = sys.argv[3] if len(sys.argv) > 3 else ""
    text = sys.stdin.read()
    sys.stdout.write(format_message(text, target, kind, note))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
