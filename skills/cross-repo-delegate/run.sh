#!/usr/bin/env bash
# Cross-repo delegate tickets — MVP runner.
#
# Usage:
#   run.sh init | install-cli
#   run.sh create --to TARGET --from SOURCE --title TITLE \
#     --observed TEXT --assumed TEXT [--snippet-ref REF] [--summary TEXT] [--source-pr REF] \
#     [--run] [--backend claude|codex|grok] [--mock]
#       bare create = 主会话建单（只交票，不派工人）
#       create --run = 主会话建单并委托开发（headless worktree + worker）
#   run.sh run --id ID [--phase research|implement|auto] [--backend …] [--mock] [--no-worktree] [--steal]
#       auto = research then implement if verdict=accept (default for create --run)
#       refuses a human/session lease unless --steal
#   run.sh watch --id ID [--interval SEC] [--once] [--max-rounds N] [--backend …] [--mock]
#       poll until terminal / blocked on human; auto-continue implement when approved
#   run.sh inbox [--to TARGET|.]
#   run.sh show --id ID
#   run.sh next [--to TARGET|.] [--id ID]
#   run.sh claim --id ID [--by WHO] [--lease-hours N] [--as-worker] [--steal]
#       default = 主会话认领并开发 (owner=human; 禁止自动 worktree/worker)
#       --as-worker = headless worker 内部认领 only
#   run.sh release --id ID
#   run.sh challenge --id ID --measured TEXT --impact TEXT --recommended TEXT \
#     [--original TEXT] [--needs TEXT]
#   run.sh reply --id ID --decision TEXT [--status waiting_target|in_progress]
#       [--continue] only for worker-owned tickets (headless implement)
#   run.sh set-status --id ID --status STATUS [--owner OWNER] [--phase PHASE]
#   run.sh status [--id ID] [--mine] [--from SOURCE]
#   run.sh board [--to TARGET]
#   run.sh close --id ID [--doc PATH] [--no-doc REASON] [--keep-worktree]
#       close also reclaims Mode 3 delegate-* worktree (keep branch; strip .delegate)
#   run.sh gc [--dry-run|--execute] [--status LIST] [--include-shipped]
#             [--include-waiting] [--min-age Nd] [--force] [--orphans] [--id ID]
#       default --dry-run; reclaim terminal-ticket worktrees (and optional aged shipped)
#   run.sh worktrees [--alive] [--to TARGET|.] [--status LIST] [--min-age Nd]
#                    [--orphans] [--id ID]
#       decision table: ticket × worktree (exists/dirty/ahead/age → suggest)
#   run.sh walkthrough [--seed]
#   run.sh reindex | selfcheck
#
# Tickets live under ~/.agent/tickets (override: DELEGATE_TICKETS_ROOT).
# Three modes: create | claim(session develop) | create --run (delegate develop).
# Claim never implies run/worktree. DELEGATE_WORKER_MOCK=1 or --mock skips LLM.
#
# Exit: 0 ok · 1 usage · 2 not found / invalid · 3 lock / conflict
set -euo pipefail

TOOL_ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd -P)"
# shellcheck source=/dev/null
. "$TOOL_ROOT/lib/common.sh"
# shellcheck source=/dev/null
. "$TOOL_ROOT/lib/worktree.sh"
# shellcheck source=/dev/null
. "$TOOL_ROOT/lib/worker.sh"
. "$TOOL_ROOT/lib/lifecycle.sh"

