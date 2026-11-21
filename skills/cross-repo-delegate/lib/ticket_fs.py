#!/usr/bin/env python3
"""Filesystem helpers for delegate tickets (stdlib only)."""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Any

LEASE_SECONDS_DEFAULT = 2 * 60 * 60  # 2h


def tickets_root() -> Path:
    return Path(os.environ.get("DELEGATE_TICKETS_ROOT", Path.home() / ".agent" / "tickets"))


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def now_epoch() -> int:
    return int(time.time())


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end < 0:
        return {}, text
    block = text[4:end]
    body = text[end + 5 :]
    meta: dict[str, Any] = {}
    for line in block.splitlines():
        if not line.strip() or line.strip().startswith("#"):
            continue
        if ":" not in line:
            continue
        key, raw = line.split(":", 1)
        key = key.strip()
        raw = raw.strip()
        if raw.startswith("[") and raw.endswith("]"):
            inner = raw[1:-1].strip()
            meta[key] = [x.strip().strip("\"'") for x in inner.split(",") if x.strip()] if inner else []
        elif raw.lower() in ("null", "~", ""):
            meta[key] = None
        elif raw.lower() in ("true", "false"):
            meta[key] = raw.lower() == "true"
        elif re.fullmatch(r"-?\d+", raw):
            meta[key] = int(raw)
        else:
            meta[key] = raw.strip("\"'")
    return meta, body


def dump_frontmatter(meta: dict[str, Any], body: str) -> str:
    order = [
        "id",
        "from",
        "to",
        "title",
        "status",
        "owner",
        "phase",
        "created_at",
        "updated_at",
        "lease_until",
        "claimed_by",
        "claim_gen",
        "source_pr",
        "solution_doc",
        "summary",
    ]
    keys = list(order) + [k for k in meta.keys() if k not in order]
    lines = ["---"]
    for k in keys:
        if k not in meta:
            continue
        v = meta[k]
        if v is None:
            lines.append(f"{k}: null")
        elif isinstance(v, bool):
            lines.append(f"{k}: {'true' if v else 'false'}")
        elif isinstance(v, list):
            inner = ", ".join(str(x) for x in v)
            lines.append(f"{k}: [{inner}]")
        elif isinstance(v, int):
            lines.append(f"{k}: {v}")
        else:
            s = str(v).replace("\n", " ")
            if ":" in s or s.startswith(" ") or s == "":
                lines.append(f'{k}: "{s}"')
            else:
                lines.append(f"{k}: {s}")
    lines.append("---")
    body = body if body.endswith("\n") or body == "" else body + "\n"
    return "\n".join(lines) + "\n" + body


def data_dir(tid: str) -> Path:
    return tickets_root() / "_data" / tid


def read_ticket(tid: str) -> tuple[dict[str, Any], str]:
    path = data_dir(tid) / "ticket.md"
    if not path.is_file():
        raise FileNotFoundError(f"ticket not found: {tid}")
    return parse_frontmatter(path.read_text(encoding="utf-8"))


def write_ticket(tid: str, meta: dict[str, Any], body: str) -> None:
    d = data_dir(tid)
    d.mkdir(parents=True, exist_ok=True)
    meta = dict(meta)
    meta["updated_at"] = now_iso()
    (d / "ticket.md").write_text(dump_frontmatter(meta, body), encoding="utf-8")


def _observe():
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "delegate_observe", Path(__file__).resolve().parent / "observe.py"
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def append_event(tid: str, event: dict[str, Any]) -> None:
    """Per-ticket + global event stream with the v1 envelope (lib/observe.py)."""
    _observe().write_events(tid, [dict(event)])


