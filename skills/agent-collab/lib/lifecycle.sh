#!/usr/bin/env bash
# Lifecycle: prepare worker cwd, run, inbox, claim/release/reply (Mode 2 vs 3).
# Sourced by run.sh. shellcheck shell=bash

# Ensure worker claim + worktree; prints worktree path (may be empty under mock).
# Args: id backend no_worktree [steal=0|1]
ticket_prepare_worker_cwd() {
  local id=$1 backend=$2 no_worktree=$3 steal=${4:-0}
  local root title to_key to_path wt_path claim_args claim_out
  root="$(ticket_store_root)"
  claim_args=(--id "$id" --by "worker-${backend}" --lease-hours 2 --as-worker)
  ((steal)) && claim_args+=(--steal)
  claim_out="$(cmd_claim "${claim_args[@]}")" || {
    printf '%s\n' "$claim_out" >&2
    ticket_die "worker claim failed for $id (session lease held? use run --steal, or develop in the claiming TUI)" 3
  }
  to_key="$(awk -F': ' '/^to:/{print $2; exit}' "$root/_data/$id/ticket.md" | tr -d '"')"
  title="$(awk -F': ' '/^title:/{sub(/^title:[[:space:]]*/,""); gsub(/^"|"$/,""); print; exit}' "$root/_data/$id/ticket.md")"
  to_path="$(ticket_target_path "$to_key")"
  wt_path=""
  if ((no_worktree)) || [[ "${TICKET_WORKER_MOCK:-0}" == "1" && "${TICKET_FORCE_WORKTREE:-0}" != "1" ]]; then
    ticket_log "skip worktree (mock/no-worktree)"
  else
    # reuse meta.worktree when present
    wt_path="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("worktree") or "")' \
      "$root/_data/$id/meta.json" 2>/dev/null || true)"
    if [[ -z "$wt_path" || ! -d "$wt_path" ]]; then
      wt_path="$(ticket_ensure_worktree "$to_path" "$id" "$title")"
    fi
    # ticket_ensure_worktree ran in $(…), so its TICKET_WORKTREE_BRANCH never reached us: read it back
    env TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" ID="$id" WT="$wt_path" \
      BR="$(git -C "$wt_path" rev-parse --abbrev-ref HEAD 2>/dev/null || true)" python3 - <<'PY'
import importlib.util, os
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
tid = os.environ["ID"]
mj = mod.read_meta_json(tid)
mj["worktree"] = os.environ.get("WT") or None
mj["branch"] = os.environ.get("BR") or None
mod.write_meta_json(tid, mj)
mod.append_event(tid, {"type": "worktree_ready", "worktree": mj["worktree"], "branch": mj["branch"]})
mod.write_progress(
    tid,
    "worktree_ready",
    f"worktree ready: {mj.get('worktree') or '(none)'}",
    extra={"worktree": mj.get("worktree"), "branch": mj.get("branch")},
)
PY
  fi
  printf '%s\n' "$wt_path"
}

