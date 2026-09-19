#!/usr/bin/env python3
"""Compare README.md and README.zh-CN.md for structural parity.

Prints FAIL / ADVISORY lines to stdout. Exit 1 when any FAIL exists.
"""
from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
HEADING_RE = re.compile(r"^(#{1,6})\s+(\S.*)$")
FENCE_OPEN_RE = re.compile(r"^```([\w+-]*)\s*$")
TABLE_SEP_RE = re.compile(r"^\|[\s:|-]+\|\s*$")

# Soft: zh may be slightly shorter/longer; hard floor catches half-updated copies.
LINE_RATIO_ADVISORY = 0.90
LINE_RATIO_FAIL = 0.75


def strip_fences(text: str) -> list[str]:
    """Return lines outside fenced code blocks (``` … ```)."""
    out: list[str] = []
    in_fence = False
    for line in text.splitlines():
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence:
            out.append(line)
    return out


def heading_levels(text: str) -> list[int]:
    levels: list[int] = []
    for line in strip_fences(text):
        m = HEADING_RE.match(line)
        if m:
            levels.append(len(m.group(1)))
    return levels


def heading_titles(text: str) -> list[str]:
    titles: list[str] = []
    for line in strip_fences(text):
        m = HEADING_RE.match(line)
        if m:
            titles.append(m.group(2).strip())
    return titles


def relative_link_paths(text: str) -> set[str]:
    paths: set[str] = set()
    for raw in LINK_RE.findall(text):
        url = raw.strip()
        if not url or url.startswith(("http://", "https://", "mailto:", "#")):
            continue
        path = url.split("#", 1)[0].split("?", 1)[0]
        if not path:
            continue
        # Normalize ./foo → foo
        if path.startswith("./"):
            path = path[2:]
        paths.add(path)
    return paths


def fence_langs(text: str) -> Counter[str]:
    counts: Counter[str] = Counter()
    in_fence = False
    for line in text.splitlines():
        if not in_fence and line.startswith("```"):
            m = FENCE_OPEN_RE.match(line)
            lang = (m.group(1) if m else "") or "(plain)"
            counts[lang] += 1
            in_fence = True
        elif in_fence and line.startswith("```"):
            in_fence = False
    return counts


def table_sep_count(text: str) -> int:
    return sum(1 for line in strip_fences(text) if TABLE_SEP_RE.match(line))


def load_tokens(conf: Path) -> list[str]:
    if not conf.is_file():
        return []
    tokens: list[str] = []
    for line in conf.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("token "):
            tok = s[len("token ") :].strip()
            if tok:
                tokens.append(tok)
    return tokens


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: readme-parity.py <repo-root> [token-conf]", file=sys.stderr)
        return 2
    root = Path(sys.argv[1])
    conf = Path(sys.argv[2]) if len(sys.argv) > 2 else root / "scripts/dev/repo-hygiene/readme-parity.conf"

    en_path = root / "README.md"
    zh_path = root / "README.zh-CN.md"
    fails = 0
    advisories = 0

    def fail(msg: str) -> None:
        nonlocal fails
        fails += 1
        print(f"FAIL README parity: {msg}")

    def adv(msg: str) -> None:
        nonlocal advisories
        advisories += 1
        print(f"ADVISORY README parity: {msg}")

    if not en_path.is_file():
        fail("README.md missing")
        return 1
    if not zh_path.is_file():
        fail("README.zh-CN.md missing (English README exists — add a Chinese twin)")
        return 1

    en = en_path.read_text(encoding="utf-8")
    zh = zh_path.read_text(encoding="utf-8")

    # --- language switcher ---
    if "README.zh-CN.md" not in en:
        fail("README.md must link to README.zh-CN.md (language switcher)")
    if "README.md" not in zh:
        # ZH always links to README.md in body too (AGENTS etc.); require explicit English label.
        if not re.search(r"\[English\]\(README\.md\)", zh):
            fail("README.zh-CN.md must link back with [English](README.md)")

    # --- heading level outline ---
    en_levels = heading_levels(en)
    zh_levels = heading_levels(zh)
    if en_levels != zh_levels:
        fail(
            "heading level outline differs "
            f"(en={en_levels} zh={zh_levels}); keep the same ## / ### skeleton"
        )
        # Helpful hint: show titles side by side when lengths match-ish
        et, zt = heading_titles(en), heading_titles(zh)
        n = max(len(et), len(zt))
        for i in range(n):
            e = et[i] if i < len(et) else "<missing>"
            z = zt[i] if i < len(zt) else "<missing>"
            mark = " " if (i < len(en_levels) and i < len(zh_levels) and en_levels[i] == zh_levels[i]) else "!"
            print(f"  {mark} H{en_levels[i] if i < len(en_levels) else '?'} | {e}  ||  {z}")

    # --- relative link path sets ---
    en_links = relative_link_paths(en)
    zh_links = relative_link_paths(zh)
    # Language switcher paths are expected asymmetries
    en_cmp = set(en_links)
    zh_cmp = set(zh_links)
    en_cmp.discard("README.zh-CN.md")
    zh_cmp.discard("README.md")
    # ZH may use README.md only as switcher; EN may not link to itself
    only_en = sorted(en_cmp - zh_cmp)
    only_zh = sorted(zh_cmp - en_cmp)
    if only_en:
        fail("relative links only in README.md: " + ", ".join(only_en))
    if only_zh:
        fail("relative links only in README.zh-CN.md: " + ", ".join(only_zh))

    # --- fence language multiset ---
    en_fences = fence_langs(en)
    zh_fences = fence_langs(zh)
    if en_fences != zh_fences:
        fail(f"fenced-block language counts differ (en={dict(en_fences)} zh={dict(zh_fences)})")

    # --- table count ---
    en_tables = table_sep_count(en)
    zh_tables = table_sep_count(zh)
    if en_tables != zh_tables:
        fail(f"markdown table count differs (en={en_tables} zh={zh_tables})")

    # --- shared durable tokens ---
    for tok in load_tokens(conf):
        in_en = tok in en
        in_zh = tok in zh
        if in_en and not in_zh:
            fail(f"token {tok!r} present in README.md but missing in README.zh-CN.md")
        elif in_zh and not in_en:
            fail(f"token {tok!r} present in README.zh-CN.md but missing in README.md")
        elif not in_en and not in_zh:
            adv(f"token {tok!r} missing from both READMEs (update readme-parity.conf or restore)")

    # --- line-count ratio ---
    en_n = en.count("\n") + (0 if en.endswith("\n") or not en else 1)
    zh_n = zh.count("\n") + (0 if zh.endswith("\n") or not zh else 1)
    # prefer wc-style: count lines via splitlines
    en_n = len(en.splitlines())
    zh_n = len(zh.splitlines())
    hi = max(en_n, zh_n) or 1
    lo = min(en_n, zh_n)
    ratio = lo / hi
    if ratio < LINE_RATIO_FAIL:
        fail(f"line-count ratio too low ({en_n} vs {zh_n}, ratio={ratio:.2f} < {LINE_RATIO_FAIL})")
    elif ratio < LINE_RATIO_ADVISORY:
        adv(f"line-count ratio soft warning ({en_n} vs {zh_n}, ratio={ratio:.2f} < {LINE_RATIO_ADVISORY})")

    if fails == 0 and advisories == 0:
        print(
            f"ok README parity: headings={len(en_levels)} links={len(en_cmp)} "
            f"tables={en_tables} fences={sum(en_fences.values())} lines={en_n}/{zh_n}"
        )
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
