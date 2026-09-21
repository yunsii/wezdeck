#!/usr/bin/env bash
# Headless research / implement workers + result apply.
# shellcheck shell=bash

# Shared host-headless invoke (claude/codex/grok read|write profiles).
_DELEGATE_HOST_INVOKE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../host-agent-invoke/lib" && pwd)/host-agent-invoke.sh"
# shellcheck source=/dev/null
. "$_DELEGATE_HOST_INVOKE"

delegate_worker_write_mock_result() {
  local result_path=$1 ticket_path=$2
  python3 - "$result_path" "$ticket_path" <<'PY'
import json, sys, re
from pathlib import Path
result_path, ticket_path = Path(sys.argv[1]), Path(sys.argv[2])
text = ticket_path.read_text(encoding="utf-8")
obs = ""
m = re.search(r"### Observed\n\n(.+?)\n\n###", text, re.S)
if m:
    obs = m.group(1).strip()[:500]
assumed = ""
m = re.search(r"### Assumed contract / behavior\n\n(.+?)\n\n###", text, re.S)
if m:
    assumed = m.group(1).strip()[:500]
payload = {
    "verdict": "accept",
    "verification": {
        "original_assumption": assumed or "(from ticket)",
        "measured_fact": f"[MOCK] would inspect codebase; observed summary: {obs[:200]}",
        "impact": "[MOCK] no live inspection",
        "recommended": "[MOCK] proceed to implement as ticket requests",
        "needs_initiator_decision": "",
    },
    "notes": "DELEGATE_WORKER_MOCK=1",
}
result_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
}