PY="$TOOL_ROOT/lib/ticket_fs.py"
usage() {
  sed -n '2,52p' "$0" | sed 's/^# \{0,1\}//'
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

    # Auto-continue implement only for worker-owned tickets. Session claims stay in TUI.
    if [[ "$owner" == "human" && ( "$phase" == "approved_to_implement" || "$phase" == "research_done" || "$phase" == "session" ) ]]; then
      printf '{"ok":true,"id":"%s","blocked":true,"status":"%s","phase":"%s","owner":"human","hint":"session claim — target TUI implements; do not run/worktree"}\n' \
        "$id" "$status" "$phase"
      ((once)) && return 0
      sleep "$interval"
      continue
    fi
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
  local id="" doc="" no_doc="" keep_worktree=0
  while (($#)); do
    case "$1" in
      --id) id=$2; shift 2 ;;
      --doc) doc=$2; shift 2 ;;
      --no-doc) no_doc=$2; shift 2 ;;
      --keep-worktree) keep_worktree=1; shift ;;
      *) delegate_die "unknown close arg: $1" ;;
    esac
  done
  [[ -n "$id" ]] || delegate_die "close requires --id"
  [[ -n "$doc" || -n "$no_doc" ]] || delegate_die "close requires --doc PATH or --no-doc REASON"
  delegate_ensure_tree
  local root lock close_json reclaim_json
  root="$(delegate_tickets_root)"
  lock="$root/.locks/tickets.lock"
  close_json="$(
    delegate_with_lock "$lock" -- \
      env DELEGATE_TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" \
        ID="$id" DOC="$doc" NO_DOC="$no_doc" python3 - <<'PY'
import importlib.util, json, os, sys
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
  )" || return $?

  reclaim_json='{"ok":true,"action":"skipped","reason":"keep_worktree"}'
  if ((keep_worktree == 0)); then
    # Close already committed; reclaim failure must not undo the ticket status.
    set +e
    reclaim_json="$(delegate_reclaim_worktree "$id")"
    set -e
  fi
  CLOSE_JSON="$close_json" RECLAIM_JSON="$reclaim_json" python3 - <<'PY'
import json, os
close = json.loads(os.environ["CLOSE_JSON"])
try:
    reclaim = json.loads(os.environ["RECLAIM_JSON"] or "{}")
except json.JSONDecodeError:
    reclaim = {"ok": False, "reason": "reclaim_parse_error", "raw": os.environ.get("RECLAIM_JSON")}
close["worktree_reclaim"] = reclaim
print(json.dumps(close, ensure_ascii=False))
PY
}

# Sweep Mode 3 delegate-* worktrees for terminal / aged tickets.
cmd_gc() {
  local dry_run=1 execute=0 force=0 orphans=0 include_shipped=0 include_waiting=0
  local status_list="closed,rejected,failed" min_age="0" only_id=""
  while (($#)); do
    case "$1" in
      --dry-run) dry_run=1; execute=0; shift ;;
      --execute) execute=1; dry_run=0; shift ;;
      --force) force=1; shift ;;
      --orphans) orphans=1; shift ;;
      --include-shipped) include_shipped=1; shift ;;
      --include-waiting) include_waiting=1; shift ;;
      --status) status_list=$2; shift 2 ;;
      --min-age) min_age=$2; shift 2 ;;
      --id) only_id=$2; shift 2 ;;
      -h|--help)
        cat <<'EOF'
