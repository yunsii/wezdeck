#!/usr/bin/env python3
"""Deterministic host-watch notify presentation adapter.

Architecture:
  capture → kind-family extractor (registry) → NotifyCard JSON
          → channel renderer (feishu_md | poke_text | plain)

Shared: ANSI/box cleaning, NotifyCard schema, Feishu/poke render.
Per-kind: need_human / turn_idle parse heuristics (claude | codex | grok | generic).

No LLM. Extend by registering another Extractor on KIND_EXTRACTORS.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from typing import Any, Protocol

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
RULE_RE = re.compile(
    r"^[─═\-━_┄┅┈┉╴╶╸╺╼╾]{4,}\s*$"
    r"|^[┌┐└┘╭╮╰╯├┤┬┴┼╔╗╚╝║═╠╣╦╩╬│┃┆┇┊┋][─═\-━_┄┅┈┉│┃┆┇┊┋┌┐└┘╭╮╰╯├┤┬┴┼╔╗╚╝║╠╣╦╩╬\s]*$"
)
BOX_CHAR_RE = re.compile(r"[┌┐└┘╭╮╰╯├┤┬┴┼╔╗╚╝║═╠╣╦╩╬│┃┆┇┊┋─━┄┅┈┉╴╶╸╺╼╾]")
OPT_RE = re.compile(r"^(?:❯\s*|>\s*|▶\s*|•\s*)?(\d+)[.)]\s+(.*)$")
TITLE_RE = re.compile(r"^[☐✔□✓]\s*(.+)$")
PERM_TITLE_RE = re.compile(
    r"(?i)^(do you want|allow |approve |permit |run this|execute |proceed\??|"
    r"permission|bash command|apply patch|edit file)"
)
FOOTER_HINTS = (
    "enter to select",
    "esc to cancel",
    "to navigate",
    "tab to amend",
    "press enter",
    "press y",
    "(y/n)",
    "[y/n]",
    "[y/N]",
    "[Y/n]",
)
MAX_SUMMARY_LINES = 8
MAX_DETAIL_CHARS = 200
MAX_FALLBACK_LINES = 12

# job.kind / pane kind → extractor family
KIND_FAMILY: dict[str, str] = {
    "claude-tui": "claude",
    "claude": "claude",
    "opencode": "claude",
    "opencode-tui": "claude",
    "codex-tui": "codex",
    "codex": "codex",
    "grok-tui": "grok",
    "grok": "grok",
}


def kind_family(kind: str) -> str:
    k = (kind or "").strip().lower()
    if k in KIND_FAMILY:
        return KIND_FAMILY[k]
    if "claude" in k:
        return "claude"
    if "codex" in k:
        return "codex"
    if "grok" in k:
        return "grok"
    return "generic"


def _strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


def clean_lines(text: str) -> list[str]:
    text = _strip_ansi(text.replace("\r", ""))
    lines = [ln.rstrip() for ln in text.splitlines()]
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def is_rule(s: str) -> bool:
    t = s.strip()
    if not t:
        return False
    if RULE_RE.match(t):
        return True
    boxed = BOX_CHAR_RE.findall(t)
    if len(boxed) >= 4 and len(boxed) / max(len(t.replace(" ", "")), 1) >= 0.6:
        return True
    return False


def is_footer(s: str) -> bool:
    low = s.lower()
    return any(h in low for h in FOOTER_HINTS)


def strip_box_glyphs(s: str) -> str:
    return BOX_CHAR_RE.sub("", s).strip()


def fallback_summary(lines: list[str], limit: int = MAX_FALLBACK_LINES) -> list[str]:
    out: list[str] = []
    for ln in lines:
        s = strip_box_glyphs(ln.strip())
        if not s or is_rule(ln):
            continue
        out.append(s)
        if len(out) >= limit:
            break
    return out


@dataclass
class ParsedPrompt:
    title: str = ""
    question: str = ""
    options: list[dict[str, Any]] = field(default_factory=list)
    hint: str = ""
    summary_lines: list[str] = field(default_factory=list)


class Extractor(Protocol):
    name: str

    def need_human(self, lines: list[str]) -> ParsedPrompt: ...

    def turn_idle(self, lines: list[str]) -> list[str]: ...


def _slice_prompt_block(lines: list[str]) -> list[str]:
    if not lines:
        return []
    footer_i = None
    for i in range(len(lines) - 1, -1, -1):
        if is_footer(lines[i]):
            footer_i = i
            break
    end = (footer_i + 1) if footer_i is not None else len(lines)

    rules = [i for i, ln in enumerate(lines[:end]) if is_rule(ln)]
    start = 0
    if len(rules) >= 2:
        start = rules[-2]
    elif rules:
        start = max(0, rules[0] - 4)
    else:
        start = max(0, end - 24)
        for i, ln in enumerate(lines[:end]):
            s = ln.strip()
            if OPT_RE.match(s) or TITLE_RE.match(s) or PERM_TITLE_RE.match(s):
                start = i
                break
    return lines[start:end]


def _parse_choice_block(chunk: list[str]) -> ParsedPrompt:
    title = ""
    question_parts: list[str] = []
    opts: list[dict[str, Any]] = []
    footer = ""
    cur: dict[str, Any] | None = None

    def flush() -> None:
        nonlocal cur
        if cur is not None:
            opts.append(cur)
            cur = None

    for ln in chunk:
        s = ln.strip()
        if not s or is_rule(s):
            continue
        if is_footer(s):
            footer = s
            continue
        m_title = TITLE_RE.match(s)
        if m_title and not opts:
            title = m_title.group(1).strip()
            continue
        m_opt = OPT_RE.match(s)
        if m_opt:
            flush()
            selected = ("❯" in ln) or ("▶" in ln) or ln.lstrip().startswith(">")
            cur = {
                "n": m_opt.group(1),
                "label": m_opt.group(2).strip(),
                "detail": "",
                "selected": selected,
                "_body": [],
            }
            continue
        if cur is not None and not OPT_RE.match(s):
            cur["_body"].append(s)
            continue
        if not opts and cur is None:
            question_parts.append(s)
            continue
        if cur is not None:
            cur["_body"].append(s)

    flush()
    for o in opts:
        detail = " ".join(o.pop("_body", [])).strip()
        detail = re.sub(r"\s+", " ", detail)
        if len(detail) > MAX_DETAIL_CHARS:
            detail = detail[: MAX_DETAIL_CHARS - 3] + "..."
        o["detail"] = detail

    question = re.sub(r"\s+", " ", " ".join(question_parts).strip())
    return ParsedPrompt(title=title, question=question, options=opts, hint=footer)


def _idle_summary(lines: list[str], noise_re: re.Pattern[str]) -> list[str]:
    useful: list[str] = []
    for ln in lines:
        s = strip_box_glyphs(ln.strip())
        if not s or is_rule(ln):
            continue
        if s in {"❯", ">", "▶"} or re.fullmatch(r"[❯>▶]\s*", s):
            continue
        if noise_re.search(s) and len(s) < 100:
            continue
        useful.append(s)
    if not useful:
        return fallback_summary(lines, MAX_SUMMARY_LINES)
    return useful[-MAX_SUMMARY_LINES:]


class GenericExtractor:
    name = "generic"
    idle_noise = re.compile(
        r"(?i)^(ctx:\d|esc to interrupt|ctrl\+|tokens?|timeout|\(ctrl|\(shift|…|\.\.\.)"
    )

    def need_human(self, lines: list[str]) -> ParsedPrompt:
        chunk = _slice_prompt_block(lines)
        parsed = _parse_choice_block(chunk)
        if parsed.options or parsed.question or parsed.title:
            return parsed
        # Permission-ish prose without numbered opts
        summary = fallback_summary(chunk or lines[-20:])
        title = ""
        for s in summary:
            if PERM_TITLE_RE.match(s):
                title = s
                break
        return ParsedPrompt(title=title, summary_lines=summary)

    def turn_idle(self, lines: list[str]) -> list[str]:
        return _idle_summary(lines, self.idle_noise)


class ClaudeExtractor(GenericExtractor):
    """Claude Code: ☐ titles, ❯ numbered AskUserQuestion, empty ❯ idle."""

    name = "claude"
    idle_noise = re.compile(
        r"(?i)^(opuss?\b|sonnet\b|haiku\b|ctx:\d|⏵|auto mode|esc to interrupt|ctrl\+|"
        r"waddling|brewed for|tokens?|timeout|\(ctrl|\(shift|thinking|…|\.\.\.)"
    )


class CodexExtractor(GenericExtractor):
    """Codex TUI: approval / command prompts; numbered or y/N footers."""

    name = "codex"
    idle_noise = re.compile(
        r"(?i)^(gpt-|o[0-9]|codex\b|ctx:\d|esc to interrupt|ctrl\+|tokens?|"
        r"timeout|\(ctrl|thinking|…|\.\.\.|model:)"
    )

    def need_human(self, lines: list[str]) -> ParsedPrompt:
        parsed = super().need_human(lines)
        if parsed.options or parsed.title or parsed.question:
            return parsed
        # Codex often ends with Allow/Run + y/N without a checkbox title.
        chunk = _slice_prompt_block(lines)
        summary = fallback_summary(chunk or lines[-20:])
        title = ""
        question_parts: list[str] = []
        for s in summary:
            if not title and PERM_TITLE_RE.match(s):
                title = s
                continue
            if is_footer(s):
                parsed.hint = s
                continue
            question_parts.append(s)
        return ParsedPrompt(
            title=title,
            question=re.sub(r"\s+", " ", " ".join(question_parts).strip()),
            hint=parsed.hint,
            summary_lines=summary if not (title or question_parts) else [],
        )


class GrokExtractor(GenericExtractor):
    """Grok Build fullscreen TUI: prefer short prose summary; choice UI if present."""

    name = "grok"
    idle_noise = re.compile(
        r"(?i)^(grok\b|ctx:\d|esc to interrupt|ctrl\+|tokens?|timeout|\(ctrl|"
        r"thinking|…|\.\.\.|scroll_|focus)"
    )


KIND_EXTRACTORS: dict[str, Extractor] = {
    "claude": ClaudeExtractor(),
    "codex": CodexExtractor(),
    "grok": GrokExtractor(),
    "generic": GenericExtractor(),
}


def get_extractor(kind: str) -> Extractor:
    return KIND_EXTRACTORS.get(kind_family(kind), KIND_EXTRACTORS["generic"])


def extract_card(
    text: str,
    *,
    event: str,
    target: str,
    kind: str,
    note: str = "",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    extra = extra or {}
    lines = clean_lines(text) if text else []
    family = kind_family(kind)
    ext = get_extractor(kind)

    card: dict[str, Any] = {
        "event": event,
        "target": target,
        "kind": kind,
        "kind_family": family,
        "note": note,
        "headline": "",
        "title": "",
        "question": "",
        "options": [],
        "hint": "",
        "summary_lines": [],
        "reason": extra.get("reason", ""),
        "action": "回对应 tmux pane 处理（本通知不代按键）",
        "meta": {k: v for k, v in extra.items() if k != "reason"},
    }

    if event == "need_human":
        card["headline"] = "需要你决策"
        parsed = ext.need_human(lines)
        card["title"] = parsed.title
        card["question"] = parsed.question
        card["options"] = parsed.options
        card["hint"] = parsed.hint
        card["summary_lines"] = parsed.summary_lines
        # Prefer attention.json structured fields over raw pane-tail dump.
        structured: list[str] = []
        lup = str(extra.get("last_user_prompt") or "").strip()
        wk = str(extra.get("waiting_kind") or "").strip()
        ag = str(extra.get("agent_name") or "").strip()
        if lup:
            structured.append(f"最近用户意图: {lup}")
        if wk:
            structured.append(f"等待类型: {wk}")
        if ag:
            structured.append(f"agent: {ag}")
        reason = str(extra.get("reason") or "").strip()
        if reason and reason not in (parsed.question, parsed.title):
            # reason already on card.reason; also seed summary when parse is thin
            if not (parsed.options or parsed.question or parsed.title):
                structured.insert(0, reason)
        if structured and not (parsed.options or parsed.question or parsed.title):
            card["summary_lines"] = structured + list(card["summary_lines"] or [])
        elif structured and not card["summary_lines"]:
            card["summary_lines"] = structured
        if not (parsed.options or parsed.question or parsed.title or card["summary_lines"]):
            # Last resort: cleaned capture tail — still better than rule walls.
            card["summary_lines"] = fallback_summary(lines[-20:])
        card["action"] = "回对应 tmux pane 选择/确认（本通知不代按键）"
        return card

    if event == "turn_idle":
        card["headline"] = "回合空闲"
        card["summary_lines"] = ext.turn_idle(lines)
        lup = str(extra.get("last_user_prompt") or "").strip()
        if lup and not card["summary_lines"]:
            card["summary_lines"] = [f"最近用户意图: {lup}"]
        card["action"] = "回对应 tmux pane 继续或收工"
        card["meta"]["job"] = "继续盯梢（未结束）"
        return card

    if event == "take":
        card["headline"] = "已接管盯梢"
        card["action"] = "默认只在「需要你决策」时推飞书；不代按 TUI"
        return card

    if event == "ended":
        card["headline"] = "盯梢结束"
        card["action"] = ""
        return card

    card["headline"] = event
    card["summary_lines"] = fallback_summary(lines)
    return card


def card_from_fields(
    *,
    event: str,
    target: str,
    kind: str,
    note: str = "",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return extract_card("", event=event, target=target, kind=kind, note=note, extra=extra)


def render_plain(card: dict[str, Any]) -> str:
    event = card.get("event", "")
    parts: list[str] = []
    icon = {
        "need_human": "🔔",
        "turn_idle": "⏸",
        "take": "👁",
        "ended": "✅",
    }.get(event, "•")
    headline = card.get("headline") or event
    parts.append(f"{icon} {headline}")
    parts.append("")
    parts.append(f"会话: `{card.get('target', '?')}`")
    parts.append(f"类型: {card.get('kind', '?')}")
    if card.get("kind_family") and card.get("kind_family") != kind_family(str(card.get("kind", ""))):
        parts.append(f"解析: {card['kind_family']}")
    if card.get("note"):
        parts.append(f"备注: {card['note']}")
    if card.get("reason"):
        parts.append(f"原因: {card['reason']}")
    for k, v in (card.get("meta") or {}).items():
        if v is None or v == "":
            continue
        parts.append(f"{k}: {v}")
    parts.append("")

    if card.get("title"):
        parts.append(f"【{card['title']}】")
    if card.get("question"):
        parts.append(card["question"])
        parts.append("")

    opts = card.get("options") or []
    if opts:
        parts.append("选项:")
        for o in opts:
            mark = "▶" if o.get("selected") else "▸"
            parts.append(f"{mark} {o.get('n', '?')}. {o.get('label', '')}")
            if o.get("detail"):
                parts.append(f"    {o['detail']}")
        parts.append("")

    summary = card.get("summary_lines") or []
    if summary and not opts:
        parts.append("摘要:")
        parts.extend(summary)
        parts.append("")

    if card.get("hint"):
        parts.append(f"操作提示: {card['hint']}")
    if card.get("action"):
        parts.append(f"→ {card['action']}")
    return "\n".join(parts).rstrip() + "\n"


def render_feishu_md(card: dict[str, Any]) -> str:
    event = card.get("event", "")
    icon = {
        "need_human": "🔔",
        "turn_idle": "⏸",
        "take": "👁",
        "ended": "✅",
    }.get(event, "•")
    headline = card.get("headline") or event
    lines: list[str] = [f"## {icon} {headline}", ""]
    lines.append(f"- **会话:** `{card.get('target', '?')}`")
    lines.append(f"- **类型:** {card.get('kind', '?')}")
    if card.get("note"):
        lines.append(f"- **备注:** {card['note']}")
    if card.get("reason"):
        lines.append(f"- **原因:** {card['reason']}")
    meta = card.get("meta") or {}
    for k in ("waiting_kind", "last_user_prompt", "agent_name", "git_branch"):
        v = meta.get(k)
        if v is None or v == "":
            continue
        label = {
            "waiting_kind": "等待类型",
            "last_user_prompt": "最近用户意图",
            "agent_name": "agent",
            "git_branch": "分支",
        }.get(k, k)
        lines.append(f"- **{label}:** {v}")
    for k, v in meta.items():
        if k in ("waiting_kind", "last_user_prompt", "agent_name", "git_branch"):
            continue
        if v is None or v == "":
            continue
        lines.append(f"- **{k}:** {v}")
    lines.append("")

    if card.get("title"):
        lines.append(f"### {card['title']}")
        lines.append("")
    if card.get("question"):
        lines.append(card["question"])
        lines.append("")

    opts = card.get("options") or []
    if opts:
        lines.append("**选项**")
        lines.append("")
        for o in opts:
            label = o.get("label", "")
            n = o.get("n", "?")
            if o.get("selected"):
                lines.append(f"{n}. **{label}** ← 当前")
            else:
                lines.append(f"{n}. {label}")
            if o.get("detail"):
                lines.append(f"   - {o['detail']}")
        lines.append("")

    summary = card.get("summary_lines") or []
    if summary and not opts:
        lines.append("**摘要**")
        lines.append("")
        for s in summary:
            lines.append(f"- {s}")
        lines.append("")

    if card.get("hint"):
        lines.append(f"> {card['hint']}")
        lines.append("")
    if card.get("action"):
        lines.append(f"→ {card['action']}")
    text = "\n".join(lines).rstrip() + "\n"
    # Never ship raw rule walls into Feishu markdown.
    if re.search(r"[─━═]{6,}", text):
        text = re.sub(r"[─━═]{4,}", "", text)
    return text


def render_poke_frame(card: dict[str, Any]) -> str:
    event = card.get("event", "")
    body_lines: list[str] = [
        f"会话: {card.get('target', '?')}",
        f"类型: {card.get('kind', '?')} ({card.get('kind_family', kind_family(str(card.get('kind', ''))))})",
    ]
    if card.get("note"):
        body_lines.append(f"备注: {card['note']}")
    if card.get("reason"):
        body_lines.append(f"原因: {card['reason']}")
    if card.get("title"):
        body_lines.append(f"题目: {card['title']}")
    if card.get("question"):
        q = card["question"]
        if len(q) > 160:
            q = q[:157] + "..."
        body_lines.append(f"问: {q}")
    opts = card.get("options") or []
    if opts:
        labels = []
        for o in opts[:6]:
            mark = "*" if o.get("selected") else ""
            labels.append(f"{o.get('n', '?')}{mark}.{o.get('label', '')}")
        body_lines.append("选项: " + " | ".join(labels))
    summary = card.get("summary_lines") or []
    if summary and not opts:
        for s in summary[:4]:
            if len(s) > 120:
                s = s[:117] + "..."
            body_lines.append(f"- {s}")
    if card.get("action"):
        body_lines.append(f"→ {card['action']}")
    body = "\n".join(body_lines)

    frames = {
        "take": (
            "【host-watch · take】",
            "主人用 Ctrl+K w 把本机 tmux agent pane 交给盯梢。",
            "默认不推飞书 ack；只有 need_human（要主人决策）才 bot DM 主人。",
            "不要代按 TUI；不要把后文选项当成飞书菜单。",
        ),
        "need_human": (
            "【host-watch · need_human】",
            "本机 host 会话需要主人回 tmux 决策（权限/选择题等）。",
            "下面优先来自 attention 结构化字段 + TUI 解析——不是飞书 1/2/3 菜单，请勿代选。",
            "除非主人明确授权 lease/host-send-keys，不要代按键。",
        ),
        "turn_idle": (
            "【host-watch · turn_idle】",
            "本机 agent 回合停在空闲 prompt（默认不推飞书；本条仅 poke/审计用）。",
            "盯梢继续（job 未关）；除非明确授权，不要代按 TUI。",
        ),
        "ended": (
            "【host-watch · ended】",
            "本机盯梢结束（done / pane 消失 / TTL）。",
        ),
    }
    head = frames.get(event, (f"【host-watch · {event}】",))
    if event in ("take", "need_human"):
        return "\n".join([*head[:-1], "", body, "", head[-1]]) + "\n"
    return "\n".join([*head, "", body]) + "\n"


def render(card: dict[str, Any], channel: str) -> str:
    if channel == "feishu_md":
        return render_feishu_md(card)
    if channel == "poke_text":
        return render_poke_frame(card)
    if channel == "plain":
        return render_plain(card)
    raise SystemExit(f"unknown channel: {channel}")


def _parse_extra(items: list[str] | None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for item in items or []:
        if "=" not in item:
            continue
        k, v = item.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="host-watch NotifyCard extract/render")
    sub = p.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--event", required=True)
    common.add_argument("--target", required=True)
    common.add_argument("--kind", default="unknown")
    common.add_argument("--note", default="")
    common.add_argument("--extra", action="append", default=[], help="key=value")

    pe = sub.add_parser("extract", parents=[common], help="capture stdin → NotifyCard JSON")
    pe.add_argument("--channel", choices=("feishu_md", "poke_text", "plain"), default="")

    pc = sub.add_parser("card", parents=[common], help="build card without capture")
    pc.add_argument("--channel", choices=("feishu_md", "poke_text", "plain"), default="")

    pr = sub.add_parser("render", help="NotifyCard JSON stdin → channel text")
    pr.add_argument("--channel", choices=("feishu_md", "poke_text", "plain"), required=True)

    pf = sub.add_parser("format", parents=[common], help="capture stdin → render")
    pf.add_argument(
        "--channel",
        choices=("feishu_md", "poke_text", "plain"),
        default="plain",
    )

    # Legacy: python notify_card.py TARGET KIND [NOTE]
    if argv is None and len(sys.argv) >= 2 and sys.argv[1] not in {
        "extract",
        "card",
        "render",
        "format",
        "-h",
        "--help",
    }:
        target = sys.argv[1]
        kind = sys.argv[2] if len(sys.argv) > 2 else "unknown"
        note = sys.argv[3] if len(sys.argv) > 3 else ""
        text = sys.stdin.read()
        card = extract_card(text, event="need_human", target=target, kind=kind, note=note)
        sys.stdout.write(render_plain(card))
        return 0

    args = p.parse_args(argv)
    extra = _parse_extra(getattr(args, "extra", None))

    if args.cmd == "render":
        card = json.load(sys.stdin)
        sys.stdout.write(render(card, args.channel))
        return 0

    if args.cmd == "card":
        card = card_from_fields(
            event=args.event,
            target=args.target,
            kind=args.kind,
            note=args.note,
            extra=extra,
        )
    else:
        text = sys.stdin.read()
        card = extract_card(
            text,
            event=args.event,
            target=args.target,
            kind=args.kind,
            note=args.note,
            extra=extra,
        )

    channel = getattr(args, "channel", "") or ""
    if channel:
        sys.stdout.write(render(card, channel))
    else:
        json.dump(card, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