cmd_run() {
  local id="" phase="auto" backend="claude" mock=0 no_worktree=0 steal=0
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      --phase) phase=$2; shift 2 ;;
      --backend) backend=$2; shift 2 ;;
      --mock) mock=1; shift ;;
      --no-worktree) no_worktree=1; shift ;;
      --steal) steal=1; shift ;;
      *) ticket_die "unknown run arg: $1" ;;
    esac
  done
  [[ -n "$id" ]] || ticket_die "run requires --id"
  case "$phase" in
    research|implement|auto) ;;
    *) ticket_die "unsupported --phase $phase (research|implement|auto)" ;;
  esac

  ticket_ensure_tree
  ((mock)) && export TICKET_WORKER_MOCK=1

  local root wt_path apply_json impl_json
  root="$(ticket_store_root)"
  [[ -f "$root/_data/$id/ticket.md" ]] || ticket_die "ticket not found: $id" 2

  # Standalone runs share the fan-out pool + memory budget (lib/gate.py);
  # a scheduler's child is already gated, and the gated re-run must not loop.
  if [[ "${TICKET_RUN_GATED:-0}" != 1 && -z "${TICKET_PARENT_SCHEDULER:-}" && "${TICKET_RUN_GATE:-1}" != 0 ]]; then
    local again=(--id "$id" --phase "$phase" --backend "$backend")
    ((mock)) && again+=(--mock)
    ((no_worktree)) && again+=(--no-worktree)
    ((steal)) && again+=(--steal)
    python3 "$TOOL_ROOT/lib/gate.py" --id "$id" --backend "$backend" -- "$TOOL_ROOT/run.sh" run "${again[@]}"
    return
  fi

  wt_path="$(ticket_prepare_worker_cwd "$id" "$backend" "$no_worktree" "$steal")"

  if [[ "$phase" == "research" || "$phase" == "auto" ]]; then
    apply_json="$(ticket_worker_research "$id" "$wt_path" "$backend")"
    apply_json="$(python3 -c 'import json,sys; a=json.loads(sys.argv[1]); a["worktree"]=sys.argv[2] or None; print(json.dumps(a,ensure_ascii=False))' \
      "$apply_json" "${wt_path:-}")"
    printf '%s\n' "$apply_json"
    # accept → no objection → start implement immediately
    if [[ "$phase" == "auto" ]]; then
      local next_action
      next_action="$(printf '%s' "$apply_json" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("next_action") or "")')"
      if [[ "$next_action" == "implement" ]]; then
        ticket_log "research accept → auto implement"
        impl_json="$(ticket_worker_implement "$id" "$wt_path" "$backend")"
        python3 -c 'import json,sys; a=json.loads(sys.argv[1]); a["worktree"]=sys.argv[2] or None; a["auto_implement"]=True; print(json.dumps(a,ensure_ascii=False))' \
          "$impl_json" "${wt_path:-}"
      else
        ticket_log "research needs initiator ($next_action) — watch / reply before implement"
      fi
    fi
    return 0
  fi

  # phase=implement
  impl_json="$(ticket_worker_implement "$id" "$wt_path" "$backend")"
  python3 -c 'import json,sys; a=json.loads(sys.argv[1]); a["worktree"]=sys.argv[2] or None; print(json.dumps(a,ensure_ascii=False))' \
    "$impl_json" "${wt_path:-}"
}
cmd_inbox() {
  local to="."
  while (($#)); do
    case "$1" in
      --to) to=$2; shift 2 ;;
      *) ticket_die "unknown inbox arg: $1" ;;
    esac
  done
  ticket_ensure_tree
  local key
  key="$(ticket_resolve_target_key "$to")"
  env TICKETS_ROOT="$(ticket_store_root)" TOOL_ROOT="$TOOL_ROOT" TO_KEY="$key" python3 - <<'PY'
import importlib.util, json, os
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.reindex()
items = mod.list_inbox(os.environ["TO_KEY"])
out = []
for it in items:
    m = it["meta"]
    out.append({
        "id": it["id"],
        "title": m.get("title"),
        "from": m.get("from"),
        "status": m.get("status"),
        "owner": m.get("owner"),
        "summary": m.get("summary"),
        "updated_at": m.get("updated_at"),
        "parent": mod.read_meta_json(it["id"]).get("parent"),
        "blocked_by": mod.deps_pending(it["id"]),
    })
print(json.dumps({"ok": True, "to": os.environ["TO_KEY"], "count": len(out), "tickets": out}, ensure_ascii=False, indent=2))
PY
}

# Session claims develop in cwd, so cwd must belong to the ticket's target repo
# (primary or any linked worktree). Dies with exit 3 otherwise.
ticket_require_target_cwd() {
  local id=$1 root to_key here_key
  root="$(ticket_store_root)"
  [[ -f "$root/_data/$id/ticket.md" ]] || return 0  # not-found is reported by the caller
  to_key="$(awk -F': ' '/^to:/{print $2; exit}' "$root/_data/$id/ticket.md" | tr -d '"')"
  here_key="$(ticket_resolve_target_key . 2>/dev/null)" || here_key=""
  if [[ "$here_key" != "$to_key" ]]; then
    printf '{"ok":false,"error":"wrong cwd","to":"%s","cwd_target":"%s","cwd":"%s","hint":"session claim develops in cwd: cd into %s (primary or a dev-* worktree) or let a Mode 3 worker take it; --any-cwd overrides"}\n' \
      "$to_key" "${here_key:-none}" "$PWD" "$(ticket_target_path "$to_key" 2>/dev/null || printf '%s' "$to_key")" >&2
    exit 3
  fi
}

cmd_claim() {
  local id="" by="" lease_hours=2 as_worker=0 steal=0 any_cwd=0
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      --by) by=$2; shift 2 ;;
      --lease-hours) lease_hours=$2; shift 2 ;;
      --as-worker) as_worker=1; shift ;;
      --steal) steal=1; shift ;;
      --any-cwd) any_cwd=1; shift ;;
      *) ticket_die "unknown claim arg: $1" ;;
    esac
  done
  [[ -n "$id" ]] || ticket_die "claim requires --id"
  [[ -n "$by" ]] || by="$(ticket_session_identity)"
  # Headless workers always pass --as-worker; bare claim = main-session develop.
  if ((as_worker == 0)) && [[ "$by" == worker-* ]]; then
    as_worker=1
  fi
  ticket_ensure_tree
  ((as_worker || any_cwd)) || ticket_require_target_cwd "$id"
  local root lock
  root="$(ticket_store_root)"
  lock="$root/.locks/tickets.lock"
  ticket_with_lock "$lock" -- \
    env TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" \
      ID="$id" BY="$by" LEASE_HOURS="$lease_hours" \
      AS_WORKER="$as_worker" STEAL="$steal" python3 - <<'PY'