gc — reclaim Mode 3 delegate-* worktrees for finished tickets

  --dry-run             list candidates only (default)
  --execute             actually reclaim
  --status LIST         comma statuses (default: closed,rejected,failed)
  --include-shipped     also consider shipped (use with --min-age)
  --include-waiting     also waiting_initiator / waiting_target (use with --min-age)
  --min-age Nd|Nh|Nm    only if ticket updated_at older than this (default 0)
  --force               pass through to reclaim (discard non-.delegate dirt)
  --orphans             also scan allowlist .worktrees/*/delegate-* with no open ticket
  --id ID               only this ticket
EOF
        return 0
        ;;
      *) delegate_die "unknown gc arg: $1" ;;
    esac
  done

  local min_age_sec
  min_age_sec="$(delegate_parse_age_seconds "$min_age")" \
    || delegate_die "invalid --min-age: $min_age (use 7d / 12h / 30m / seconds)"

  delegate_ensure_tree
  local root
  root="$(delegate_tickets_root)"

  local statuses="$status_list"
  if ((include_shipped)); then
    statuses="${statuses},shipped"
  fi
  if ((include_waiting)); then
    statuses="${statuses},waiting_initiator,waiting_target"
  fi

  local plan
  plan="$(
    DELEGATE_TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" \
      STATUSES="$statuses" MIN_AGE_SEC="$min_age_sec" ONLY_ID="$only_id" ORPHANS="$orphans" \
      python3 - <<'PY'
import importlib.util, json, os, re, time
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

root = mod.tickets_root()
statuses = {s.strip() for s in os.environ.get("STATUSES", "").split(",") if s.strip()}
min_age = int(os.environ.get("MIN_AGE_SEC") or "0")
only_id = (os.environ.get("ONLY_ID") or "").strip()
want_orphans = os.environ.get("ORPHANS") == "1"
now = int(time.time())

def parse_iso(s):
    if not s:
        return None
    s = str(s).strip().replace("Z", "+00:00")
    try:
        # fromisoformat needs python3.11+ for Z; we replaced Z
        from datetime import datetime
        dt = datetime.fromisoformat(s)
        return int(dt.timestamp())
    except Exception:
        return None

candidates = []
seen_paths = set()
data = root / "_data"
if data.is_dir():
    for d in sorted(data.iterdir()):
        if not d.is_dir():
            continue
        tid = d.name
        if only_id and tid != only_id:
            continue
        try:
            meta, _body = mod.read_ticket(tid)
        except FileNotFoundError:
            continue
        status = meta.get("status") or ""
        if status not in statuses:
            continue
        mj = mod.read_meta_json(tid)
        wt = mj.get("worktree") or ""
        if not wt:
            continue
        updated = parse_iso(meta.get("updated_at")) or 0
        age = max(0, now - updated) if updated else 0
        if min_age and updated and age < min_age:
            continue
        exists = Path(wt).is_dir()
        candidates.append({
            "id": tid,
            "status": status,
            "worktree": wt,
            "exists": exists,
            "age_sec": age,
            "source": "meta",
        })
        if wt:
            seen_paths.add(str(Path(wt).resolve()) if Path(wt).exists() else wt)

if want_orphans and not only_id:
    # Load allowlist target paths from config.yml (minimal parse).
    cfg = root / "config.yml"
    targets = []
    if cfg.is_file():
        cur = None
        for line in cfg.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
            if m:
                cur = m.group(1)
                continue
            m = re.match(r"^    path:\s*(.+?)\s*$", line)
            if m and cur:
                targets.append(os.path.expanduser(m.group(1).strip().strip("\"'")))
                cur = None
    # Map live open tickets' worktrees
    open_statuses = {
        "submitted", "in_progress", "waiting_initiator", "waiting_target", "shipped",
    }
    open_paths = set()
    ticket_by_slug = {}
    if data.is_dir():
        for d in data.iterdir():
            if not d.is_dir():
                continue
            try:
                meta, _ = mod.read_ticket(d.name)
            except FileNotFoundError:
                continue
            mj = mod.read_meta_json(d.name)
            wt = mj.get("worktree") or ""
            st = meta.get("status") or ""
            if wt and st in open_statuses:
                open_paths.add(str(Path(wt).resolve()) if Path(wt).exists() else wt)
            ticket_by_slug[f"delegate-{d.name}"] = (d.name, st)

    for tpath in targets:
        p = Path(tpath)
        if not p.is_dir():
            continue
        repo = p.name
        parent = p.parent
        wt_root = parent / ".worktrees" / repo
        if not wt_root.is_dir():
            continue
        for child in sorted(wt_root.iterdir()):
            if not child.is_dir():
                continue
            name = child.name
            if not name.startswith("delegate-"):
                continue
            resolved = str(child.resolve())
            if resolved in seen_paths or resolved in open_paths:
                continue
            tid = None
            st = None
            if name in ticket_by_slug:
                tid, st = ticket_by_slug[name]
                if st in open_statuses:
                    continue
            # orphan or terminal-without-meta-path
            if min_age:
                age = max(0, now - int(child.stat().st_mtime))
                if age < min_age:
                    continue
            else:
                age = max(0, now - int(child.stat().st_mtime))
            candidates.append({
                "id": tid or name,
                "status": st or "orphan",
                "worktree": resolved,
                "exists": True,
                "age_sec": age,
                "source": "orphan_scan",
            })
            seen_paths.add(resolved)

print(json.dumps({"ok": True, "candidates": candidates}, ensure_ascii=False))
PY
  )"

  if ((dry_run)); then
    printf '%s\n' "$plan" | python3 -c '
import json,sys
p=json.load(sys.stdin)
c=p.get("candidates") or []
print(json.dumps({"ok": True, "dry_run": True, "count": len(c), "candidates": c}, ensure_ascii=False, indent=2))
'
    return 0
  fi

  local cand_json count i item_id item_src item_wt reclaim_out
  local results_file
  results_file="$(mktemp "${TMPDIR:-/tmp}/delegate-gc.XXXXXX")"
  cand_json="$(printf '%s' "$plan" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin).get("candidates") or []))')"
  count="$(printf '%s' "$cand_json" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
  : >"$results_file"
  for ((i = 0; i < count; i++)); do
    item_id="$(printf '%s' "$cand_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)['"$i"']["id"])')"
    item_src="$(printf '%s' "$cand_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)['"$i"'].get("source") or "")')"
    item_wt="$(printf '%s' "$cand_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)['"$i"'].get("worktree") or "")')"
    set +e
    if [[ "$item_src" == "orphan_scan" && "$item_id" == delegate-* ]]; then
      if ((force)); then
        reclaim_out="$(delegate_reclaim_orphan_path "$item_wt" --force)"
      else
        reclaim_out="$(delegate_reclaim_orphan_path "$item_wt")"
      fi
    else
      if ((force)); then
        reclaim_out="$(delegate_reclaim_worktree "$item_id" --force)"
      else
        reclaim_out="$(delegate_reclaim_worktree "$item_id")"
      fi
    fi
    set -e
    printf '%s\n' "$reclaim_out" >>"$results_file"
  done

  PLAN="$plan" RESULTS_FILE="$results_file" python3 - <<'PY'
import json, os
from pathlib import Path
plan = json.loads(os.environ["PLAN"])
raw = Path(os.environ["RESULTS_FILE"]).read_text(encoding="utf-8").splitlines()
results = []
for line in raw:
    line = line.strip()
    if not line:
        continue
    try:
        results.append(json.loads(line))
    except json.JSONDecodeError:
        results.append({"ok": False, "reason": "parse_error", "raw": line})
reclaimed = sum(1 for r in results if r.get("ok") and r.get("action") in ("reclaimed", "cleared_meta"))
skipped = len(results) - reclaimed
print(json.dumps({
    "ok": True,
    "dry_run": False,
    "planned": len(plan.get("candidates") or []),
    "reclaimed": reclaimed,
    "skipped": skipped,
    "results": results,
}, ensure_ascii=False, indent=2))
PY
  rm -f "$results_file"
}

# Decision table: ticket status × Mode 3 worktree health.
cmd_worktrees() {
  local alive=0 orphans=0 to="" status_list="" min_age="0" only_id=""
  while (($#)); do
    case "$1" in
      --alive) alive=1; shift ;;
      --orphans) orphans=1; shift ;;
      --to) to=$2; shift 2 ;;
      --status) status_list=$2; shift 2 ;;
      --min-age) min_age=$2; shift 2 ;;
      --id) only_id=$2; shift 2 ;;
      -h|--help)
        cat <<'EOF'
worktrees — ticket × Mode 3 worktree decision table

  --alive          only rows whose worktree directory still exists
  --to TARGET|.    filter by ticket target allowlist key
  --status LIST    comma statuses (default: any with meta.worktree set)
  --min-age Nd     only if ticket updated_at older than this
  --orphans        also scan allowlist .worktrees/*/delegate-* without open ticket
  --id ID          single ticket

