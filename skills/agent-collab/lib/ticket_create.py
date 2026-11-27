#!/usr/bin/env python3
"""Create and enrich agent-collab tickets (called under tickets.lock by run.sh)."""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ticket_fs as mod  # noqa: E402


def cmd_create() -> int:
    tid = os.environ["ID"]
    title = os.environ["TITLE"]
    summary = os.environ.get("SUMMARY") or title
    snippet = os.environ.get("SNIPPET") or "_none_"
    original = (os.environ.get("ORIGINAL") or "").strip()
    origin_session = (os.environ.get("ORIGIN_SESSION") or "").strip() or None
    enrich_status = (os.environ.get("ENRICH_STATUS") or "").strip() or None

    raw_attachments = json.loads(os.environ.get("ATTACHMENTS_JSON") or "[]")
    saved_attachments: list[str] = []
    attachment_lines: list[str] = []
    if raw_attachments:
        att_dir = mod.data_dir(tid) / "attachments"
        att_dir.mkdir(parents=True, exist_ok=True)
        img_idx = 0
        for raw_path in raw_attachments:
            src = Path(raw_path)
            if not src.is_file():
                continue
            base = src.name
            dst = att_dir / base
            if src.resolve() != dst.resolve():
                shutil.copy2(src, dst)
            saved_attachments.append(base)
            if base.startswith("diagnostics-"):
                label = "客户端诊断"
            else:
                img_idx += 1
                label = f"图片{img_idx}"
            attachment_lines.append(f"- {label}: {dst}")

    extra_sections = ""
    if original:
        extra_sections += f"\n## Original request\n\n{original}\n"
    if attachment_lines:
        extra_sections += "\n## Attachments\n\n" + "\n".join(attachment_lines) + "\n"

    body = f"""# {title}

## Summary

{summary}
{extra_sections}
## Assumptions

### Observed

{os.environ['OBSERVED']}

### Assumed contract / behavior

{os.environ['ASSUMED']}

### Consumer snippet ref

{snippet}

## Verification

_Fill when researching (required before implement):_

- original_assumption:
- measured_fact:
- impact:
- recommended:
- needs_initiator_decision:

## Thread

<!-- append Q/A here -->

## Decision

_Empty until initiator replies to a challenge._
"""
    meta = {
        "id": tid,
        "from": os.environ["FROM"],
        "to": os.environ["TO"],
        "title": title,
        "status": "submitted",
        "owner": "worker",
        "phase": "intake",
        "created_at": mod.now_iso(),
        "updated_at": mod.now_iso(),
        "lease_until": None,
        "claimed_by": None,
        "claim_gen": 0,
        "source_pr": os.environ.get("SOURCE_PR") or None,
        "solution_doc": None,
        "summary": summary,
    }
    mj: dict[str, object] = {"claim_gen": 0, "worktree": None, "lease_until_epoch": None}
    if saved_attachments:
        mj["attachments"] = saved_attachments
    if origin_session:
        mj["origin_session"] = origin_session
    if enrich_status:
        mj["enrich_status"] = enrich_status
    mod.write_ticket(tid, meta, body)
    mod.write_meta_json(tid, mj)
    mod.append_event(
        tid,
        {
            "type": "created",
            "from": meta["from"],
            "to": meta["to"],
            "title": title,
            "attachments": len(saved_attachments),
        },
    )
    counts = mod.reindex()
    print(
        json.dumps(
            {
                "ok": True,
                "id": tid,
                "to": meta["to"],
                "from": meta["from"],
                "status": "submitted",
                "attachments": saved_attachments,
                "path": str(mod.data_dir(tid)),
                "reindex": counts,
            },
            ensure_ascii=False,
        )
    )
    return 0


def cmd_enrich() -> int:
    tid = os.environ["ID"]
    try:
        meta, body = mod.read_ticket(tid)
    except FileNotFoundError as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        return 2

    mj = mod.read_meta_json(tid)
    status = os.environ.get("STATUS") or "done"
    provider = (os.environ.get("PROVIDER") or "").strip()
    err_msg = (os.environ.get("ERR_MSG") or "").strip()

    if status == "done":
        new_title = (os.environ.get("TITLE") or "").strip()
        new_summary = (os.environ.get("SUMMARY") or "").strip()
        new_observed = (os.environ.get("OBSERVED") or "").strip()
        new_assumed = (os.environ.get("ASSUMED") or "").strip()

        if new_title:
            meta["title"] = new_title
            body = re.sub(r"^#\s+.*$", f"# {new_title}", body, count=1, flags=re.MULTILINE)
        if new_summary:
            meta["summary"] = new_summary
            body = re.sub(
                r"(?ms)^## Summary\n.*?(?=^## |\Z)",
                f"## Summary\n\n{new_summary}\n\n",
                body,
                count=1,
            )
        if new_observed:
            body = re.sub(
                r"(?ms)^### Observed\n.*?(?=^### |^## |\Z)",
                f"### Observed\n\n{new_observed}\n\n",
                body,
                count=1,
            )
        if new_assumed:
            body = re.sub(
                r"(?ms)^### Assumed contract / behavior\n.*?(?=^### |^## |\Z)",
                f"### Assumed contract / behavior\n\n{new_assumed}\n\n",
                body,
                count=1,
            )
        mod.write_ticket(tid, meta, body)
        mj["enrich_status"] = "done"
        if provider:
            mj["enrich_provider"] = provider
        mj.pop("enrich_error", None)
    else:
        mj["enrich_status"] = status
        if provider:
            mj["enrich_provider"] = provider
        if err_msg:
            mj["enrich_error"] = err_msg[:300]

    mod.write_meta_json(tid, mj)
    ev: dict[str, object] = {"type": "enriched", "status": status}
    if provider:
        ev["provider"] = provider
    mod.append_event(tid, ev)
    mod.reindex()
    print(json.dumps({"ok": True, "id": tid, "enrich_status": mj.get("enrich_status")}, ensure_ascii=False))
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 1:
        print("usage: ticket_create.py create|enrich", file=sys.stderr)
        return 1
    if argv[0] == "create":
        return cmd_create()
    if argv[0] == "enrich":
        return cmd_enrich()
    print(f"unknown subcommand: {argv[0]}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
