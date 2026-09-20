#!/usr/bin/env python3
"""Unwrap soft-wrapped Markdown prose for render platforms (issue / PR / comment).

Repo Markdown may keep hard wraps for line-oriented diffs. GitHub / CNB / many
chat renderers treat a single newline inside a paragraph as <br> (GFM breaks),
so outbound bodies must be paragraph-long lines.

Preserves: fenced code, tables, headings, hr, HTML blocks, list markers,
blockquote markers. Merges continuation lines within paragraphs, list items,
and blockquotes. CJK junctions join without a space; Latin word junctions
insert one space.

Usage:
  unwrap.py                 # stdin → stdout
  unwrap.py PATH...         # each file rewritten in place; prints summary
  unwrap.py --check PATH... # exit 1 if any file would change
  unwrap.py --stdout PATH   # print unwrapped form of one file
"""

from __future__ import annotations

import argparse
import re
import sys
import unicodedata
from dataclasses import dataclass, field


_FENCE_OPEN = re.compile(r"^(?P<indent> {0,3})(?P<fence>`{3,}|~{3,})(?P<info>.*)$")
_HEADING = re.compile(r"^( {0,3})#{1,6}(?:\s|$)")
_HR = re.compile(r"^( {0,3})([-*_])(?:\s*\2){2,}\s*$")
_LIST = re.compile(r"^(?P<indent> {0,3})(?P<marker>[-+*]|\d+[.)])(?P<sp>[ \t]+)(?P<body>.*)$")
_ALPHA_LIST = re.compile(r"^(?P<indent> {0,3})(?P<marker>[a-zA-Z][.)])(?P<sp>[ \t]+)(?P<body>.*)$")
_BLOCKQUOTE = re.compile(r"^(?P<indent> {0,3})>(?P<sp> ?)")
_TABLE_PIPE = re.compile(r"(?<!`)(\|(?!`)|(?<!`) \|)")
_SETTEXT_UNDER = re.compile(r"^( {0,3})(=+|-+)\s*$")
_REF_DEF = re.compile(r"^( {0,3})\[[^\]]+\]:\s+\S")
_HTML_OPEN = re.compile(r"^( {0,3})</?([A-Za-z][\w:-]*)\b")


def _is_cjk_char(ch: str) -> bool:
    if not ch:
        return False
    cat = unicodedata.category(ch)
    if cat.startswith("Lo"):
        # CJK ideographs / kana / hangul syllables live in Lo; Latin letters are Ll/Lu.
        o = ord(ch)
        return o > 0x2E7F  # above Latin Extended; covers CJK blocks we care about
    # CJK punctuation / fullwidth forms
    o = ord(ch)
    return (
        0x3000 <= o <= 0x303F
        or 0xFF00 <= o <= 0xFFEF
        or 0xFE30 <= o <= 0xFE4F
    )


def _is_latin_word_char(ch: str) -> bool:
    return ch.isascii() and (ch.isalnum() or ch in "_")


def join_fragment(left: str, right: str) -> str:
    """Join two soft-wrapped fragments with CJK-aware spacing."""
    if not left:
        return right
    if not right:
        return left
    a, b = left[-1], right[0]
    if _is_cjk_char(a) or _is_cjk_char(b):
        return left + right
    if a.isspace() or b.isspace():
        return left + right
    if a in "([{</\"'" or b in ".,;:!?)]}/\"'":
        return left + right
    if _is_latin_word_char(a) and _is_latin_word_char(b):
        return left + " " + right
    # Default: space between non-CJK runs (URLs already handled by no-space punct).
    if a.isascii() and b.isascii():
        return left + " " + right
    return left + right


def _looks_like_table_row(line: str) -> bool:
    s = line.rstrip("\n")
    if "|" not in s:
        return False
    # Strip inline code spans roughly, then require a pipe.
    stripped = re.sub(r"`[^`]*`", "", s)
    return "|" in stripped


def _is_blank(line: str) -> bool:
    return not line.strip()


