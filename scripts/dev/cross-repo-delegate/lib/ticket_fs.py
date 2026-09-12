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


def append_event(tid: str, event: dict[str, Any]) -> None:
    d = data_dir(tid)
    d.mkdir(parents=True, exist_ok=True)
    event = dict(event)
    event.setdefault("ts", now_iso())
    event.setdefault("id", tid)
    with (d / "events.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


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


def cmd_reindex(_: list[str]) -> int:
    counts = reindex()
    print(json.dumps({"ok": True, **counts}, ensure_ascii=False))
    return 0


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: ticket_fs.py reindex|…", file=sys.stderr)
        return 1
    cmd = argv[0]
    if cmd == "reindex":
        return cmd_reindex(argv[1:])
    print(f"unknown: {cmd}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
