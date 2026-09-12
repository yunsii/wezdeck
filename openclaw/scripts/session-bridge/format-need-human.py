#!/usr/bin/env python3
"""Backward-compatible wrapper → notify_card (need_human / plain).

Prefer notify_card.py for new code paths.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Allow `python3 format-need-human.py` without package install.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from notify_card import extract_card, render_plain  # noqa: E402


def main() -> int:
    target = sys.argv[1] if len(sys.argv) > 1 else "?"
    kind = sys.argv[2] if len(sys.argv) > 2 else "?"
    note = sys.argv[3] if len(sys.argv) > 3 else ""
    text = sys.stdin.read()
    card = extract_card(text, event="need_human", target=target, kind=kind, note=note)
    sys.stdout.write(render_plain(card))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
