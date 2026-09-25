#!/usr/bin/env bash
# Lifecycle: prepare worker cwd, run, inbox, claim/release/reply (Mode 2 vs 3).
# Sourced by run.sh. shellcheck shell=bash

# Ensure worker claim + worktree; prints worktree path (may be empty under mock).
# Args: id backend no_worktree [steal=0|1]
delegate_prepare_worker_cwd() {
  local id=$1 backend=$2 no_worktree=$3 steal=${4:-0}
  local root title to_key to_path wt_path claim_args claim_out
  root="$(delegate_tickets_root)"
  claim_args=(--id "$id" --by "worker-${backend}" --lease-hours 2 --as-worker)
  ((steal)) && claim_args+=(--steal)
  claim_out="$(cmd_claim "${claim_args[@]}")" || {
    printf '%s\n' "$claim_out" >&2
    delegate_die "worker claim failed for $id (session lease held? use run --steal, or develop in the claiming TUI)" 3
  }
  to_key="$(awk -F': ' '/^to:/{print $2; exit}' "$root/_data/$id/ticket.md" | tr -d '"')"
  title="$(awk -F': ' '/^title:/{sub(/^title:[[:space:]]*/,""); gsub(/^"|"$/,""); print; exit}' "$root/_data/$id/ticket.md")"
  to_path="$(delegate_target_path "$to_key")"
  wt_path=""
  if ((no_worktree)) || [[ "${DELEGATE_WORKER_MOCK:-0}" == "1" && "${DELEGATE_FORCE_WORKTREE:-0}" != "1" ]]; then
    delegate_log "skip worktree (mock/no-worktree)"
  else
    # reuse meta.worktree when present
    wt_path="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("worktree") or "")' \
      "$root/_data/$id/meta.json" 2>/dev/null || true)"
    if [[ -z "$wt_path" || ! -d "$wt_path" ]]; then
      wt_path="$(delegate_ensure_worktree "$to_path" "$id" "$title")"
    fi
    env DELEGATE_TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" ID="$id" WT="$wt_path" BR="${DELEGATE_WORKTREE_BRANCH:-}" python3 - <<'PY'
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
      *) delegate_die "unknown run arg: $1" ;;
    esac
  done
  [[ -n "$id" ]] || delegate_die "run requires --id"
  case "$phase" in
    research|implement|auto) ;;
    *) delegate_die "unsupported --phase $phase (research|implement|auto)" ;;
  esac

  delegate_ensure_tree
  ((mock)) && export DELEGATE_WORKER_MOCK=1

  local root wt_path apply_json impl_json
  root="$(delegate_tickets_root)"
  [[ -f "$root/_data/$id/ticket.md" ]] || delegate_die "ticket not found: $id" 2

  wt_path="$(delegate_prepare_worker_cwd "$id" "$backend" "$no_worktree" "$steal")"

  if [[ "$phase" == "research" || "$phase" == "auto" ]]; then
    apply_json="$(delegate_worker_research "$id" "$wt_path" "$backend")"
    apply_json="$(python3 -c 'import json,sys; a=json.loads(sys.argv[1]); a["worktree"]=sys.argv[2] or None; print(json.dumps(a,ensure_ascii=False))' \
      "$apply_json" "${wt_path:-}")"
    printf '%s\n' "$apply_json"
    # accept → no objection → start implement immediately
    if [[ "$phase" == "auto" ]]; then
      local next_action
      next_action="$(printf '%s' "$apply_json" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("next_action") or "")')"
      if [[ "$next_action" == "implement" ]]; then
        delegate_log "research accept → auto implement"
        impl_json="$(delegate_worker_implement "$id" "$wt_path" "$backend")"
        python3 -c 'import json,sys; a=json.loads(sys.argv[1]); a["worktree"]=sys.argv[2] or None; a["auto_implement"]=True; print(json.dumps(a,ensure_ascii=False))' \
          "$impl_json" "${wt_path:-}"
      else
        delegate_log "research needs initiator ($next_action) — watch / reply before implement"
      fi
    fi
    return 0
  fi

  # phase=implement
  impl_json="$(delegate_worker_implement "$id" "$wt_path" "$backend")"
  python3 -c 'import json,sys; a=json.loads(sys.argv[1]); a["worktree"]=sys.argv[2] or None; print(json.dumps(a,ensure_ascii=False))' \
    "$impl_json" "${wt_path:-}"
}
cmd_inbox() {
  local to="."
  while (($#)); do
    case "$1" in
      --to) to=$2; shift 2 ;;
      *) delegate_die "unknown inbox arg: $1" ;;
    esac
  done
  delegate_ensure_tree
  local key
  key="$(delegate_resolve_target_key "$to")"
  env DELEGATE_TICKETS_ROOT="$(delegate_tickets_root)" TOOL_ROOT="$TOOL_ROOT" TO_KEY="$key" python3 - <<'PY'
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
    })