@dataclass
class _Buf:
    kind: str  # paragraph | list | blockquote
    prefix: str
    parts: list[str] = field(default_factory=list)
    eol: str = "\n"

    def flush(self) -> str:
        if not self.parts:
            return ""
        body = self.parts[0]
        for part in self.parts[1:]:
            body = join_fragment(body.rstrip(), part.lstrip())
        return f"{self.prefix}{body}{self.eol}"


def unwrap_markdown(text: str) -> str:
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    buf: _Buf | None = None
    in_fence: str | None = None  # fence char run, e.g. "```"
    fence_indent = ""
    in_front_matter = bool(lines) and lines[0].strip() == "---"
    front_matter_done = False
    i = 0

    def flush() -> None:
        nonlocal buf
        if buf is not None:
            out.append(buf.flush())
            buf = None

    while i < len(lines):
        raw = lines[i]
        eol = "\n" if raw.endswith("\n") else ""
        line = raw[:-1] if raw.endswith("\n") else raw
        # Normalize CRLF content already split by splitlines.

        if in_front_matter and not front_matter_done:
            out.append(raw)
            if i > 0 and line.strip() == "---":
                front_matter_done = True
                in_front_matter = False
            i += 1
            continue

        if in_fence is not None:
            out.append(raw)
            m = _FENCE_OPEN.match(line)
            if m and m.group("fence").startswith(in_fence[0]) and len(m.group("fence")) >= len(in_fence):
                # closing fence: same char, length >= open, optional only whitespace after
                if m.group("info").strip() == "" and m.group("indent") == fence_indent:
                    in_fence = None
            i += 1
            continue

        m_fence = _FENCE_OPEN.match(line)
        if m_fence:
            flush()
            in_fence = m_fence.group("fence")
            fence_indent = m_fence.group("indent")
            out.append(raw)
            i += 1
            continue

        if _is_blank(line):
            flush()
            out.append(raw)
            i += 1
            continue

        if _HEADING.match(line) or _HR.match(line) or _REF_DEF.match(line):
            flush()
            out.append(raw)
            i += 1
            continue

        if _looks_like_table_row(line):
            flush()
            out.append(raw)
            i += 1
            continue

        # Setext underline: previous flushed line stays; emit underline as-is.
        if _SETTEXT_UNDER.match(line) and out and not _is_blank(out[-1]):
            flush()
            out.append(raw)
            i += 1
            continue

        html = _HTML_OPEN.match(line)
        if html and html.group(2).lower() in {
            "pre",
            "script",
            "style",
            "textarea",
            "div",
            "table",
            "ul",
            "ol",
            "li",
            "p",
            "blockquote",
            "details",
            "summary",
        }:
            flush()
            out.append(raw)
            i += 1
            continue

        m_bq = _BLOCKQUOTE.match(line)
        m_list = _LIST.match(line) or _ALPHA_LIST.match(line)

        if m_list and not m_bq:
            indent = m_list.group("indent")
            marker = m_list.group("marker")
            sp = m_list.group("sp")
            body = m_list.group("body")
            prefix = f"{indent}{marker}{sp}"
            # Continuation indent ≈ len(prefix)
            flush()
            buf = _Buf(kind="list", prefix=prefix, parts=[body], eol=eol or "\n")
            i += 1
            while i < len(lines):
                raw2 = lines[i]
                eol2 = "\n" if raw2.endswith("\n") else ""
                line2 = raw2[:-1] if raw2.endswith("\n") else raw2
                if _is_blank(line2):
                    break
                if _FENCE_OPEN.match(line2) or _HEADING.match(line2) or _HR.match(line2):
                    break
                if _LIST.match(line2) or _ALPHA_LIST.match(line2):
                    break
                if _BLOCKQUOTE.match(line2):
                    break
                if _looks_like_table_row(line2):
                    break
                # Continuation: indented at least to content column, or plain wrap
                cont = re.match(r"^(?P<ws>[ \t]+)(?P<body>\S.*)$", line2)
                if cont and len(cont.group("ws").replace("\t", "    ")) >= len(prefix):
                    buf.parts.append(cont.group("body"))
                    buf.eol = eol2 or "\n"
                    i += 1
                    continue
                # Soft-wrapped list body without indent (common in hard-wrapped sources)
                if not line2.startswith(" ") and not line2.startswith("\t"):
                    if _LIST.match(line2) or _ALPHA_LIST.match(line2) or _HEADING.match(line2):
                        break
                    buf.parts.append(line2.lstrip())
                    buf.eol = eol2 or "\n"
                    i += 1
                    continue
                break
            flush()
            continue

        if m_bq:
            indent = m_bq.group("indent")
            sp = m_bq.group("sp")
            prefix = f"{indent}>{sp}"
            body = line[len(prefix) :]
            # Nested list under quote: keep structure, still merge quote-prose
            flush()
            buf = _Buf(kind="blockquote", prefix=prefix, parts=[body], eol=eol or "\n")
            i += 1
            while i < len(lines):
                raw2 = lines[i]
                eol2 = "\n" if raw2.endswith("\n") else ""
                line2 = raw2[:-1] if raw2.endswith("\n") else raw2
                if _is_blank(line2):
                    break
                m2 = _BLOCKQUOTE.match(line2)
                if not m2:
                    break
                pref2 = f"{m2.group('indent')}>{m2.group('sp')}"
                if pref2 != prefix:
                    break
                body2 = line2[len(pref2) :]
                if _LIST.match(body2) or _ALPHA_LIST.match(body2) or _HEADING.match(body2):
                    break
                if _FENCE_OPEN.match(body2) or _looks_like_table_row(body2):
                    break
                buf.parts.append(body2.lstrip())
                buf.eol = eol2 or "\n"
                i += 1
            flush()
            continue

        # Ordinary paragraph (possibly soft-wrapped)
        if buf is None or buf.kind != "paragraph":
            flush()
            buf = _Buf(kind="paragraph", prefix="", parts=[line], eol=eol or "\n")
        else:
            buf.parts.append(line.lstrip())
            buf.eol = eol or "\n"
        i += 1
        while i < len(lines):
            raw2 = lines[i]
            eol2 = "\n" if raw2.endswith("\n") else ""
            line2 = raw2[:-1] if raw2.endswith("\n") else raw2
            if _is_blank(line2):
                break
            if (
                _FENCE_OPEN.match(line2)
                or _HEADING.match(line2)
                or _HR.match(line2)
                or _LIST.match(line2)
                or _ALPHA_LIST.match(line2)
                or _BLOCKQUOTE.match(line2)
                or _looks_like_table_row(line2)
                or _REF_DEF.match(line2)
                or _SETTEXT_UNDER.match(line2)
            ):
                break
            buf.parts.append(line2.lstrip())
            buf.eol = eol2 or "\n"
            i += 1
        flush()

    flush()
    result = "".join(out)
    if text.endswith("\n") and not result.endswith("\n"):
        result += "\n"
    return result


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("paths", nargs="*", help="files to rewrite (default: stdin→stdout)")
    p.add_argument("--check", action="store_true", help="exit 1 if any file would change")
    p.add_argument("--stdout", action="store_true", help="print unwrapped form of a single file")
    args = p.parse_args(argv)

    if not args.paths:
        data = sys.stdin.read()
        sys.stdout.write(unwrap_markdown(data))
        return 0

    if args.stdout:
        if len(args.paths) != 1:
            print("unwrap.py: --stdout requires exactly one path", file=sys.stderr)
            return 2
        path = args.paths[0]
        with open(path, encoding="utf-8") as f:
            original = f.read()
        sys.stdout.write(unwrap_markdown(original))
        return 0

    changed = 0
    for path in args.paths:
        with open(path, encoding="utf-8") as f:
            original = f.read()
        updated = unwrap_markdown(original)
        if updated != original:
            changed += 1
            if args.check:
                print(f"would-change\t{path}")
            else:
                with open(path, "w", encoding="utf-8", newline="") as f:
                    f.write(updated)
                print(f"rewrote\t{path}")
        else:
            print(f"ok\t{path}")

    if args.check and changed:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