stdout: JSON. stderr: skim table (suggest / dirty / ahead / age).
suggest values: keep | close | gc | gc --force | clear_meta | inspect
EOF
        return 0
        ;;
      *) delegate_die "unknown worktrees arg: $1" ;;
    esac
  done

  local min_age_sec
  min_age_sec="$(delegate_parse_age_seconds "$min_age")" \
    || delegate_die "invalid --min-age: $min_age (use 7d / 12h / 30m / seconds)"

  delegate_ensure_tree
  local root to_key=""
  root="$(delegate_tickets_root)"
  if [[ -n "$to" ]]; then
    to_key="$(delegate_resolve_target_key "$to")"
  fi

  DELEGATE_TICKETS_ROOT="$root" TOOL_ROOT="$TOOL_ROOT" \
    ALIVE="$alive" ORPHANS="$orphans" TO_KEY="$to_key" \
    STATUSES="$status_list" MIN_AGE_SEC="$min_age_sec" ONLY_ID="$only_id" \
    python3 - <<'PY'
import importlib.util, json, os, re, subprocess, time
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

root = mod.tickets_root()
alive_only = os.environ.get("ALIVE") == "1"
want_orphans = os.environ.get("ORPHANS") == "1"
to_key = (os.environ.get("TO_KEY") or "").strip()
status_filter = {s.strip() for s in (os.environ.get("STATUSES") or "").split(",") if s.strip()}
min_age = int(os.environ.get("MIN_AGE_SEC") or "0")
only_id = (os.environ.get("ONLY_ID") or "").strip()
now = int(time.time())
ignore_prefixes = tuple(
    p.strip()
    for p in os.environ.get("DELEGATE_RECLAIM_IGNORE_GLOBS", ".delegate,.delegate/").split(",")
    if p.strip()
)