import importlib.util, json, os, sys, time
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

tid = os.environ["ID"]
by = os.environ["BY"]
hours = float(os.environ.get("LEASE_HOURS") or 2)
as_worker = os.environ.get("AS_WORKER") == "1"
steal = os.environ.get("STEAL") == "1"
mode = "worker" if as_worker else "session"
try:
    meta, body = mod.read_ticket(tid)
except FileNotFoundError as e:
    print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
    sys.exit(2)

mj = mod.read_meta_json(tid)
lease_until = mj.get("lease_until_epoch")
claimed_by = meta.get("claimed_by") or mj.get("claimed_by")
lease_active = (
    meta.get("status") == "in_progress"
    and isinstance(lease_until, int)
    and lease_until > mod.now_epoch()
)
pending = mod.deps_pending(tid)
if pending and not steal:
    print(json.dumps({
        "ok": False,
        "error": "deps pending",
        "blocked_by": pending,
        "hint": "fan-out child: its depends_on tickets must ship first; pick another ready child (inbox shows blocked_by)",
    }, ensure_ascii=False))
    sys.exit(3)
if lease_active and claimed_by and claimed_by != by and not steal:
    print(json.dumps({
        "ok": False,
        "error": "lease held",
        "claimed_by": claimed_by,
        "owner": meta.get("owner"),
        "mode": "session" if meta.get("owner") == "human" else "worker",
        "lease_until_epoch": lease_until,
        "hint": "session claim means develop in that TUI; do not run/worktree. Use --steal only to forcibly dispatch a headless worker.",
    }, ensure_ascii=False))
    sys.exit(3)

gen = int(mj.get("claim_gen") or meta.get("claim_gen") or 0) + 1
until = mod.now_epoch() + int(hours * 3600)
meta["status"] = "in_progress"
meta["owner"] = "worker" if as_worker else "human"
meta["phase"] = "claim" if as_worker else "session"
meta["claimed_by"] = by
meta["claim_gen"] = gen
meta["lease_until"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(until))
mj["claim_gen"] = gen
mj["claimed_by"] = by
mj["lease_until_epoch"] = until
mod.write_ticket(tid, meta, body)
mod.write_meta_json(tid, mj)
mod.append_event(tid, {
    "type": "claimed",
    "by": by,
    "mode": mode,
    "claim_gen": gen,
    "lease_until_epoch": until,
    "stolen": steal and bool(claimed_by) and claimed_by != by,
})
mod.reindex()
print(json.dumps({
    "ok": True,
    "id": tid,
    "status": "in_progress",
    "owner": meta["owner"],
    "mode": mode,
    "phase": meta["phase"],
    "claimed_by": by,
    "claim_gen": gen,
    "lease_until": meta["lease_until"],
    "hint": (
        "headless worker path"
        if as_worker
        else "session claim: develop in this TUI/cwd; do NOT run.sh run / create worktree"
    ),
}, ensure_ascii=False))
PY
}

# release / renew act on the caller's own lease. Another holder's live lease is
# refused (exit 3) unless --force; an expired lease is free for anyone.
cmd_release() { ticket_lease_op release "$@"; }
cmd_renew() { ticket_lease_op renew "$@"; }

ticket_lease_op() {
  local op=$1 id="" by="" lease_hours=2 force=0
  shift
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      --by) by=$2; shift 2 ;;
      --lease-hours) lease_hours=$2; shift 2 ;;
      --force) force=1; shift ;;
      *) ticket_die "unknown $op arg: $1" ;;
    esac
  done
  [[ -n "$id" ]] || ticket_die "$op requires --id"
  [[ -n "$by" ]] || by="$(ticket_session_identity)"
  ticket_ensure_tree
  local root lock
  root="$(ticket_store_root)"
  lock="$root/.locks/tickets.lock"
  ticket_with_lock "$lock" -- \
    env TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" ID="$id" OP="$op" BY="$by" \
      LEASE_HOURS="$lease_hours" FORCE="$force" python3 - <<'PY'
