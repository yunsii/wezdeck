#!/usr/bin/env python3
"""ticket fanout draft|propose|approve|reject|proposals — splits wait on a human.

Every split is a *proposal* until a human confirms it: agents run ``approve``
only after the user said yes in chat. Two origins:

  draft  — a read-only plan agent (``research``) drafts contract + children for
           a new parent. The parent waits in phase ``plan_review``; ``fanout run``
           refuses until the draft is approved.
  split  — a running child proposes an extra sibling inside its own scope.
           One level only (split-born children cannot split); at most
           TICKET_MAX_CHILDREN (12) children per parent. The scheduler keeps
           running the rest and parks the parent in ``split_review`` instead of
           integrating while a split is pending.

  fanout draft --from KEY --repos A[,B…] --title T --goal-file F [--backend B]
  fanout propose --parent P --by-child C --title T --observed O --assumed A
                 [--scope G,G] [--depends-on ID,ID] [--reason R]
  fanout approve --parent P --proposal ID [--only KEY,KEY] [--run [--mock] [--backend B]]
  fanout reject  --parent P --proposal ID --reason R
  fanout proposals --parent P [--pending]
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

import fanout as collab
import ticket_fs

MAX_CHILDREN = int(os.environ.get("TICKET_MAX_CHILDREN", "12"))
PLAN_PROMPT = collab.TOOL_ROOT / "prompts" / "plan.md"


def load(pid: str) -> list[dict[str, Any]]:
    p = ticket_fs.data_dir(pid) / "proposals.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else []


def save(pid: str, props: list[dict[str, Any]]) -> None:
    (ticket_fs.data_dir(pid) / "proposals.json").write_text(
        json.dumps(props, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def pending(pid: str, origin: str | None = None) -> list[dict[str, Any]]:
    return [p for p in load(pid) if p["status"] == "pending" and (origin is None or p["origin"] == origin)]


def within(inner: list[str], outer: list[str]) -> bool:
    """Every inner scope prefix sits inside some outer prefix (no outer scope = whole repo)."""
    if not outer:
        return True
    if not inner:
        return False
    outs = collab.scope_prefixes(outer)
    return all(any(o == "" or p == o or p.startswith(o + "/") for o in outs) for p in collab.scope_prefixes(inner))


def validate(items: list[dict[str, Any]], known: set[str]) -> list[str]:
    """Hard errors for a list of proposed children (keys may depend on each other or on `known` ids)."""
    errs: list[str] = []
    keys = [str(i.get("key") or "") for i in items]
    if len(set(keys)) != len(keys) or not all(keys):
        errs.append("every child needs a unique key")
    for i in items:
        for f in ("to", "title", "observed", "assumed"):
            if not i.get(f):
                errs.append(f"{i.get('key')}: missing {f}")
        try:
            collab.target_path(str(i.get("to")))
        except Exception:  # noqa: BLE001 — unknown target in the allowlist
            errs.append(f"{i.get('key')}: target {i.get('to')!r} is not in the allowlist")
        bad = [d for d in i.get("depends_on") or [] if d not in keys and d not in known]
        if bad:
            errs.append(f"{i.get('key')}: unknown depends_on {bad}")
    if not errs:
        try:
            collab.topo_order(keys, {i["key"]: [d for d in i.get("depends_on") or [] if d in keys] for i in items})
        except collab.CollabError as exc:
            errs.append(str(exc))
    return errs


def warnings(items: list[dict[str, Any]]) -> list[str]:
    out = []
    for n, a in enumerate(items):
        for b in items[n + 1:]:
            if a["to"] == b["to"] and collab.scopes_overlap(a.get("scope") or [], b.get("scope") or []):
                out.append(f"{a['key']} and {b['key']} overlap in {a['to']}: they will run serially")
    return out


def record(pid: str, prop: dict[str, Any]) -> dict[str, Any]:
    props = load(pid)
    prop.update({"id": f"p{len(props) + 1}", "status": "pending", "created_at": ticket_fs.now_iso()})
    save(pid, props + [prop])
    collab.event(pid, "proposal_created", proposal=prop["id"], origin=prop["origin"], by=prop.get("by"),
                 children=len(prop["items"]))
    return prop


def cmd_draft(argv: list[str]) -> dict[str, Any]:
    src, repos, title = collab.opt(argv, "--from"), collab.opt(argv, "--repos"), collab.opt(argv, "--title")
    goal_file = collab.opt(argv, "--goal-file")
    if not (src and repos and title and goal_file and Path(goal_file).is_file()):
        raise collab.CollabError("draft needs --from, --repos, --title and an existing --goal-file")
    prompt = (PLAN_PROMPT.read_text(encoding="utf-8")
              .replace("{{GOAL}}", Path(goal_file).read_text(encoding="utf-8").strip())
              .replace("{{REPOS}}", repos).replace("{{MAX_CHILDREN}}", str(MAX_CHILDREN)))
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as fh:
        fh.write(prompt)
    import research  # noqa: PLC0415 — only draft needs the research substrate
    try:
        r = research.run(["--from", src, "--repos", repos, "--title", f"plan: {title}", "--prompt-file", fh.name,
                          "--backend", collab.opt(argv, "--backend") or "claude"])
    finally:
        os.unlink(fh.name)
    plan = r.get("result") or {}
    items = plan.get("children") if isinstance(plan, dict) else None
    if not r.get("ok_result") or not isinstance(items, list) or not plan.get("contract"):
        raise collab.CollabError(f"plan agent returned no usable plan (research {r.get('id')})")
    errs = validate(items, set()) + ([f"{len(items)} children > {MAX_CHILDREN}"] if len(items) > MAX_CHILDREN else [])
    if errs:
        raise collab.CollabError(f"plan rejected before review (research {r.get('id')}): " + "; ".join(errs))
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as fh:
        fh.write(str(plan["contract"]))
    try:
        pid = collab.cmd_plan(["--from", src, "--title", title, "--contract", fh.name])["id"]
    finally:
        os.unlink(fh.name)
    prop = record(pid, {"origin": "draft", "research": r.get("id"), "items": items, "warnings": warnings(items)})
    collab.set_status(pid, "waiting_initiator", owner="human", phase="plan_review")
    collab.progress(pid, "plan_review", f"draft {prop['id']}: {len(items)} children — confirm with the user, "
                    f"then `ticket fanout approve --parent {pid} --proposal {prop['id']}`")
    return {"parent": pid, "proposal": prop, "contract": str(ticket_fs.data_dir(pid) / "contract.md")}


def cmd_propose(argv: list[str]) -> dict[str, Any]:
    pid = collab.observe_tid(collab.opt(argv, "--parent"))
    by = collab.observe_tid(collab.opt(argv, "--by-child"))
    bmj = ticket_fs.read_meta_json(by)
    if bmj.get("parent") != pid:
        raise collab.CollabError(f"{by} is not a child of {pid}")
    if bmj.get("split_from"):
        raise collab.CollabError(f"{by} was split from {bmj['split_from']}; split-born children cannot split again")
    bmeta, _ = ticket_fs.read_ticket(by)
    scope = collab.csv(collab.opt(argv, "--scope"))
    if not within(scope, bmj.get("scope") or []):
        raise collab.CollabError(f"--scope {scope or '(whole repo)'} is not inside {by}'s scope {bmj.get('scope')}")
    queued = sum(len(p["items"]) for p in pending(pid))
    if len(collab.children_of(pid)) + queued >= MAX_CHILDREN:
        raise collab.CollabError(f"{pid} already has {MAX_CHILDREN} children (incl. pending proposals)")
    item = {"key": "s1", "to": bmeta.get("to"), "title": collab.opt(argv, "--title"),
            "observed": collab.opt(argv, "--observed"), "assumed": collab.opt(argv, "--assumed"),
            "scope": scope, "depends_on": collab.csv(collab.opt(argv, "--depends-on"))}
    errs = validate([item], set(collab.children_of(pid)))
    if errs:
        raise collab.CollabError("; ".join(errs))
    prop = record(pid, {"origin": "split", "by": by, "reason": collab.opt(argv, "--reason"), "items": [item]})
    collab.progress(pid, "split_proposed", f"{by} proposes '{item['title']}' — needs user confirmation "
                    f"(`ticket fanout approve --parent {pid} --proposal {prop['id']}`)")
    return {"parent": pid, "proposal": prop}


def parked(pid: str) -> bool:
    """Parent parked by the scheduler only because splits await review."""
    return ticket_fs.read_ticket(pid)[0].get("phase") == "split_review"


def take(pid: str, prop_id: str | None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    props = load(pid)
    for p in props:
        if p["id"] == prop_id:
            if p["status"] != "pending":
                raise collab.CollabError(f"{prop_id} is already {p['status']}")
            return props, p
    raise collab.CollabError(f"no proposal {prop_id!r} on {pid}")


def cmd_approve(argv: list[str]) -> dict[str, Any]:
    pid = collab.observe_tid(collab.opt(argv, "--parent"))
    props, prop = take(pid, collab.opt(argv, "--proposal"))
    only = collab.csv(collab.opt(argv, "--only"))
    items = [i for i in prop["items"] if not only or i["key"] in only]
    keys = {i["key"] for i in items}
    dropped = [d for i in items for d in i.get("depends_on") or [] if d not in keys and d in
               {x["key"] for x in prop["items"]}]
    if dropped:
        raise collab.CollabError(f"--only leaves out children others depend on: {sorted(set(dropped))}")
    if len(collab.children_of(pid)) + len(items) > MAX_CHILDREN:
        raise collab.CollabError(f"approving would exceed {MAX_CHILDREN} children")
    order = collab.topo_order([i["key"] for i in items],
                              {i["key"]: [d for d in i.get("depends_on") or [] if d in keys] for i in items})
    by_key = {i["key"]: i for i in items}
    created: dict[str, str] = {}
    for k in order:
        i = by_key[k]
        deps = [created.get(d, d) for d in i.get("depends_on") or []]
        args = ["--parent", pid, "--to", i["to"], "--title", i["title"], "--observed", i["observed"],
                "--assumed", i["assumed"]]
        args += ["--scope", ",".join(i["scope"])] if i.get("scope") else []
        args += ["--depends-on", ",".join(deps)] if deps else []
        cid = collab.cmd_add(args)["id"]
        created[k] = cid
        if prop["origin"] == "split":
            mj = ticket_fs.read_meta_json(cid)
            mj["split_from"] = prop["by"]
            ticket_fs.write_meta_json(cid, mj)
    prop.update({"status": "approved", "created": created, "decided_at": ticket_fs.now_iso(),
                 "skipped": [i["key"] for i in prop["items"] if i["key"] not in keys]})
    save(pid, props)
    collab.event(pid, "proposal_approved", proposal=prop["id"], origin=prop["origin"], created=created)
    if prop["origin"] == "draft" or (parked(pid) and not pending(pid)):
        collab.set_status(pid, "in_progress", owner="initiator", phase="planning")
    res: dict[str, Any] = {"parent": pid, "proposal": prop["id"], "created": created}
    if "--run" not in argv:
        return {**res, "next": f"ticket fanout run --parent {pid} --detach"}
    if collab.cmd_status(["--parent", pid])["scheduler"]["alive"]:
        return {**res, "scheduler": "already_running"}  # it re-reads children every tick
    if pending(pid, "draft"):
        return {**res, "scheduler": "draft_pending"}
    extra = ["--mock"] if "--mock" in argv else []
    extra += ["--backend", collab.opt(argv, "--backend") or "claude"]
    return {**res, "scheduler": collab.cmd_run(["--parent", pid, "--detach", *extra])}


def cmd_reject(argv: list[str]) -> dict[str, Any]:
    pid = collab.observe_tid(collab.opt(argv, "--parent"))
    reason = collab.opt(argv, "--reason")
    if not reason:
        raise collab.CollabError("reject needs --reason")
    props, prop = take(pid, collab.opt(argv, "--proposal"))
    prop.update({"status": "rejected", "reason": reason, "decided_at": ticket_fs.now_iso()})
    save(pid, props)
    collab.event(pid, "proposal_rejected", proposal=prop["id"], origin=prop["origin"], reason=reason)
    if prop["origin"] == "draft":
        collab.set_status(pid, "waiting_initiator", owner="human", phase="plan_rejected")
    elif parked(pid) and not pending(pid):
        collab.set_status(pid, "in_progress", owner="initiator", phase="planning")
    return {"parent": pid, "proposal": prop["id"], "status": "rejected"}


def cmd_proposals(argv: list[str]) -> dict[str, Any]:
    pid = collab.observe_tid(collab.opt(argv, "--parent"))
    return {"parent": pid, "proposals": pending(pid) if "--pending" in argv else load(pid)}
