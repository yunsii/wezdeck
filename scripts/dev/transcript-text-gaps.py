#!/usr/bin/env python3
"""Count Claude Code replies whose visible text never reached the transcript.

A reply shaped thinking -> text -> thinking -> tool_use was seen persisted as
thinking, thinking, tool_use only (Claude Code 2.1.330): the TUI shows the
text, the .jsonl does not, so the phone (which reads the transcript) never
can. docs/diagnostics.md open question 32 closes once a new session shows 0.

  scripts/dev/transcript-text-gaps.py [TRANSCRIPT.jsonl]   # default: newest in this repo's project dir
"""
import json
import pathlib
import sys
from collections import OrderedDict


def newest_transcript() -> pathlib.Path:
    repo = pathlib.Path(__file__).resolve().parents[2]
    project = pathlib.Path.home() / ".claude/projects" / str(repo).replace("/", "-")
    files = sorted(project.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    if not files:
        sys.exit(f"no transcript under {project}")
    return files[-1]


def main() -> None:
    path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else newest_transcript()
    replies: "OrderedDict[str, dict]" = OrderedDict()
    for line in path.open(encoding="utf-8"):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if row.get("type") != "assistant" or row.get("isSidechain"):
            continue
        msg = row.get("message") or {}
        entry = replies.setdefault(msg.get("id") or row.get("uuid"), {"kinds": [], "ts": row.get("timestamp", "")})
        entry["kinds"] += [block.get("type") for block in msg.get("content") or []]
    gaps = [e for e in replies.values() if e["kinds"].count("thinking") >= 2 and "text" not in e["kinds"]]
    with_text = [e for e in replies.values() if e["kinds"].count("thinking") >= 2 and "text" in e["kinds"]]
    print(f"{path.name}: {len(replies)} replies; {len(gaps)} with 2+ thinking blocks and no text "
          f"(suspected dropped text); {len(with_text)} with 2+ thinking blocks and text")
    for entry in gaps[-5:]:
        print(f"  {entry['ts']}  {entry['kinds']}")


if __name__ == "__main__":
    main()
