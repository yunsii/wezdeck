#!/usr/bin/env python3
"""dead_ends.md — compact failure/rejection ledger per ticket (stdlib only).

Appends 3-5 line structured entries to `_data/<id>/dead_ends.md` whenever a
worker run exits non-zero or a split proposal is rejected, and returns a
bounded tail (<= 2 KB) for automatic injection into subsequent worker phase
views so fresh/retried runs never repeat the same failed path.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ticket_fs  # noqa: E402

MAX_INJECT_BYTES = 2048


def dead_ends_path(tid: str) -> Path:
    return ticket_fs.tickets_root() / "_data" / tid / "dead_ends.md"


def _clip(text: str, limit: int = 240) -> str:
    clean = " ".join(str(text or "").split())
    return clean if len(clean) <= limit else clean[: limit - 1] + "…"


def record_dead_end(
    tid: str,
    *,
    role: str,
    source_id: str,
    tried: str,
    reason: str,
) -> Path:
    path = dead_ends_path(tid)
    path.parent.mkdir(parents=True, exist_ok=True)
    ts = ticket_fs.now_iso()
    entry = (
        f"- **[{ts}] {role} · `{source_id}`**\n"
        f"  - Tried: {_clip(tried, 220)}\n"
        f"  - Failed/Rejected: {_clip(reason, 280)}\n"
    )
    if not path.is_file():
        path.write_text("# Dead Ends (Do Not Repeat)\n\n" + entry, encoding="utf-8")
    else:
        with path.open("a", encoding="utf-8") as fh:
            fh.write(entry)
    return path


def read_dead_ends(tid: str, max_bytes: int = MAX_INJECT_BYTES) -> str:
    path = dead_ends_path(tid)
    if not path.is_file():
        return ""
    raw = path.read_text(encoding="utf-8", errors="replace").strip()
    if not raw:
        return ""
    encoded = raw.encode("utf-8")
    if len(encoded) <= max_bytes:
        return raw
    # Keep the newest entries from the tail, aligned on a line boundary.
    tail = encoded[-max_bytes:].decode("utf-8", errors="ignore")
    nl = tail.find("\n")
    if nl > 0:
        tail = tail[nl + 1 :]
    return "# Dead Ends (latest entries)\n\n" + tail.strip()


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "read":
        text = read_dead_ends(argv[1])
        if text:
            sys.stdout.write(text + "\n")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