print(json.dumps({"ok": True, "to": os.environ["TO_KEY"], "count": len(out), "tickets": out}, ensure_ascii=False, indent=2))
PY
}

cmd_claim() {
  local id="" by="${USER:-agent}" lease_hours=2 as_worker=0 steal=0
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      --by) by=$2; shift 2 ;;
      --lease-hours) lease_hours=$2; shift 2 ;;
      --as-worker) as_worker=1; shift ;;
      --steal) steal=1; shift ;;
      *) delegate_die "unknown claim arg: $1" ;;
    esac
  done
  [[ -n "$id" ]] || delegate_die "claim requires --id"
  # Headless workers always pass --as-worker; bare claim = main-session develop.
  if ((as_worker == 0)) && [[ "$by" == worker-* ]]; then
    as_worker=1
  fi
  delegate_ensure_tree
  local root lock
  root="$(delegate_tickets_root)"
  lock="$root/.locks/tickets.lock"
  delegate_with_lock "$lock" -- \
    env DELEGATE_TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" \
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

cmd_release() {
  local id=""
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      *) delegate_die "unknown release arg: $1" ;;
    esac
  done
  [[ -n "$id" ]] || delegate_die "release requires --id"
  delegate_ensure_tree
  local root lock
  root="$(delegate_tickets_root)"
  lock="$root/.locks/tickets.lock"
  delegate_with_lock "$lock" -- \
    env DELEGATE_TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" ID="$id" python3 - <<'PY'
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
meta["status"] = "submitted"
meta["owner"] = "worker"
meta["claimed_by"] = None
meta["lease_until"] = None
mj = mod.read_meta_json(tid)
mj["lease_until_epoch"] = None
mj["claimed_by"] = None
mod.write_ticket(tid, meta, body)
mod.write_meta_json(tid, mj)
mod.append_event(tid, {"type": "released"})
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
      *) delegate_die "unknown reply arg: $1" ;;
    esac
  done
  [[ -n "$id" && -n "$decision" ]] || delegate_die "reply requires --id and --decision"
  delegate_ensure_tree
  local root lock
  root="$(delegate_tickets_root)"
  lock="$root/.locks/tickets.lock"
  reply_json="$(
  delegate_with_lock "$lock" -- \
    env DELEGATE_TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" \
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
mod.append_event(tid, {"type": "reply", "decision": decision, "status": status, "phase": meta.get("phase"), "owner": meta.get("owner")})
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
      delegate_die "reply --continue refused: ticket is session-claimed (owner=human). Target TUI should implement; use run --steal only to forcibly dispatch headless." 3
    fi
    local run_args=(--id "$id" --phase implement --backend "$backend")
    ((mock)) && run_args+=(--mock)
    cmd_run "${run_args[@]}"
  fi
}

# Watch loop for a blocked initiator: poll ticket and auto-continue when the
# ball returns to the worker (approved_to_implement / research_done accept).
