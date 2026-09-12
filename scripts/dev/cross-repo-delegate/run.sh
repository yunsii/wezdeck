#!/usr/bin/env bash
# Cross-repo delegate tickets — MVP runner.
#
# Usage:
#   run.sh init | install-cli
#   run.sh create --to TARGET --from SOURCE --title TITLE \
#     --observed TEXT --assumed TEXT [--snippet-ref REF] [--summary TEXT] [--source-pr REF] \
#     [--run] [--backend claude|codex|grok] [--mock]
#   run.sh run --id ID [--phase research|implement|auto] [--backend …] [--mock] [--no-worktree]
#       auto = research then implement if verdict=accept (default for create --run)
#   run.sh watch --id ID [--interval SEC] [--once] [--max-rounds N] [--backend …] [--mock]
#       poll until terminal / blocked on human; auto-continue implement when approved
#   run.sh inbox [--to TARGET|.]
#   run.sh show --id ID
#   run.sh next [--to TARGET|.] [--id ID]
#   run.sh claim --id ID [--by WHO] [--lease-hours N]
#   run.sh release --id ID
#   run.sh challenge --id ID --measured TEXT --impact TEXT --recommended TEXT \
#     [--original TEXT] [--needs TEXT]
#   run.sh reply --id ID --decision TEXT [--status waiting_target|in_progress]
#   run.sh set-status --id ID --status STATUS [--owner OWNER] [--phase PHASE]
#   run.sh status [--id ID] [--mine] [--from SOURCE]
#   run.sh board [--to TARGET]
#   run.sh close --id ID [--doc PATH] [--no-doc REASON]
#   run.sh walkthrough [--seed]
#   run.sh reindex | selfcheck
#
# Tickets live under ~/.agent/tickets (override: DELEGATE_TICKETS_ROOT).
# create --run / run: auto worktree (delegate-*) + headless research worker.
# DELEGATE_WORKER_MOCK=1 or --mock skips LLM (for tests).
#
# Exit: 0 ok · 1 usage · 2 not found / invalid · 3 lock / conflict
set -euo pipefail

TOOL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$TOOL_ROOT/lib/common.sh"
# shellcheck source=/dev/null
. "$TOOL_ROOT/lib/worktree.sh"
# shellcheck source=/dev/null
. "$TOOL_ROOT/lib/worker.sh"

PY="$TOOL_ROOT/lib/ticket_fs.py"
usage() {
  sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
}

cmd="${1:-}"
[[ -n "$cmd" ]] || { usage; exit 1; }
shift || true

case "$cmd" in
  -h|--help|help) usage; exit 0 ;;
esac

# --- init ---
cmd_init() {
  delegate_ensure_tree
  python3 "$PY" reindex >/dev/null
  printf 'tickets root: %s\n' "$(delegate_tickets_root)"
  printf 'config:       %s/config.yml\n' "$(delegate_tickets_root)"
}

# --- create ---
cmd_create() {
  local to="" from="" title="" observed="" assumed="" snippet="" summary="" source_pr=""
  local do_run=0 backend="claude" mock=0
  while (($#)); do
    case "$1" in
      --to) to=$2; shift 2 ;;
      --from) from=$2; shift 2 ;;
      --title) title=$2; shift 2 ;;
      --observed) observed=$2; shift 2 ;;
      --assumed) assumed=$2; shift 2 ;;
      --snippet-ref) snippet=$2; shift 2 ;;
      --summary) summary=$2; shift 2 ;;
      --source-pr) source_pr=$2; shift 2 ;;
      --run) do_run=1; shift ;;
      --backend) backend=$2; shift 2 ;;
      --mock) mock=1; shift ;;
      *) delegate_die "unknown create arg: $1" ;;
    esac
  done
  [[ -n "$to" && -n "$from" && -n "$title" ]] || delegate_die "create requires --to --from --title"
  [[ -n "$observed" && -n "$assumed" ]] || delegate_die "create requires --observed and --assumed (assumption gate)"

  delegate_ensure_tree
  local to_key from_key to_path from_path
  to_key="$(delegate_resolve_target_key "$to")"
  from_key="$(delegate_resolve_target_key "$from")"
  to_path="$(delegate_target_path "$to_key")"
  from_path="$(delegate_target_path "$from_key")"
  [[ -d "$to_path" ]] || delegate_log "warn: target path missing: $to_path"
  [[ -d "$from_path" ]] || delegate_log "warn: source path missing: $from_path"

  local id root lock create_json
  id="$(delegate_new_id)"
  root="$(delegate_tickets_root)"
  lock="$root/.locks/tickets.lock"

  create_json="$(
  delegate_with_lock "$lock" -- \
    env DELEGATE_TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" \
      ID="$id" TO="$to_key" FROM="$from_key" TITLE="$title" \
      OBSERVED="$observed" ASSUMED="$assumed" SNIPPET="$snippet" \
      SUMMARY="${summary:-$title}" SOURCE_PR="$source_pr" \
      python3 - <<'PY'