import importlib.util, json, os, sys, time
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
tid, op, by = os.environ["ID"], os.environ["OP"], os.environ["BY"]
force = os.environ.get("FORCE") == "1"
try:
    meta, body = mod.read_ticket(tid)
except FileNotFoundError as e:
    print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
    sys.exit(2)
mj = mod.read_meta_json(tid)
holder = meta.get("claimed_by") or mj.get("claimed_by")
lease_until = mj.get("lease_until_epoch")
live = isinstance(lease_until, int) and lease_until > mod.now_epoch()

if op == "renew":
    # Only the holder extends; an expired lease is renewable only while nobody re-claimed it.
    if holder != by or meta.get("status") != "in_progress":
        print(json.dumps({"ok": False, "error": "not lease holder", "claimed_by": holder,
                          "status": meta.get("status"), "by": by,
                          "hint": "claim first (or the ticket is not in_progress)"}, ensure_ascii=False))
        sys.exit(3)
    until = mod.now_epoch() + int(float(os.environ.get("LEASE_HOURS") or 2) * 3600)
    meta["lease_until"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(until))
    mj["lease_until_epoch"] = until
    mod.write_ticket(tid, meta, body)
    mod.write_meta_json(tid, mj)
    mod.append_event(tid, {"type": "renewed", "by": by, "lease_until_epoch": until})
    mod.reindex()
    print(json.dumps({"ok": True, "id": tid, "claimed_by": by, "lease_until": meta["lease_until"]}, ensure_ascii=False))
    sys.exit(0)

if live and holder and holder != by and not force:
    print(json.dumps({"ok": False, "error": "lease held", "claimed_by": holder, "by": by,
                      "lease_until_epoch": lease_until,
                      "hint": "only the holder releases a live lease; --force overrides"}, ensure_ascii=False))
    sys.exit(3)
meta["status"] = "submitted"
meta["owner"] = "worker"
meta["claimed_by"] = None
meta["lease_until"] = None
mj["lease_until_epoch"] = None
mj["claimed_by"] = None
mod.write_ticket(tid, meta, body)
mod.write_meta_json(tid, mj)
mod.append_event(tid, {"type": "released", "by": by, "forced": bool(force and live and holder and holder != by)})
mod.reindex()
print(json.dumps({"ok": True, "id": tid, "status": "submitted"}, ensure_ascii=False))
PY
}

cmd_reply() {
  local id="" decision="" status="waiting_target" do_continue=0 backend="claude" mock=0
  local reply_json
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      --decision) decision=$2; shift 2 ;;
      --status) status=$2; shift 2 ;;
      --continue) do_continue=1; shift ;;
      --backend) backend=$2; shift 2 ;;
      --mock) mock=1; shift ;;
      *) ticket_die "unknown reply arg: $1" ;;
    esac
  done
  [[ -n "$id" && -n "$decision" ]] || ticket_die "reply requires --id and --decision"
  ticket_ensure_tree
  local root lock
  root="$(ticket_store_root)"
  lock="$root/.locks/tickets.lock"
  reply_json="$(
  ticket_with_lock "$lock" -- \
    env TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" \
      ID="$id" DECISION="$decision" STATUS="$status" python3 - <<'PY'
import importlib.util, json, os, sys, re
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
tid = os.environ["ID"]
decision = os.environ["DECISION"]
status = os.environ["STATUS"]
try:
    meta, body = mod.read_ticket(tid)
except FileNotFoundError as e:
    print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
    sys.exit(2)

stamp = mod.now_iso()
if re.search(r"^## Decision\s*$", body, re.M):
    body = re.sub(
        r"^## Decision\s*\n(?:.*\n)*?(?=^## |\Z)",
        lambda _m: f"## Decision\n\n_{stamp}_\n\n{decision}\n\n",
        body,
        count=1,
        flags=re.M,
    )
else:
    body = body.rstrip() + f"\n\n## Decision\n\n_{stamp}_\n\n{decision}\n"

thread_line = f"\n- ({stamp}) initiator: {decision}\n"
if "## Thread" in body:
    body = body.replace("## Thread", "## Thread" + thread_line, 1)
else:
    body += "\n## Thread\n" + thread_line

claimed_by = str(meta.get("claimed_by") or "")
session_claim = bool(claimed_by) and not claimed_by.startswith("worker-")
meta["status"] = status
if status in ("waiting_target", "in_progress", "submitted"):
    # Preserve session claim so target TUI continues; worker path stays worker.
    meta["owner"] = "human" if session_claim else "worker"
    meta["phase"] = "approved_to_implement"
else:
    meta["owner"] = "initiator"