def write_progress(
    tid: str,
    step: str,
    message: str,
    *,
    heartbeat: bool = False,
    phase: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Update progress.json; milestone events go to events.jsonl (heartbeats skip)."""
    d = data_dir(tid)
    d.mkdir(parents=True, exist_ok=True)
    meta: dict[str, Any] = {}
    try:
        meta, _ = read_ticket(tid)
    except FileNotFoundError:
        pass
    snap: dict[str, Any] = {
        "id": tid,
        "step": step,
        "message": message,
        "heartbeat": bool(heartbeat),
        "ts": now_iso(),
        "epoch": now_epoch(),
        "status": meta.get("status"),
        "phase": phase if phase is not None else meta.get("phase"),
        "owner": meta.get("owner"),
    }
    if extra:
        for k, v in extra.items():
            if k not in snap:
                snap[k] = v
    (d / "progress.json").write_text(
        json.dumps(snap, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    if not heartbeat:
        ev: dict[str, Any] = {
            "type": "progress",
            "step": step,
            "message": message,
        }
        if phase is not None:
            ev["phase"] = phase
        if extra:
            for k, v in extra.items():
                if k not in ev:
                    ev[k] = v
        append_event(tid, ev)
        # stderr so sync create --run / watch callers see milestones without polling
        print(f"[delegate] progress · {step} · {message}", file=sys.stderr)
    return snap


def read_progress(tid: str) -> dict[str, Any] | None:
    path = data_dir(tid) / "progress.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def list_events(tid: str, *, after: int = 0, limit: int | None = None) -> tuple[list[dict[str, Any]], int]:
    """Return (events after line offset, total line count). after is 0-based line index."""
    path = data_dir(tid) / "events.jsonl"
    if not path.is_file():
        return [], 0
    lines = path.read_text(encoding="utf-8").splitlines()
    total = len(lines)
    start = max(0, int(after))
    chunk = lines[start:]
    if limit is not None and limit >= 0:
        chunk = chunk[:limit]
    out: list[dict[str, Any]] = []
    for line in chunk:
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out, total


def read_meta_json(tid: str) -> dict[str, Any]:
    path = data_dir(tid) / "meta.json"
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def write_meta_json(tid: str, meta: dict[str, Any]) -> None:
    d = data_dir(tid)
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def bucket_for(status: str, owner: str | None) -> str:
    status = status or ""
    owner = owner or ""
    if status in ("closed", "rejected"):
        return "done"
    if status in ("waiting_initiator", "shipped"):
        return "waiting-on-peer"
    if status == "in_progress":
        return "in-progress"
    if status in ("submitted", "waiting_target", "failed"):
        return "inbox"
    if owner == "initiator":
        return "waiting-on-peer"
    return "inbox"


def lease_active(meta: dict[str, Any]) -> bool:
    until = meta.get("lease_until")
    if until is None:
        return False
    try:
        # allow epoch int or ISO — store epoch in meta.json primarily
        if isinstance(until, int):
            return until > now_epoch()
        # ISO Z
        if isinstance(until, str) and until.endswith("Z") and "T" in until:
            # rough parse
            t = time.strptime(until, "%Y-%m-%dT%H:%M:%SZ")
            return int(time.mktime(t)) - time.timezone > now_epoch()
    except Exception:
        return False
    return False


def clear_derived_links() -> None:
    root = tickets_root()
    for kind in ("by-target", "by-source"):
        base = root / kind
        if not base.is_dir():
            continue
        for p in base.rglob("req-*"):
            if p.is_symlink() or p.is_file():
                p.unlink()


def ensure_link(link: Path, target: Path) -> None:
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink() or link.exists():
        link.unlink()
    # relative link into _data
    rel = os.path.relpath(target, start=link.parent)
    link.symlink_to(rel)


def reindex() -> dict[str, int]:
    root = tickets_root()
    (root / "by-target").mkdir(parents=True, exist_ok=True)
    (root / "by-source").mkdir(parents=True, exist_ok=True)
    clear_derived_links()
    counts = {"tickets": 0, "links": 0}
    data = root / "_data"
    if not data.is_dir():
        return counts
    index: list[dict[str, Any]] = []
    for d in sorted(data.iterdir()):
        if not d.is_dir() or not d.name.startswith("req-"):
            continue
        ticket_path = d / "ticket.md"
        if not ticket_path.is_file():
            continue
        meta, _body = parse_frontmatter(ticket_path.read_text(encoding="utf-8"))
        tid = meta.get("id") or d.name
        to_key = meta.get("to") or "unknown"
        from_key = meta.get("from") or "unknown"
        status = str(meta.get("status") or "submitted")
        owner = str(meta.get("owner") or "")
        bucket = bucket_for(status, owner)
        # if lease expired while in_progress, surface back in inbox for reclaim
        mj = read_meta_json(tid)
        lease_until = mj.get("lease_until_epoch")
        if status == "in_progress" and isinstance(lease_until, int) and lease_until <= now_epoch():
            bucket = "inbox"
        ensure_link(root / "by-target" / to_key / bucket / f"{tid}.md", ticket_path)
        src_bucket = "closed" if status in ("closed", "rejected") else "open"
        ensure_link(root / "by-source" / from_key / src_bucket / f"{tid}.md", ticket_path)
        counts["tickets"] += 1
        counts["links"] += 2
        index.append(
            {
                "id": tid,
                "from": from_key,
                "to": to_key,
                "status": status,
                "owner": owner,
                "title": meta.get("title"),
                "bucket": bucket,
                "updated_at": meta.get("updated_at"),
            }
        )
    (root / "index.json").write_text(json.dumps({"generated_at": now_iso(), "tickets": index}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return counts


def list_inbox(to_key: str) -> list[dict[str, Any]]:
    root = tickets_root() / "by-target" / to_key / "inbox"
    out: list[dict[str, Any]] = []
    if not root.is_dir():
        return out
    for link in sorted(root.glob("req-*.md")):
        tid = link.name[: -len(".md")]
        try:
            meta, body = read_ticket(tid)
        except FileNotFoundError:
            continue
        out.append({"id": tid, "meta": meta, "preview": body.strip().splitlines()[:8]})
    return out


# Phase views for worker prompt injection (token trim). Full ticket stays on disk.
#
# Rule: omit only high-noise or phase-irrelevant sections — never the contract
# the hop must honor. Thread grows with Q/A and is the main trim target;
# events.jsonl is never embedded. Assumptions stay in *both* phases (small,
# and implement still needs observed / assumed / snippet-ref).
PHASE_VIEW_SECTIONS: dict[str, tuple[str, ...]] = {
    # research: contract to verify; skip empty Decision / prior Implement / Thread
    "research": ("Summary", "Assumptions"),
    # implement: same contract + agreed verification/decision; optional Implement
    "implement": ("Summary", "Assumptions", "Verification", "Decision", "Implement"),
}


def split_markdown_sections(body: str) -> list[tuple[str | None, str]]:
    """Split body into (heading_title|None, section_text_including_heading).

    Heading title is the text after ``## `` (ATX h2 only). Preamble before the
    first h2 keeps title None.
    """
    lines = body.splitlines(keepends=True)
    sections: list[tuple[str | None, str]] = []
    cur_title: str | None = None
    buf: list[str] = []
    heading_re = re.compile(r"^##[ \t]+(.+?)\s*$")

    def flush() -> None:
        nonlocal buf, cur_title
        if not buf and cur_title is None:
            return
        sections.append((cur_title, "".join(buf)))
        buf = []

    for line in lines:
        m = heading_re.match(line.rstrip("\n"))
        if m:
            flush()
            cur_title = m.group(1).strip()
            buf = [line]
        else:
            buf.append(line)
    flush()
    return sections


def extract_h2_section(body: str, title: str) -> str | None:
    for heading, text in split_markdown_sections(body):
        if heading == title:
            return text.rstrip() + ("\n" if text else "")
    return None


def render_phase_view(meta: dict[str, Any], body: str, phase: str) -> str:
    """Build the embedded ticket slice for a worker phase.

    Omitted sections (Thread, unused phase blocks, events.jsonl) stay in the
    canonical ``ticket.md`` for on-demand Read — they are not re-injected.
    """
    phase = (phase or "").strip().lower()
    wanted = PHASE_VIEW_SECTIONS.get(phase)
    if wanted is None:
        raise ValueError(f"unknown phase for ticket view: {phase!r} (research|implement)")

    tid = meta.get("id") or "?"
    title = meta.get("title") or tid
    summary = meta.get("summary") or title
    header_lines = [
        f"# {title}",
        "",
        f"- id: `{tid}`",
        f"- from: {meta.get('from') or '?'}",
        f"- to: {meta.get('to') or '?'}",
        f"- status: {meta.get('status') or '?'}",
        f"- phase: {meta.get('phase') or '?'}",
        f"- summary: {summary}",
        "",
        f"_Phase view · `{phase}` — authoritative for this hop. "
        f"Omitted sections live in `.delegate/ticket.md`; read only if needed._",
        "",
    ]

    out = "\n".join(header_lines) + "\n"
    missing: list[str] = []
    for section_title in wanted:
        block = extract_h2_section(body, section_title)
        if block is None or not block.strip():
            # Implement block is optional (first pass); others should exist.
            if section_title == "Implement":
                continue
            missing.append(section_title)
            continue
        out += block.rstrip() + "\n\n"

    if missing:
        out += (
            "_Missing expected sections in canonical ticket: "
            + ", ".join(f"`{s}`" for s in missing)
            + "._\n"
        )
    return out.rstrip() + "\n"


def cmd_reindex(_: list[str]) -> int:
    counts = reindex()
    print(json.dumps({"ok": True, **counts}, ensure_ascii=False))
    return 0


def cmd_phase_view(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: ticket_fs.py phase-view <ticket-id> <research|implement>", file=sys.stderr)
        return 1
    tid, phase = argv[0], argv[1]
    meta, body = read_ticket(tid)
    sys.stdout.write(render_phase_view(meta, body, phase))
    return 0


def cmd_progress_emit(argv: list[str]) -> int:
    """progress-emit <id> <step> <message> [--heartbeat] [--phase P] [--json EXTRA]"""
    if len(argv) < 3:
        print(
            "usage: ticket_fs.py progress-emit <id> <step> <message> [--heartbeat] [--phase P]",
            file=sys.stderr,
        )
        return 1
    tid, step, message = argv[0], argv[1], argv[2]
    heartbeat = False
    phase: str | None = None
    extra: dict[str, Any] = {}
    i = 3
    while i < len(argv):
        if argv[i] == "--heartbeat":
            heartbeat = True
            i += 1
        elif argv[i] == "--phase" and i + 1 < len(argv):
            phase = argv[i + 1]
            i += 2
        elif argv[i] == "--json" and i + 1 < len(argv):
            try:
                parsed = json.loads(argv[i + 1])
                if isinstance(parsed, dict):
                    extra.update(parsed)
            except json.JSONDecodeError:
                pass
            i += 2
        else:
            i += 1
    if phase is not None:
        try:
            meta, body = read_ticket(tid)
            meta["phase"] = phase
            if meta.get("status") in (None, "submitted"):
                meta["status"] = "in_progress"
            write_ticket(tid, meta, body)
        except FileNotFoundError:
            pass
    snap = write_progress(tid, step, message, heartbeat=heartbeat, phase=phase, extra=extra or None)
    print(json.dumps({"ok": True, "progress": snap}, ensure_ascii=False))
    return 0


def cmd_progress_read(argv: list[str]) -> int:
    """progress-read <id> [--after N] [--events-limit N]"""
    if not argv:
        print("usage: ticket_fs.py progress-read <id> [--after N] [--events-limit N]", file=sys.stderr)
        return 1
    tid = argv[0]
    after = 0
    events_limit: int | None = 20
    i = 1
    while i < len(argv):
        if argv[i] == "--after" and i + 1 < len(argv):
            after = int(argv[i + 1])
            i += 2
        elif argv[i] == "--events-limit" and i + 1 < len(argv):
            events_limit = int(argv[i + 1])
            i += 2
        else:
            i += 1
    try:
        meta, _ = read_ticket(tid)
    except FileNotFoundError as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False), file=sys.stderr)
        return 2
    new_events, total = list_events(tid, after=after, limit=None)
    recent = new_events
    if events_limit is not None and after == 0:
        recent = new_events[-events_limit:] if events_limit >= 0 else new_events
    elif events_limit is not None and events_limit >= 0:
        recent = new_events[:events_limit]
    out = {
        "ok": True,
        "id": tid,
        "status": meta.get("status"),
        "phase": meta.get("phase"),
        "owner": meta.get("owner"),
        "progress": read_progress(tid),
        "new_events": new_events if after else recent,
        "events_total": total,
        "events_cursor": total,
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: ticket_fs.py reindex|phase-view|progress-emit|progress-read|…", file=sys.stderr)
        return 1
    cmd = argv[0]
    if cmd == "reindex":
        return cmd_reindex(argv[1:])
    if cmd == "phase-view":
        return cmd_phase_view(argv[1:])
    if cmd == "progress-emit":
        return cmd_progress_emit(argv[1:])
    if cmd == "progress-read":
        return cmd_progress_read(argv[1:])
    print(f"unknown: {cmd}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