import importlib.util, json, os
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

tid = os.environ["ID"]
title = os.environ["TITLE"]
summary = os.environ.get("SUMMARY") or title
snippet = os.environ.get("SNIPPET") or "_none_"
body = f"""# {title}

## Summary

{summary}

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
mod.write_ticket(tid, meta, body)
mod.write_meta_json(tid, {"claim_gen": 0, "worktree": None, "lease_until_epoch": None})
mod.append_event(tid, {"type": "created", "from": meta["from"], "to": meta["to"], "title": title})
counts = mod.reindex()
print(json.dumps({"ok": True, "id": tid, "to": meta["to"], "from": meta["from"], "status": "submitted", "path": str(mod.data_dir(tid)), "reindex": counts}, ensure_ascii=False))
PY
  )"
  printf '%s\n' "$create_json"

  if ((do_run)); then
    local run_args=(--id "$id" --phase auto --backend "$backend")
    ((mock)) && run_args+=(--mock)
    cmd_run "${run_args[@]}"
  fi
}

# Ensure claim + worktree; prints worktree path (may be empty under mock).
delegate_prepare_worker_cwd() {
  local id=$1 backend=$2 no_worktree=$3
  local root title to_key to_path wt_path
  root="$(delegate_tickets_root)"
  cmd_claim --id "$id" --by "worker-${backend}" --lease-hours 2 >/dev/null || true
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
  local id="" phase="auto" backend="claude" mock=0 no_worktree=0
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      --phase) phase=$2; shift 2 ;;
      --backend) backend=$2; shift 2 ;;
      --mock) mock=1; shift ;;
      --no-worktree) no_worktree=1; shift ;;
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

  wt_path="$(delegate_prepare_worker_cwd "$id" "$backend" "$no_worktree")"

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
  local id="" by="${USER:-agent}" lease_hours=2
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      --by) by=$2; shift 2 ;;
      --lease-hours) lease_hours=$2; shift 2 ;;
      *) delegate_die "unknown claim arg: $1" ;;
    esac
  done
  [[ -n "$id" ]] || delegate_die "claim requires --id"
  delegate_ensure_tree
  local root lock
  root="$(delegate_tickets_root)"
  lock="$root/.locks/tickets.lock"
  delegate_with_lock "$lock" -- \
    env DELEGATE_TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" \
      ID="$id" BY="$by" LEASE_HOURS="$lease_hours" python3 - <<'PY'
import importlib.util, json, os, sys, time
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

tid = os.environ["ID"]
by = os.environ["BY"]
hours = float(os.environ.get("LEASE_HOURS") or 2)
try:
    meta, body = mod.read_ticket(tid)
except FileNotFoundError as e:
    print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
    sys.exit(2)

mj = mod.read_meta_json(tid)
lease_until = mj.get("lease_until_epoch")
claimed_by = meta.get("claimed_by") or mj.get("claimed_by")
if meta.get("status") == "in_progress" and isinstance(lease_until, int) and lease_until > mod.now_epoch():
    if claimed_by and claimed_by != by:
        print(json.dumps({"ok": False, "error": "lease held", "claimed_by": claimed_by, "lease_until_epoch": lease_until}, ensure_ascii=False))
        sys.exit(3)

gen = int(mj.get("claim_gen") or meta.get("claim_gen") or 0) + 1
until = mod.now_epoch() + int(hours * 3600)
meta["status"] = "in_progress"
meta["owner"] = "worker"
meta["phase"] = meta.get("phase") or "claim"
meta["claimed_by"] = by
meta["claim_gen"] = gen
meta["lease_until"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(until))
mj["claim_gen"] = gen
mj["claimed_by"] = by
mj["lease_until_epoch"] = until
mod.write_ticket(tid, meta, body)
mod.write_meta_json(tid, mj)
mod.append_event(tid, {"type": "claimed", "by": by, "claim_gen": gen, "lease_until_epoch": until})
mod.reindex()
print(json.dumps({"ok": True, "id": tid, "status": "in_progress", "claimed_by": by, "claim_gen": gen, "lease_until": meta["lease_until"]}, ensure_ascii=False))
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
        f"## Decision\n\n_{stamp}_\n\n{decision}\n\n",
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

meta["status"] = status
if status in ("waiting_target", "in_progress", "submitted"):
    meta["owner"] = "worker"
    meta["phase"] = "approved_to_implement"
else:
    meta["owner"] = "initiator"
mod.write_ticket(tid, meta, body)
mod.append_event(tid, {"type": "reply", "decision": decision, "status": status, "phase": meta.get("phase")})
mod.reindex()
print(json.dumps({"ok": True, "id": tid, "status": status, "owner": meta["owner"], "phase": meta.get("phase"), "next_action": "implement" if meta.get("phase") == "approved_to_implement" else "none"}, ensure_ascii=False))
PY

  if ((do_continue)); then
    local run_args=(--id "$id" --phase implement --backend "$backend")
    ((mock)) && run_args+=(--mock)
    cmd_run "${run_args[@]}"
  fi
}

# Watch loop for a blocked initiator: poll ticket and auto-continue when the
# ball returns to the worker (approved_to_implement / research_done accept).
cmd_watch() {
  local id="" interval=20 once=0 max_rounds=60 backend="claude" mock=0
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      --interval) interval=$2; shift 2 ;;
      --once) once=1; shift ;;
      --max-rounds) max_rounds=$2; shift 2 ;;
      --backend) backend=$2; shift 2 ;;
      --mock) mock=1; shift ;;
      *) delegate_die "unknown watch arg: $1" ;;
    esac
  done
  [[ -n "$id" ]] || delegate_die "watch requires --id"
  delegate_ensure_tree
  ((mock)) && export DELEGATE_WORKER_MOCK=1

  local round=0 root status phase owner next
  root="$(delegate_tickets_root)"
  [[ -f "$root/_data/$id/ticket.md" ]] || delegate_die "ticket not found: $id" 2

  while (( round < max_rounds )); do
    round=$((round + 1))
    status="$(awk -F': ' '/^status:/{print $2; exit}' "$root/_data/$id/ticket.md" | tr -d '"')"
    phase="$(awk -F': ' '/^phase:/{print $2; exit}' "$root/_data/$id/ticket.md" | tr -d '"')"
    owner="$(awk -F': ' '/^owner:/{print $2; exit}' "$root/_data/$id/ticket.md" | tr -d '"')"
    delegate_log "watch round=$round status=$status phase=$phase owner=$owner"

    case "$status" in
      closed|rejected)
        printf '{"ok":true,"id":"%s","done":true,"status":"%s","phase":"%s","rounds":%s}\n' \
          "$id" "$status" "$phase" "$round"
        return 0
        ;;
      shipped)
        printf '{"ok":true,"id":"%s","done":true,"status":"shipped","phase":"%s","rounds":%s,"hint":"initiator verify / close"}\n' \
          "$id" "$phase" "$round"
        return 0
        ;;
      waiting_initiator|failed)
        printf '{"ok":true,"id":"%s","blocked":true,"status":"%s","phase":"%s","owner":"initiator","hint":"reply --decision … [--continue]"}\n' \
          "$id" "$status" "$phase"
        ((once)) && return 0
        sleep "$interval"
        continue
        ;;
    esac

    # Auto-continue implement when approved or research accepted but not yet implemented
    if [[ "$phase" == "approved_to_implement" || "$phase" == "research_done" ]]; then
      delegate_log "watch: kicking implement (phase=$phase)"
      local run_args=(--id "$id" --phase implement --backend "$backend")
      ((mock)) && run_args+=(--mock)
      cmd_run "${run_args[@]}"
      ((once)) && return 0
      sleep 1
      continue
    fi

    if [[ "$phase" == "implement_incomplete" ]]; then
      delegate_log "watch: retry implement"
      local run_args=(--id "$id" --phase implement --backend "$backend")
      ((mock)) && run_args+=(--mock)
      cmd_run "${run_args[@]}"
      ((once)) && return 0
      sleep 1
      continue
    fi

    # in_progress / researching / implementing — wait
    ((once)) && {
      printf '{"ok":true,"id":"%s","waiting":true,"status":"%s","phase":"%s"}\n' "$id" "$status" "$phase"
      return 0
    }
    sleep "$interval"
  done

  printf '{"ok":false,"id":"%s","error":"max rounds reached","rounds":%s}\n' "$id" "$max_rounds" >&2
  return 2
}
cmd_set_status() {
  local id="" status="" owner="" phase=""
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      --status) status=$2; shift 2 ;;
      --owner) owner=$2; shift 2 ;;
      --phase) phase=$2; shift 2 ;;
      *) delegate_die "unknown set-status arg: $1" ;;
    esac
  done
  [[ -n "$id" && -n "$status" ]] || delegate_die "set-status requires --id --status"
  case "$status" in
    submitted|in_progress|waiting_initiator|waiting_target|shipped|closed|rejected|failed) ;;
    *) delegate_die "invalid status: $status" ;;
  esac
  delegate_ensure_tree
  local root lock
  root="$(delegate_tickets_root)"
  lock="$root/.locks/tickets.lock"
  delegate_with_lock "$lock" -- \
    env DELEGATE_TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" \
      ID="$id" STATUS="$status" OWNER="$owner" PHASE="$phase" python3 - <<'PY'
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
meta["status"] = os.environ["STATUS"]
if os.environ.get("OWNER"):
    meta["owner"] = os.environ["OWNER"]
if os.environ.get("PHASE"):
    meta["phase"] = os.environ["PHASE"]
# default owner by status
if not os.environ.get("OWNER"):
    st = meta["status"]
    if st in ("waiting_initiator", "shipped"):
        meta["owner"] = "initiator"
    elif st in ("closed", "rejected"):
        meta["owner"] = meta.get("owner") or "initiator"
    else:
        meta["owner"] = "worker"
mod.write_ticket(tid, meta, body)
mod.append_event(tid, {"type": "status", "status": meta["status"], "owner": meta.get("owner")})
mod.reindex()
print(json.dumps({"ok": True, "id": tid, "status": meta["status"], "owner": meta.get("owner")}, ensure_ascii=False))
PY
}

cmd_status() {
  local id="" mine=0 from=""
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      --mine) mine=1; shift ;;
      --from) from=$2; shift 2 ;;
      *) delegate_die "unknown status arg: $1" ;;
    esac
  done
  delegate_ensure_tree
  if [[ -n "$id" ]]; then
    env DELEGATE_TICKETS_ROOT="$(delegate_tickets_root)" TOOL_ROOT="$TOOL_ROOT" ID="$id" python3 - <<'PY'
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
mj = mod.read_meta_json(tid)
print(json.dumps({"ok": True, "id": tid, "meta": meta, "runtime": mj, "bucket": mod.bucket_for(str(meta.get("status")), str(meta.get("owner") or "")), "path": str(mod.data_dir(tid) / "ticket.md")}, ensure_ascii=False, indent=2))
PY
    return
  fi
  local from_key=""
  if ((mine)) || [[ -n "$from" ]]; then
    from_key="$(delegate_resolve_target_key "${from:-.}")"
  fi
  env DELEGATE_TICKETS_ROOT="$(delegate_tickets_root)" TOOL_ROOT="$TOOL_ROOT" FROM_KEY="$from_key" python3 - <<'PY'
import importlib.util, json, os
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.reindex()
idx_path = mod.tickets_root() / "index.json"
data = json.loads(idx_path.read_text(encoding="utf-8")) if idx_path.is_file() else {"tickets": []}
tickets = data.get("tickets") or []
fk = os.environ.get("FROM_KEY") or ""
if fk:
    tickets = [t for t in tickets if t.get("from") == fk and t.get("status") not in ("closed", "rejected")]
print(json.dumps({"ok": True, "from": fk or None, "count": len(tickets), "tickets": tickets}, ensure_ascii=False, indent=2))
PY
}

cmd_board() {
  local to="."
  while (($#)); do
    case "$1" in
      --to) to=$2; shift 2 ;;
      *) delegate_die "unknown board arg: $1" ;;
    esac
  done
  delegate_ensure_tree
  local key
  key="$(delegate_resolve_target_key "$to")"
  env DELEGATE_TICKETS_ROOT="$(delegate_tickets_root)" TOOL_ROOT="$TOOL_ROOT" TO_KEY="$key" python3 - <<'PY'
import importlib.util, json, os
from pathlib import Path
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.reindex()
to = os.environ["TO_KEY"]
base = mod.tickets_root() / "by-target" / to
board = {}
for bucket in ("inbox", "waiting-on-peer", "in-progress", "done"):
    d = base / bucket
    ids = []
    if d.is_dir():
        for p in sorted(d.glob("req-*.md")):
            tid = p.name[:-3]
            try:
                meta, _ = mod.read_ticket(tid)
                ids.append({"id": tid, "title": meta.get("title"), "status": meta.get("status"), "owner": meta.get("owner")})
            except FileNotFoundError:
                ids.append({"id": tid, "title": None, "status": "missing"})
    board[bucket] = ids
print(json.dumps({"ok": True, "to": to, "board": board}, ensure_ascii=False, indent=2))
# human skim
print(f"\n# board · {to}", file=__import__('sys').stderr)
for bucket, ids in board.items():
    print(f"  [{bucket}] {len(ids)}", file=__import__('sys').stderr)
    for it in ids[:20]:
        print(f"    - {it['id']}: {it.get('title') or '?'} ({it.get('status')})", file=__import__('sys').stderr)
PY
}

cmd_close() {
  local id="" doc="" no_doc=""
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      --doc) doc=$2; shift 2 ;;
      --no-doc) no_doc=$2; shift 2 ;;
      *) delegate_die "unknown close arg: $1" ;;
    esac
  done
  [[ -n "$id" ]] || delegate_die "close requires --id"
  [[ -n "$doc" || -n "$no_doc" ]] || delegate_die "close requires --doc PATH or --no-doc REASON"
  delegate_ensure_tree
  local root lock
  root="$(delegate_tickets_root)"
  lock="$root/.locks/tickets.lock"
  delegate_with_lock "$lock" -- \
    env DELEGATE_TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" \
      ID="$id" DOC="$doc" NO_DOC="$no_doc" python3 - <<'PY'
import importlib.util, json, os, sys, shutil
from pathlib import Path
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
tid = os.environ["ID"]
doc = os.environ.get("DOC") or ""
no_doc = os.environ.get("NO_DOC") or ""
try:
    meta, body = mod.read_ticket(tid)
except FileNotFoundError as e:
    print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
    sys.exit(2)
if doc:
    meta["solution_doc"] = doc
else:
    meta["solution_doc"] = f"skipped: {no_doc}"
meta["status"] = "closed"
meta["owner"] = "initiator"
meta["claimed_by"] = None
meta["lease_until"] = None
mj = mod.read_meta_json(tid)
mj["lease_until_epoch"] = None
mj["claimed_by"] = None
mod.write_ticket(tid, meta, body)
mod.write_meta_json(tid, mj)
mod.append_event(tid, {"type": "closed", "solution_doc": meta["solution_doc"]})
mod.reindex()
import time
arch = mod.tickets_root() / "archive" / time.strftime("%Y-%m", time.gmtime())
arch.mkdir(parents=True, exist_ok=True)
marker = arch / f"{tid}.closed"
marker.write_text(
    json.dumps(
        {"id": tid, "solution_doc": meta["solution_doc"], "closed_at": mod.now_iso()},
        ensure_ascii=False,
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
print(json.dumps({"ok": True, "id": tid, "status": "closed", "solution_doc": meta["solution_doc"]}, ensure_ascii=False))
PY
}

cmd_install_cli() {
  local dest="${1:-$HOME/.local/bin/delegate}"
  mkdir -p "$(dirname "$dest")"
  local wrapper
  wrapper="$TOOL_ROOT/delegate"
  [[ -x "$wrapper" ]] || chmod +x "$wrapper"
  if [[ -L "$dest" || -e "$dest" ]]; then
    if [[ "$(readlink -f "$dest" 2>/dev/null || true)" == "$(readlink -f "$wrapper")" ]]; then
      printf 'ok: %s -> %s\n' "$dest" "$wrapper"
      return 0
    fi
    rm -f "$dest"
  fi
  ln -s "$wrapper" "$dest"
  printf 'linked: %s -> %s\n' "$dest" "$wrapper"
  if ! command -v delegate >/dev/null 2>&1; then
    printf 'note: ensure %s is on PATH (e.g. export PATH="$HOME/.local/bin:$PATH")\n' "$(dirname "$dest")"
  else
    printf 'try: delegate walkthrough --seed\n'
  fi
}

cmd_show() {
  local id=""
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      *) delegate_die "unknown show arg: $1" ;;
    esac
  done
  [[ -n "$id" ]] || delegate_die "show requires --id"
  local path
  path="$(delegate_tickets_root)/_data/$id/ticket.md"
  [[ -f "$path" ]] || delegate_die "ticket not found: $id" 2
  printf '# %s\n\n' "$path" >&2
  cat "$path"
}

cmd_next() {
  local to="." id=""
  while (($#)); do
    case "$1" in
      --to) to=$2; shift 2 ;;
      --id) id=$2; shift 2 ;;
      *) delegate_die "unknown next arg: $1" ;;
    esac
  done
  delegate_ensure_tree
  local key=""
  if [[ -z "$id" ]]; then
    key="$(delegate_resolve_target_key "$to")"
  fi
  env DELEGATE_TICKETS_ROOT="$(delegate_tickets_root)" TOOL_ROOT="$TOOL_ROOT" \
    ID="$id" TO_KEY="$key" CLI="delegate" python3 - <<'PY'
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
cli = os.environ.get("CLI") or "delegate"
tid = (os.environ.get("ID") or "").strip()
to_key = (os.environ.get("TO_KEY") or "").strip()

def advice(meta, tid):
    st = meta.get("status")
    owner = meta.get("owner")
    steps = []
    if st == "submitted":
        steps = [
            f"{cli} claim --id {tid}",
            f"{cli} show --id {tid}",
            "# work in the target repo, then either:",
            f"{cli} challenge --id {tid} --measured '…' --impact '…' --recommended '…' --needs '…'",
            f"# or finish and: {cli} close --id {tid} --doc path/to/topic.md",
        ]
    elif st == "in_progress":
        steps = [
            f"{cli} show --id {tid}",
            "# continue work; when assumptions fail:",
            f"{cli} challenge --id {tid} --measured '…' --impact '…' --recommended '…'",
            f"# when done: {cli} close --id {tid} --doc path.md",
        ]
    elif st == "waiting_initiator":
        steps = [
            f"{cli} show --id {tid}",
            f"{cli} reply --id {tid} --decision '…' --continue   # confirm then auto-implement",
            f"# or: {cli} watch --id {tid}   # after reply without --continue",
        ]
    elif st == "waiting_target":
        phase = meta.get("phase") or ""
        if phase in ("research_done", "approved_to_implement"):
            steps = [
                f"{cli} watch --id {tid} --once   # kicks implement",
                f"# or: {cli} run --id {tid} --phase implement",
            ]
        else:
            steps = [
                f"{cli} show --id {tid}",
                f"{cli} watch --id {tid}",
            ]
    elif st == "shipped":
        steps = [
            "# initiator: verify / consumer adapt, then",
            f"{cli} close --id {tid} --doc path.md",
            f"{cli} watch --id {tid} --once   # reports shipped done",
        ]
    elif st in ("closed", "rejected"):
        steps = ["# terminal — nothing to do"]
    else:
        steps = [f"{cli} status --id {tid}", f"{cli} show --id {tid}"]
    return {"id": tid, "status": st, "owner": owner, "title": meta.get("title"), "next": steps}

out = {"ok": True, "actions": []}
if tid:
    try:
        meta, _ = mod.read_ticket(tid)
    except FileNotFoundError as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(2)
    out["actions"].append(advice(meta, tid))
else:
    mod.reindex()
    inbox = mod.list_inbox(to_key)
    peer = []
    base = mod.tickets_root() / "by-target" / to_key / "waiting-on-peer"
    if base.is_dir():
        for p in sorted(base.glob("req-*.md")):
            peer.append(p.name[:-3])
    if inbox:
        for it in inbox[:5]:
            out["actions"].append(advice(it["meta"], it["id"]))
    elif peer:
        for pid in peer[:5]:
            meta, _ = mod.read_ticket(pid)
            out["actions"].append(advice(meta, pid))
    else:
        out["hint"] = f"no open tickets for {to_key}; file one with: {cli} create --to {to_key} --from . --title … --observed … --assumed …"

print(json.dumps(out, ensure_ascii=False, indent=2))
for act in out.get("actions") or []:
    print(f"\n## {act['id']} · {act.get('title')} [{act.get('status')}]", file=sys.stderr)
    for line in act.get("next") or []:
        print(line, file=sys.stderr)
if out.get("hint"):
    print(out["hint"], file=sys.stderr)
PY
}

cmd_challenge() {
  local id="" measured="" impact="" recommended="" original="" needs=""
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      --measured) measured=$2; shift 2 ;;
      --impact) impact=$2; shift 2 ;;
      --recommended) recommended=$2; shift 2 ;;
      --original) original=$2; shift 2 ;;
      --needs) needs=$2; shift 2 ;;
      *) delegate_die "unknown challenge arg: $1" ;;
    esac
  done
  [[ -n "$id" && -n "$measured" && -n "$impact" && -n "$recommended" ]] \
    || delegate_die "challenge requires --id --measured --impact --recommended"
  delegate_ensure_tree
  local root lock
  root="$(delegate_tickets_root)"
  lock="$root/.locks/tickets.lock"
  delegate_with_lock "$lock" -- \
    env DELEGATE_TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" \
      ID="$id" MEASURED="$measured" IMPACT="$impact" RECOMMENDED="$recommended" \
      ORIGINAL="$original" NEEDS="$needs" python3 - <<'PY'
import importlib.util, json, os, re, sys
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

original = os.environ.get("ORIGINAL") or "(see Assumptions above)"
measured = os.environ["MEASURED"]
impact = os.environ["IMPACT"]
recommended = os.environ["RECOMMENDED"]
needs = os.environ.get("NEEDS") or "Confirm whether to change target, consumer, or both."
stamp = mod.now_iso()
block = f"""## Verification