delegate_worker_write_mock_implement_result() {
  local result_path=$1
  python3 - "$result_path" <<'PY'
import json, sys
from pathlib import Path
Path(sys.argv[1]).write_text(
    json.dumps(
        {
            "ok": True,
            "summary": "[MOCK] implement skipped; marked ready_to_ship",
            "files_changed": [],
            "tests": "[MOCK] none",
            "ready_to_ship": True,
            "blocker": "",
        },
        ensure_ascii=False,
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
PY
}

# Apply research worker-result.json. Prints JSON incl. next_action.
delegate_worker_apply_result() {
  local ticket_id=$1
  env DELEGATE_TICKETS_ROOT="$(delegate_tickets_root)" TOOL_ROOT="$(delegate_tool_root)" \
    ID="$ticket_id" python3 - <<'PY'
import importlib.util, json, os, re, sys
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
tid = os.environ["ID"]
result_path = mod.data_dir(tid) / "worker-result.json"
if not result_path.is_file():
    print(json.dumps({"ok": False, "error": f"missing {result_path}"}), file=sys.stderr)
    sys.exit(2)
data = json.loads(result_path.read_text(encoding="utf-8"))
verdict = data.get("verdict") or "need_input"
v = data.get("verification") or {}
meta, body = mod.read_ticket(tid)
stamp = mod.now_iso()
block = f"""## Verification

_{stamp} · research worker_

- original_assumption: {v.get('original_assumption') or ''}
- measured_fact: {v.get('measured_fact') or ''}
- impact: {v.get('impact') or ''}
- recommended: {v.get('recommended') or ''}
- needs_initiator_decision: {v.get('needs_initiator_decision') or ''}

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

notes = data.get("notes") or ""
if notes:
    body = body.replace(
        "## Thread",
        f"## Thread\n\n- ({stamp}) worker notes: {notes}\n",
        1,
    )

if verdict == "challenge":
    meta["status"] = "waiting_initiator"
    meta["owner"] = "initiator"
    meta["phase"] = "research_challenge"
    next_action = "await_initiator"
elif verdict == "need_input":
    meta["status"] = "waiting_initiator"
    meta["owner"] = "initiator"
    meta["phase"] = "research_need_input"
    next_action = "await_initiator"
else:
    # accept — no objection; implement may start immediately
    meta["status"] = "waiting_target"
    meta["owner"] = "worker"
    meta["phase"] = "research_done"
    next_action = "implement"

mod.write_ticket(tid, meta, body)
mod.append_event(tid, {"type": "research_done", "verdict": verdict, "status": meta["status"], "next_action": next_action})
mod.reindex()
print(json.dumps({
    "ok": True,
    "id": tid,
    "verdict": verdict,
    "status": meta["status"],
    "owner": meta["owner"],
    "phase": meta["phase"],
    "next_action": next_action,
}, ensure_ascii=False))
PY
}

delegate_worker_apply_implement_result() {
  local ticket_id=$1
  env DELEGATE_TICKETS_ROOT="$(delegate_tickets_root)" TOOL_ROOT="$(delegate_tool_root)" \
    ID="$ticket_id" python3 - <<'PY'
import importlib.util, json, os, re, sys
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
tid = os.environ["ID"]
result_path = mod.data_dir(tid) / "implement-result.json"
if not result_path.is_file():
    print(json.dumps({"ok": False, "error": f"missing {result_path}"}), file=sys.stderr)
    sys.exit(2)
data = json.loads(result_path.read_text(encoding="utf-8"))
meta, body = mod.read_ticket(tid)
stamp = mod.now_iso()
summary = data.get("summary") or ""
tests = data.get("tests") or ""
files = data.get("files_changed") or []
blocker = data.get("blocker") or ""
ready = bool(data.get("ready_to_ship"))
ok = bool(data.get("ok", ready))
files_s = ", ".join(str(x) for x in files) if isinstance(files, list) else str(files)
block = f"""## Implement

_{stamp} · implement worker_

- summary: {summary}
- files_changed: {files_s}
- tests: {tests}
- ready_to_ship: {str(ready).lower()}
- blocker: {blocker or '_none_'}

"""
if re.search(r"^## Implement\s*$", body, re.M):
    body = re.sub(
        r"^## Implement\s*\n(?:.*\n)*?(?=^## |\Z)",
        lambda _m: block,
        body,
        count=1,
        flags=re.M,
    )
elif "## Decision" in body:
    body = body.replace("## Decision", block + "## Decision", 1)
else:
    body = body.rstrip() + "\n\n" + block

if ready and ok:
    meta["status"] = "shipped"
    meta["owner"] = "initiator"
    meta["phase"] = "implement_done"
    next_action = "await_initiator_verify"
elif blocker or not ok:
    meta["status"] = "waiting_initiator"
    meta["owner"] = "initiator"
    meta["phase"] = "implement_blocked"
    next_action = "await_initiator"
else:
    meta["status"] = "waiting_target"
    meta["owner"] = "worker"
    meta["phase"] = "implement_incomplete"
    next_action = "implement"

mod.write_ticket(tid, meta, body)
mod.append_event(tid, {"type": "implement_done", "ready_to_ship": ready, "status": meta["status"], "next_action": next_action})
mod.reindex()
print(json.dumps({
    "ok": True,
    "id": tid,
    "ready_to_ship": ready,
    "status": meta["status"],
    "owner": meta["owner"],
    "phase": meta["phase"],
    "next_action": next_action,
    "summary": summary,
}, ensure_ascii=False))
PY
}

# Headless invoke via shared host-agent-invoke (write profile: ticket result-file contract).
# Args: backend worktree_path prompt_path log_path [mode=write]
delegate_worker_invoke() {
  local backend=$1 worktree_path=$2 prompt_path=$3 log_path=$4
  local mode=${5:-write}
  local add_dir="" rc=0
  delegate_log "worker backend=$backend mode=$mode cwd=$worktree_path (host-agent-invoke)"
  case "$backend" in claude|codex|grok) ;; *)
    delegate_die "unknown backend: $backend (claude|codex|grok)"
    ;;
  esac
  if [[ "$backend" == "claude" && -d "$worktree_path/.delegate" ]]; then
    add_dir="$worktree_path/.delegate"
  fi
  rc=0
  if [[ -n "$add_dir" ]]; then
    host_agent_invoke_run \
      --backend "$backend" --mode "$mode" \
      --cwd "$worktree_path" --prompt-file "$prompt_path" \
      --add-dir "$add_dir" --log "$log_path" || rc=$?
  else
    host_agent_invoke_run \
      --backend "$backend" --mode "$mode" \
      --cwd "$worktree_path" --prompt-file "$prompt_path" \
      --log "$log_path" || rc=$?
  fi
  if [[ "$rc" -ne 0 ]]; then
    delegate_log "warn: host-agent-invoke backend=$backend exited $rc (see $(basename "$log_path"))"
  fi
  return 0
}

# Render phase-sliced ticket view into stdout (full ticket stays on disk).
delegate_worker_phase_view() {
  local ticket_id=$1 phase=$2
  env DELEGATE_TICKETS_ROOT="$(delegate_tickets_root)" \
    python3 "$(delegate_tool_root)/lib/ticket_fs.py" phase-view "$ticket_id" "$phase"
}

# Build prompt-${phase}.md. worktree_path may be empty for MOCK (no .delegate copy).
delegate_worker_prepare_prompt() {
  local ticket_id=$1 worktree_path=$2 phase=$3
  # phase: research | implement
  local root ticket_path prompt_path template local_result ticket_copy view_copy result_name view
  root="$(delegate_tickets_root)"
  ticket_path="$root/_data/${ticket_id}/ticket.md"
  prompt_path="$root/_data/${ticket_id}/prompt-${phase}.md"
  if [[ "$phase" == "implement" ]]; then
    template="$(delegate_tool_root)/prompts/implement.md"
    result_name="implement-result.json"
  else
    template="$(delegate_tool_root)/prompts/research.md"
    result_name="worker-result.json"
  fi

  view="$(delegate_worker_phase_view "$ticket_id" "$phase")" \
    || delegate_die "failed to render phase view ($phase) for $ticket_id" 2
  printf '%s' "$view" >"$root/_data/${ticket_id}/ticket-view-${phase}.md"

  local_result=""
  if [[ -n "$worktree_path" ]]; then
    mkdir -p "$worktree_path/.delegate"
    ticket_copy="$worktree_path/.delegate/ticket.md"
    view_copy="$worktree_path/.delegate/ticket-view.md"
    local_result="$worktree_path/.delegate/${result_name}"
    cp -f "$ticket_path" "$ticket_copy"
    printf '%s' "$view" >"$view_copy"
    rm -f "$local_result" "$worktree_path/${result_name}"
  fi

  {
    sed \
      -e "s|{{TICKET_PATH}}|.delegate/ticket.md|g" \
      -e "s|{{TICKET_VIEW_PATH}}|.delegate/ticket-view.md|g" \
      -e "s|{{RESULT_PATH}}|.delegate/${result_name}|g" \
      -e "s|{{TICKET_ID}}|${ticket_id}|g" \
      "$template"
    printf '\n\n## Ticket phase view (embedded — authoritative for this hop)\n\n```markdown\n'
    printf '%s' "$view"
    printf '\n```\n'
    printf '\nFull ticket (omitted sections): `.delegate/ticket.md`. Write JSON to `.delegate/%s`.\n' "$result_name"
  } >"$prompt_path"

  printf '%s\n' "$prompt_path"
  printf '%s\n' "$local_result"
}

# Run research worker. Args: ticket_id worktree_path backend
delegate_worker_research() {
  local ticket_id=$1 worktree_path=${2:-} backend=${3:-claude}
  local root ticket_path result_path
  root="$(delegate_tickets_root)"
  ticket_path="$root/_data/${ticket_id}/ticket.md"
  result_path="$root/_data/${ticket_id}/worker-result.json"
  rm -f "$result_path"

  if [[ "${DELEGATE_WORKER_MOCK:-0}" == "1" ]]; then
    delegate_log "worker MOCK research id=$ticket_id (via host-agent-invoke)"
    local prepared prompt_path mock_cwd
    prepared="$(delegate_worker_prepare_prompt "$ticket_id" "" research)"
    prompt_path="$(printf '%s\n' "$prepared" | sed -n '1p')"
    mock_cwd="$root/_data/${ticket_id}"
    mkdir -p "$mock_cwd"
    HOST_AGENT_INVOKE_MOCK=1 \
      HOST_AGENT_INVOKE_TRACE="${HOST_AGENT_INVOKE_TRACE:-$root/_data/${ticket_id}/host-invoke.trace.jsonl}" \
      delegate_worker_invoke "$backend" "$mock_cwd" "$prompt_path" \
      "$root/_data/${ticket_id}/worker.log" write
    delegate_worker_write_mock_result "$result_path" "$ticket_path"
    delegate_worker_apply_result "$ticket_id"
    return 0
  fi

  [[ -n "$worktree_path" && -d "$worktree_path" ]] || delegate_die "worktree required for live worker"
  local prepared prompt_path local_result
  prepared="$(delegate_worker_prepare_prompt "$ticket_id" "$worktree_path" research)"
  prompt_path="$(printf '%s\n' "$prepared" | sed -n '1p')"
  local_result="$(printf '%s\n' "$prepared" | sed -n '2p')"

  delegate_worker_invoke "$backend" "$worktree_path" "$prompt_path" \
    "$root/_data/${ticket_id}/worker.log" write

  if [[ -f "$local_result" ]]; then
    cp -f "$local_result" "$result_path"
  elif [[ -f "$worktree_path/worker-result.json" ]]; then
    cp -f "$worktree_path/worker-result.json" "$result_path"
  fi
  if [[ ! -f "$result_path" ]]; then
    delegate_die "worker did not write result JSON — see worker.log" 2
  fi
  delegate_worker_apply_result "$ticket_id"
}

# Run implement worker. Args: ticket_id worktree_path backend
delegate_worker_implement() {
  local ticket_id=$1 worktree_path=${2:-} backend=${3:-claude}
  local root ticket_path result_path
  root="$(delegate_tickets_root)"
  ticket_path="$root/_data/${ticket_id}/ticket.md"
  result_path="$root/_data/${ticket_id}/implement-result.json"
  rm -f "$result_path"

  if [[ "${DELEGATE_WORKER_MOCK:-0}" == "1" ]]; then
    delegate_log "worker MOCK implement id=$ticket_id (via host-agent-invoke)"
    local prepared prompt_path mock_cwd
    prepared="$(delegate_worker_prepare_prompt "$ticket_id" "" implement)"
    prompt_path="$(printf '%s\n' "$prepared" | sed -n '1p')"
    mock_cwd="$root/_data/${ticket_id}"
    mkdir -p "$mock_cwd"
    HOST_AGENT_INVOKE_MOCK=1 \
      HOST_AGENT_INVOKE_TRACE="${HOST_AGENT_INVOKE_TRACE:-$root/_data/${ticket_id}/host-invoke.trace.jsonl}" \
      delegate_worker_invoke "$backend" "$mock_cwd" "$prompt_path" \
      "$root/_data/${ticket_id}/implement.log" write
    delegate_worker_write_mock_implement_result "$result_path"
    delegate_worker_apply_implement_result "$ticket_id"
    return 0
  fi

  [[ -n "$worktree_path" && -d "$worktree_path" ]] || delegate_die "worktree required for live implement"
  local prepared prompt_path local_result
  prepared="$(delegate_worker_prepare_prompt "$ticket_id" "$worktree_path" implement)"
  prompt_path="$(printf '%s\n' "$prepared" | sed -n '1p')"
  local_result="$(printf '%s\n' "$prepared" | sed -n '2p')"

  # mark phase
  env DELEGATE_TICKETS_ROOT="$root" TOOL_ROOT="$(delegate_tool_root)" ID="$ticket_id" python3 - <<'PY'
import importlib.util, os
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
tid = os.environ["ID"]
meta, body = mod.read_ticket(tid)
meta["status"] = "in_progress"
meta["owner"] = "worker"
meta["phase"] = "implementing"
mod.write_ticket(tid, meta, body)
mod.append_event(tid, {"type": "implement_start"})
mod.reindex()
PY

  delegate_worker_invoke "$backend" "$worktree_path" "$prompt_path" \
    "$root/_data/${ticket_id}/implement.log" write

  if [[ -f "$local_result" ]]; then
    cp -f "$local_result" "$result_path"
  elif [[ -f "$worktree_path/implement-result.json" ]]; then
    cp -f "$worktree_path/implement-result.json" "$result_path"
  fi
  if [[ ! -f "$result_path" ]]; then
    delegate_die "implement worker did not write result JSON — see implement.log" 2
  fi
  delegate_worker_apply_implement_result "$ticket_id"
}