mod.write_ticket(tid, meta, body)
answered = mod.archive_questions(tid, decision)
mod.append_event(tid, {"type": "reply", "decision": decision, "status": status, "phase": meta.get("phase"), "owner": meta.get("owner"), "answered_questions": answered})
mod.reindex()
next_action = "implement" if meta.get("phase") == "approved_to_implement" else "none"
if session_claim and next_action == "implement":
    next_action = "session_implement"
print(json.dumps({
    "ok": True,
    "id": tid,
    "status": status,
    "owner": meta["owner"],
    "phase": meta.get("phase"),
    "claimed_by": claimed_by or None,
    "next_action": next_action,
    "hint": (
        "session claim: target TUI should implement; do not --continue / run"
        if session_claim and status in ("waiting_target", "in_progress")
        else None
    ),
}, ensure_ascii=False))
PY
  )"
  printf '%s\n' "$reply_json"

  if ((do_continue)); then
    local owner next_action
    owner="$(printf '%s' "$reply_json" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("owner") or "")')"
    next_action="$(printf '%s' "$reply_json" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("next_action") or "")')"
    if [[ "$owner" == "human" || "$next_action" == "session_implement" ]]; then
      ticket_die "reply --continue refused: ticket is session-claimed (owner=human). Target TUI should implement; use run --steal only to forcibly dispatch headless." 3
    fi
    local run_args=(--id "$id" --phase implement --backend "$backend")
    ((mock)) && run_args+=(--mock)
    cmd_run "${run_args[@]}"
  fi
}

cmd_set_from() {
  local id="" from=""
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      --from) from=$2; shift 2 ;;
      *) ticket_die "unknown set-from arg: $1" ;;
    esac
  done
  [[ -n "$id" && -n "$from" ]] || ticket_die "set-from requires --id --from"
  ticket_ensure_tree
  local from_key root lock
  from_key="$(ticket_resolve_source_key "$from")"
  root="$(ticket_store_root)"
  lock="$root/.locks/tickets.lock"
  ticket_with_lock "$lock" -- \
    env TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" \
      ID="$id" NEW_FROM="$from_key" python3 - <<'PY'
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
tid = os.environ["ID"]
try:
    meta, body = mod.read_ticket(tid)
except FileNotFoundError as e:
    print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
    sys.exit(2)
old_from = meta.get("from")
new_from = os.environ["NEW_FROM"]
meta["from"] = new_from
meta["updated_at"] = mod.now_iso()
mod.write_ticket(tid, meta, body)
mod.reindex()
if old_from != new_from:
    mod.append_event(tid, {"type": "from_changed", "old_from": old_from, "new_from": new_from})
print(json.dumps({"ok": True, "id": tid, "old_from": old_from, "from": new_from}, ensure_ascii=False))
PY
}

cmd_set_handler() {
  local id="" repo="" cwd="" session="" via="" clear=0
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      --repo) repo=$2; shift 2 ;;
      --cwd) cwd=$2; shift 2 ;;
      --session) session=$2; shift 2 ;;
      --via) via=$2; shift 2 ;;
      --clear) clear=1; shift ;;
      *) ticket_die "unknown set-handler arg: $1" ;;
    esac
  done
  [[ -n "$id" ]] || ticket_die "set-handler requires --id"
  ticket_ensure_tree
  local repo_key="" root lock
  if ((clear == 0)) && [[ -n "$repo" ]]; then
    repo_key="$(ticket_resolve_source_key "$repo")"
  fi
  root="$(ticket_store_root)"
  lock="$root/.locks/tickets.lock"
  ticket_with_lock "$lock" -- \
    env TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" \
      ID="$id" REPO="$repo_key" CWD="$cwd" SESSION="$session" VIA="$via" CLEAR="$clear" python3 - <<'PY'
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
tid = os.environ["ID"]
try:
    meta, body = mod.read_ticket(tid)
except FileNotFoundError as e:
    print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
    sys.exit(2)
if os.environ.get("CLEAR") == "1":
    h = mod.record_handler(tid, None)
else:
    h = mod.detect_handler(
        repo=os.environ.get("REPO") or None,
        cwd=os.environ.get("CWD") or None,
        session=os.environ.get("SESSION") or None,
        via=os.environ.get("VIA") or None,
    )
    h = mod.record_handler(tid, h)
meta["updated_at"] = mod.now_iso()
mod.write_ticket(tid, meta, body)
print(json.dumps({"ok": True, "id": tid, "handler": h}, ensure_ascii=False))
PY
}

# Watch loop for a blocked initiator: poll ticket and auto-continue when the
# ball returns to the worker (approved_to_implement / research_done accept).