_{stamp}_

- original_assumption: {original}
- measured_fact: {measured}
- impact: {impact}
- recommended: {recommended}
- needs_initiator_decision: {needs}

"""
if re.search(r"^## Verification\s*$", body, re.M):
    body = re.sub(
        r"^## Verification\s*\n(?:.*\n)*?(?=^## |\Z)",
        block,
        body,
        count=1,
        flags=re.M,
    )
else:
    body = body.rstrip() + "\n\n" + block

thread = f"\n- ({stamp}) worker challenge: {needs}\n"
if "## Thread" in body:
    body = body.replace("## Thread", "## Thread" + thread, 1)
else:
    body += "\n## Thread\n" + thread

meta["status"] = "waiting_initiator"
meta["owner"] = "initiator"
meta["phase"] = "challenge"
mod.write_ticket(tid, meta, body)
mod.append_event(tid, {"type": "challenge", "needs": needs, "measured": measured})
mod.reindex()
print(json.dumps({"ok": True, "id": tid, "status": "waiting_initiator", "owner": "initiator"}, ensure_ascii=False))
PY
}

cmd_walkthrough() {
  local seed=0
  while (($#)); do
    case "$1" in
      --seed) seed=1; shift ;;
      *) delegate_die "unknown walkthrough arg: $1" ;;
    esac
  done
  delegate_ensure_tree
  local cli="delegate"
  if ! command -v delegate >/dev/null 2>&1; then
    cli="$TOOL_ROOT/run.sh"
  fi

  cat <<EOF
# Delegate walkthrough · AVC → wezdeck (Pull)

Install once (PATH):
  $TOOL_ROOT/run.sh install-cli
  # then: hash -r   # or open a new shell

## A) File from AVC (initiator)

  cd ~/work/ai-video-collection
  $cli create \\
    --to wezdeck --from . \\
    --title "Describe the wezdeck-side fix" \\
    --observed "What failed while using a skill / tool in AVC" \\
    --assumed "What wezdeck should change or document" \\
    --snippet-ref "path:line"

  # note the printed "id": req-…

## B) Handle in wezdeck (target)

  cd ~/github/wezterm-config
  $cli inbox --to .
  $cli next --to .
  $cli claim --id req-…
  $cli show --id req-…
  # … edit wezdeck code / docs …
  # if assumptions were wrong:
  $cli challenge --id req-… --measured "…" --impact "…" --recommended "…" --needs "…"
  # back in initiator session:
  $cli reply --id req-… --decision "…"
  # finish:
  $cli close --id req-… --doc scripts/dev/cross-repo-delegate/README.md

## C) Inspect

  $cli board --to wezdeck
  $cli status --mine --from ai-video-collection
  ls ~/.agent/tickets/by-target/wezdeck/inbox/

EOF

  if ((seed)); then
    local out id
    out="$("$TOOL_ROOT/run.sh" create \
      --to wezdeck --from ai-video-collection \
      --title "WALKTHROUGH: try claim/show/close in wezdeck" \
      --observed "Operator is learning the delegate Pull flow" \
      --assumed "wezdeck agent/human can claim this ticket from inbox and close it" \
      --snippet-ref "scripts/dev/cross-repo-delegate/SKILL.md:1" \
      --summary "Seeded by: delegate walkthrough --seed")"
    id="$(printf '%s' "$out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')"
    cat <<EOF

## Seeded open ticket

$id

Next (in wezdeck):

  cd ~/github/wezterm-config
  $cli inbox --to .
  $cli claim --id $id
  $cli show --id $id
  $cli next --id $id
  $cli close --id $id --no-doc "walkthrough smoke only"

Ticket path:
  ~/.agent/tickets/_data/$id/ticket.md

EOF
    printf '%s\n' "$out"
  fi
}

cmd_reindex() {
  delegate_ensure_tree
  env DELEGATE_TICKETS_ROOT="$(delegate_tickets_root)" python3 "$PY" reindex
}

cmd_selfcheck() {
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/delegate-selfcheck.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  DELEGATE_TICKETS_ROOT="$tmp" "$0" init >/dev/null
  # seed config with fake paths that exist
  cat >"$tmp/config.yml" <<EOF
targets:
  wezdeck:
    path: $TOOL_ROOT/../../..
    aliases: [wezdeck, wezterm-config]
  avc:
    path: $TOOL_ROOT
    aliases: [avc, ai-video-collection]
EOF
  local out id
  out="$(DELEGATE_TICKETS_ROOT="$tmp" "$0" create \
    --to wezdeck --from avc --title "selfcheck ticket" \
    --observed "skill X failed in avc" \
    --assumed "wezdeck should document X" \
    --snippet-ref "scripts/dev/cross-repo-delegate/SKILL.md:1")"
  id="$(printf '%s' "$out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')"
  DELEGATE_TICKETS_ROOT="$tmp" "$0" inbox --to wezdeck >/dev/null
  DELEGATE_TICKETS_ROOT="$tmp" "$0" claim --id "$id" --by selfcheck >/dev/null
  DELEGATE_TICKETS_ROOT="$tmp" "$0" set-status --id "$id" --status waiting_initiator >/dev/null
  DELEGATE_TICKETS_ROOT="$tmp" "$0" reply --id "$id" --decision "fix in wezdeck docs" >/dev/null
  DELEGATE_TICKETS_ROOT="$tmp" "$0" close --id "$id" --doc "docs/example.md" >/dev/null
  DELEGATE_TICKETS_ROOT="$tmp" "$0" board --to wezdeck >/dev/null
  printf '{"ok":true,"selfcheck":"passed","sample_id":"%s"}\n' "$id"
}

case "$cmd" in
  init) cmd_init "$@" ;;
  install-cli) cmd_install_cli "$@" ;;
  create) cmd_create "$@" ;;
  run) cmd_run "$@" ;;
  watch) cmd_watch "$@" ;;
  inbox) cmd_inbox "$@" ;;
  show) cmd_show "$@" ;;
  next) cmd_next "$@" ;;
  claim) cmd_claim "$@" ;;
  release) cmd_release "$@" ;;
  challenge) cmd_challenge "$@" ;;
  reply) cmd_reply "$@" ;;
  set-status) cmd_set_status "$@" ;;
  status) cmd_status "$@" ;;
  board) cmd_board "$@" ;;
  close) cmd_close "$@" ;;
  walkthrough) cmd_walkthrough "$@" ;;
  reindex) cmd_reindex "$@" ;;
  selfcheck) cmd_selfcheck "$@" ;;
  *) usage; delegate_die "unknown command: $cmd" ;;
esac