def parse_iso(s):
    if not s:
        return None
    s = str(s).strip().replace("Z", "+00:00")
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(s).timestamp())
    except Exception:
        return None

def git(cwd, *args):
    try:
        p = subprocess.run(
            ["git", "-C", str(cwd), *args],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if p.returncode != 0:
            return None
        return (p.stdout or "").rstrip("\n")
    except Exception:
        return None

def path_allowlisted(path: str) -> bool:
    path = path.strip().strip('"')
    if " -> " in path:
        return False
    for g in ignore_prefixes:
        g = g.rstrip("/")
        if path == g or path.startswith(g + "/") or path == "./" + g or path.startswith("./" + g + "/"):
            return True
    return False

def dirty_kind(wt: Path):
    out = git(wt, "status", "--porcelain", "--untracked-files=all")
    if out is None:
        return "unknown", 0
    lines = [ln for ln in out.splitlines() if ln.strip()]
    if not lines:
        return "clean", 0
    other = 0
    allow = 0
    for ln in lines:
        path = ln[3:] if len(ln) >= 3 else ln
        path = path.lstrip()
        if path_allowlisted(path):
            allow += 1
        else:
            other += 1
    if other:
        return "other", other + allow
    return "delegate_only", allow

def suggest(status: str, exists: bool, dirty: str, age_sec: int) -> str:
    if not exists:
        return "clear_meta"
    if status in ("closed", "rejected", "failed"):
        return "gc --force" if dirty == "other" else "gc"
    if status == "shipped":
        # initiator should close; aged shipped can gc directly
        if age_sec >= 7 * 86400:
            return "gc --force" if dirty == "other" else "gc"
        return "close"
    if status in ("waiting_initiator", "waiting_target"):
        if age_sec >= 14 * 86400:
            return "inspect"
        return "keep"
    if status in ("submitted", "in_progress"):
        return "keep"
    if status == "orphan":
        return "gc --force" if dirty == "other" else "gc"
    return "inspect"

rows = []
seen_paths = set()
data = root / "_data"
if data.is_dir():
    for d in sorted(data.iterdir()):
        if not d.is_dir():
            continue
        tid = d.name
        if only_id and tid != only_id:
            continue
        try:
            meta, _body = mod.read_ticket(tid)
        except FileNotFoundError:
            continue
        status = str(meta.get("status") or "")
        if to_key and str(meta.get("to") or "") != to_key:
            continue
        if status_filter and status not in status_filter:
            continue
        mj = mod.read_meta_json(tid)
        wt = mj.get("worktree") or ""
        if not wt:
            continue
        updated = parse_iso(meta.get("updated_at")) or 0
        age = max(0, now - updated) if updated else 0
        if min_age and updated and age < min_age:
            continue
        wt_path = Path(wt)
        exists = wt_path.is_dir()
        if alive_only and not exists:
            continue
        branch = None
        ahead = None
        dirty = "missing"
        dirty_n = 0
        if exists:
            branch = git(wt_path, "rev-parse", "--abbrev-ref", "HEAD")
            ahead_s = git(wt_path, "rev-list", "--count", "origin/HEAD..HEAD")
            if ahead_s is not None and ahead_s.isdigit():
                ahead = int(ahead_s)
            dirty, dirty_n = dirty_kind(wt_path)
            try:
                seen_paths.add(str(wt_path.resolve()))
            except Exception:
                seen_paths.add(wt)
        sug = suggest(status, exists, dirty, age)
        rows.append({
            "id": tid,
            "to": meta.get("to"),
            "title": meta.get("title"),
            "status": status,
            "worktree": wt,
            "exists": exists,
            "branch": branch,
            "dirty": dirty,
            "dirty_count": dirty_n,
            "ahead": ahead,
            "age_sec": age,
            "age_days": round(age / 86400, 1) if updated else None,
            "suggest": sug,
            "source": "meta",
        })

if want_orphans and not only_id:
    cfg = root / "config.yml"
    targets = []
    if cfg.is_file():
        cur = None
        for line in cfg.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
            if m:
                cur = m.group(1)
                continue
            m = re.match(r"^    path:\s*(.+?)\s*$", line)
            if m and cur:
                targets.append(os.path.expanduser(m.group(1).strip().strip("\"'")))
                cur = None
    open_statuses = {
        "submitted", "in_progress", "waiting_initiator", "waiting_target", "shipped",
    }
    ticket_by_slug = {}
    if data.is_dir():
        for d in data.iterdir():
            if not d.is_dir():
                continue
            try:
                meta, _ = mod.read_ticket(d.name)
            except FileNotFoundError:
                continue
            ticket_by_slug[f"delegate-{d.name}"] = (d.name, str(meta.get("status") or ""))
    for tpath in targets:
        p = Path(tpath)
        if not p.is_dir():
            continue
        wt_root = p.parent / ".worktrees" / p.name
        if not wt_root.is_dir():
            continue
        for child in sorted(wt_root.iterdir()):
            if not child.is_dir() or not child.name.startswith("delegate-"):
                continue
            try:
                resolved = str(child.resolve())
            except Exception:
                resolved = str(child)
            if resolved in seen_paths:
                continue
            tid = None
            st = "orphan"
            if child.name in ticket_by_slug:
                tid, st = ticket_by_slug[child.name]
                if st in open_statuses:
                    continue
            age = max(0, now - int(child.stat().st_mtime))
            if min_age and age < min_age:
                continue
            if to_key:
                # orphan rows have no ticket to; skip filter unless path repo matches
                pass
            dirty, dirty_n = dirty_kind(child)
            branch = git(child, "rev-parse", "--abbrev-ref", "HEAD")
            ahead_s = git(child, "rev-list", "--count", "origin/HEAD..HEAD")
            ahead = int(ahead_s) if ahead_s and ahead_s.isdigit() else None
            rows.append({
                "id": tid or child.name,
                "to": p.name,
                "title": None,
                "status": st,
                "worktree": resolved,
                "exists": True,
                "branch": branch,
                "dirty": dirty,
                "dirty_count": dirty_n,
                "ahead": ahead,
                "age_sec": age,
                "age_days": round(age / 86400, 1),
                "suggest": suggest(st, True, dirty, age),
                "source": "orphan_scan",
            })
            seen_paths.add(resolved)

# suggest histogram for skim
from collections import Counter
sug_counts = Counter(r["suggest"] for r in rows)
payload = {
    "ok": True,
    "count": len(rows),
    "alive": sum(1 for r in rows if r["exists"]),
    "suggest": dict(sug_counts),
    "worktrees": rows,
}
print(json.dumps(payload, ensure_ascii=False, indent=2))

# human table on stderr
import sys
print(
    f"# worktrees · count={len(rows)} alive={payload['alive']} suggest={dict(sug_counts)}",
    file=sys.stderr,
)
print(
    f"{'suggest':12} {'status':18} {'dirty':14} {'ahead':5} {'age_d':6} {'id':36} to",
    file=sys.stderr,
)
for r in rows:
    ahead = "" if r.get("ahead") is None else str(r["ahead"])
    age = "" if r.get("age_days") is None else f"{r['age_days']:.1f}"
    print(
        f"{r['suggest'][:12]:12} {r['status'][:18]:18} {r['dirty'][:14]:14} {ahead[:5]:5} {age[:6]:6} {r['id'][:36]:36} {r.get('to') or ''}",
        file=sys.stderr,
    )
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
    claimed_by = str(meta.get("claimed_by") or "")
    session = owner == "human" or (claimed_by and not claimed_by.startswith("worker-"))
    steps = []
    if st == "submitted":
        steps = [
            f"# Mode 2 — 主会话认领并开发（默认）:",
            f"{cli} claim --id {tid} && {cli} show --id {tid}",
            "# then develop in THIS TUI/cwd — do NOT run / worktree",
            f"{cli} challenge --id {tid} --measured '…' --impact '…' --recommended '…' --needs '…'",
            f"# or finish: {cli} close --id {tid} --doc path/to/topic.md",
            f"# Mode 3 only if user asks to delegate: {cli} run --id {tid} --phase auto",
        ]
    elif st == "in_progress":
        if session:
            steps = [
                f"{cli} show --id {tid}",
                "# session claim: keep developing in this TUI/cwd",
                "# do NOT run.sh run / create delegate-* worktree",
                f"{cli} challenge --id {tid} --measured '…' --impact '…' --recommended '…'",
                f"# when done: {cli} close --id {tid} --doc path.md",
            ]
        else:
            steps = [
                f"{cli} show --id {tid}",
                "# worker-owned: headless path in progress",
                f"{cli} watch --id {tid}",
            ]
    elif st == "waiting_initiator":
        if session:
            steps = [
                f"{cli} show --id {tid}",
                f"{cli} reply --id {tid} --decision '…'   # no --continue; target TUI implements",
            ]
        else:
            steps = [
                f"{cli} show --id {tid}",
                f"{cli} reply --id {tid} --decision '…' --continue   # confirm then headless implement",
                f"# or: {cli} watch --id {tid}   # after reply without --continue",
            ]
    elif st == "waiting_target":
        phase = meta.get("phase") or ""
        if session:
            steps = [
                f"{cli} show --id {tid}",
                "# session claim: target TUI implements — do not watch/run",
                f"# when done: {cli} close --id {tid} --doc path.md",
            ]
        elif phase in ("research_done", "approved_to_implement"):
            steps = [
                f"{cli} watch --id {tid} --once   # kicks headless implement",
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
    return {"id": tid, "status": st, "owner": owner, "mode": "session" if session else "worker", "title": meta.get("title"), "next": steps}

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
        lambda _m: block,
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

Three modes: (1) create only  (2) claim + develop in this TUI  (3) create --run to delegate.

Install once (PATH):
  $TOOL_ROOT/run.sh install-cli
  # then: hash -r   # or open a new shell

## A) File from AVC (initiator) — Mode 1

  cd ~/work/ai-video-collection
  $cli create \\
    --to wezdeck --from . \\
    --title "Describe the wezdeck-side fix" \\
    --observed "What failed while using a skill / tool in AVC" \\
    --assumed "What wezdeck should change or document" \\
    --snippet-ref "path:line"

  # note the printed "id": req-…

## B) Handle in wezdeck (target) — Mode 2 session claim

  cd ~/github/wezterm-config
  $cli inbox --to .
  $cli next --to .
  $cli claim --id req-…          # owner=human; develop HERE — do NOT run/worktree
  $cli show --id req-…
  # … edit wezdeck code / docs in this TUI …
  # if assumptions were wrong:
  $cli challenge --id req-… --measured "…" --impact "…" --recommended "…" --needs "…"
  # back in initiator session:
  $cli reply --id req-… --decision "…"
  # finish:
  $cli close --id req-… --doc skills/cross-repo-delegate/README.md

## B2) Mode 3 — create and delegate (explicit only)

  $cli create … --run [--backend claude]   # headless worker + delegate-* worktree
  $cli watch --id req-…

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
      --snippet-ref "skills/cross-repo-delegate/SKILL.md:1" \
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
    path: $TOOL_ROOT/../..
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
    --snippet-ref "skills/cross-repo-delegate/SKILL.md:1")"
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
  gc) cmd_gc "$@" ;;
  worktrees) cmd_worktrees "$@" ;;
  walkthrough) cmd_walkthrough "$@" ;;
  reindex) cmd_reindex "$@" ;;
  selfcheck) cmd_selfcheck "$@" ;;
  *) usage; delegate_die "unknown command: $cmd" ;;
esac
