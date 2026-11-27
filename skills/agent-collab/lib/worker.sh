#!/usr/bin/env bash
# Headless research / implement workers + result apply.
# shellcheck shell=bash

# Shared host-headless invoke (claude/codex/grok read|write profiles).
_TICKET_HOST_INVOKE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../scripts/dev/host-agent-invoke/lib" && pwd)/host-agent-invoke.sh"
# shellcheck source=/dev/null
. "$_TICKET_HOST_INVOKE"

ticket_worker_write_mock_result() {
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
    "notes": "TICKET_WORKER_MOCK=1",
}
result_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
}

ticket_worker_write_mock_implement_result() {
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
ticket_worker_apply_result() {
  local ticket_id=$1
  env TICKETS_ROOT="$(ticket_store_root)" TOOL_ROOT="$(ticket_tool_root)" \
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
questions = mod.normalize_questions(data.get("questions")) if verdict in ("challenge", "need_input") else []
if questions:
    block = block.rstrip("\n") + "\n\n" + mod.questions_markdown(questions) + "\n\n"
mod.write_questions(tid, questions, "research")
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
mod.append_event(tid, {"type": "research_done", "verdict": verdict, "status": meta["status"], "next_action": next_action, "questions": len(questions)})
mod.write_progress(
    tid,
    "research_done",
    f"research done · verdict={verdict} · next={next_action}",
    phase=meta["phase"],
    extra={"verdict": verdict, "next_action": next_action},
)
mod.reindex()
print(json.dumps({
    "ok": True,
    "id": tid,
    "verdict": verdict,
    "status": meta["status"],
    "owner": meta["owner"],
    "phase": meta["phase"],
    "next_action": next_action,
    "questions": len(questions),
}, ensure_ascii=False))
PY
}

ticket_worker_apply_implement_result() {
  local ticket_id=$1
  env TICKETS_ROOT="$(ticket_store_root)" TOOL_ROOT="$(ticket_tool_root)" \
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
mod.write_progress(
    tid,
    "implement_done",
    f"implement done · ready_to_ship={ready} · next={next_action}",
    phase=meta["phase"],
    extra={"ready_to_ship": ready, "next_action": next_action},
)
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
# Args: backend worktree_path prompt_path log_path [mode=write] [ticket_id] [phase] [role=worker]
# With ticket_id: observable run (docs/collab.md) — launch record with
# trigger + prompt composition, CLI event stream → ticket/global events, run
# record, session reuse (resume when warm; one fresh retry if resume fails).
ticket_worker_invoke() {
  local backend=$1 worktree_path=$2 prompt_path=$3 log_path=$4
  local mode=${5:-write} ticket_id=${6:-} phase=${7:-} role=${8:-worker}
  local add_dir="" rc=0
  ticket_log "worker backend=$backend mode=$mode cwd=$worktree_path (host-agent-invoke)"
  case "$backend" in claude|codex|grok) ;; *)
    ticket_die "unknown backend: $backend (claude|codex|grok)"
    ;;
  esac
  if [[ "$backend" == "claude" && -d "$worktree_path/.ticket" ]]; then
    add_dir="$worktree_path/.ticket"
  fi
  local -a base=(--backend "$backend" --mode "$mode" --cwd "$worktree_path" --prompt-file "$prompt_path" --log "$log_path")
  [[ -n "$add_dir" ]] && base+=(--add-dir "$add_dir")
  if [[ -z "$ticket_id" ]]; then
    host_agent_invoke_run "${base[@]}" || rc=$?
    [[ "$rc" -eq 0 ]] || ticket_log "warn: host-agent-invoke backend=$backend exited $rc (see $(basename "$log_path"))"
    return 0
  fi

  local root obs prep run_id run_dir extra reuse reason resume_id force=""
  root="$(ticket_store_root)"
  obs="$(ticket_tool_root)/lib/observe.py"
  local attempt
  for attempt in 1 2; do
    prep="$(env TICKETS_ROOT="$root" python3 "$obs" prepare-run --ticket "$ticket_id" \
      --phase "$phase" --role "$role" --backend "$backend" --prompt-file "$prompt_path" \
      --worktree "$worktree_path" --template "$(ticket_tool_root)/prompts/${phase}.md" \
      --view-file "$root/_data/${ticket_id}/ticket-view-${phase}.md" $force)" \
      || { ticket_log "warn: observe prepare-run failed; running unobserved"; host_agent_invoke_run "${base[@]}" || true; return 0; }
    run_id="$(jq -r '.run_id' <<<"$prep")"; run_dir="$(jq -r '.run_dir' <<<"$prep")"
    extra="$(jq -r '.extra' <<<"$prep")"; reuse="$(jq -r '.reuse' <<<"$prep")"
    reason="$(jq -r '.reason' <<<"$prep")"; resume_id="$(jq -r '.resume_id // ""' <<<"$prep")"
    ticket_log "run $run_id phase=$phase session=$reuse ($reason)"
    rc=0
    TICKETS_ROOT="$root" host_agent_invoke_run "${base[@]}" \
      --run-dir "$run_dir" --run-id "$run_id" --launch-extra "$extra" \
      --sink-py "$obs" --sink-arg "$ticket_id" ${resume_id:+--resume "$resume_id"} || rc=$?
    local fin
    fin="$(env TICKETS_ROOT="$root" python3 "$obs" finish-run --ticket "$ticket_id" \
      --role "$role" --run-id "$run_id" --worktree "$worktree_path" 2>/dev/null || true)"
    [[ -n "$fin" ]] && ticket_log "run $run_id end $(jq -c '{exit,reuse,turns,cache_hit_rate,cost_usd,wall_ms,rss_peak_mb}' <<<"$fin" 2>/dev/null)"
    # Resume can fail when the backend lost the session; retry once fresh.
    if [[ "$reuse" == "resume" && "$rc" -ne 0 && "$attempt" -eq 1 ]]; then
      ticket_log "warn: resume run exited $rc; retrying with a fresh session"
      force="--force-fresh --fresh-reason resume_failed"
      continue
    fi
    break
  done
  if [[ "$rc" -ne 0 ]]; then
    ticket_log "warn: host-agent-invoke backend=$backend exited $rc (see runs/$run_id.stream.jsonl)"
  fi
  return 0
}

# Render phase-sliced ticket view into stdout (full ticket stays on disk).
ticket_worker_phase_view() {
  local ticket_id=$1 phase=$2
  env TICKETS_ROOT="$(ticket_store_root)" \
    python3 "$(ticket_tool_root)/lib/ticket_fs.py" phase-view "$ticket_id" "$phase"
}

# Build prompt-${phase}.md. worktree_path may be empty for MOCK (no .ticket copy).
ticket_worker_prepare_prompt() {
  local ticket_id=$1 worktree_path=$2 phase=$3
  # phase: research | implement
  local root ticket_path prompt_path template local_result ticket_copy view_copy result_name view
  root="$(ticket_store_root)"
  ticket_path="$root/_data/${ticket_id}/ticket.md"
  prompt_path="$root/_data/${ticket_id}/prompt-${phase}.md"
  if [[ "$phase" == "implement" ]]; then
    template="$(ticket_tool_root)/prompts/implement.md"
    result_name="implement-result.json"
  else
    template="$(ticket_tool_root)/prompts/research.md"
    result_name="worker-result.json"
  fi

  view="$(ticket_worker_phase_view "$ticket_id" "$phase")" \
    || ticket_die "failed to render phase view ($phase) for $ticket_id" 2
  local dead_ends_text=""
  dead_ends_text="$(python3 "$(ticket_tool_root)/lib/dead_ends.py" read "$ticket_id" 2>/dev/null || true)"
  if [[ -n "$dead_ends_text" ]]; then
    view="$(printf '%s\n\n---\n\n%s' "$dead_ends_text" "$view")"
  fi
  printf '%s' "$view" >"$root/_data/${ticket_id}/ticket-view-${phase}.md"

  local_result=""
  if [[ -n "$worktree_path" ]]; then
    mkdir -p "$worktree_path/.ticket"
    ticket_copy="$worktree_path/.ticket/ticket.md"
    view_copy="$worktree_path/.ticket/ticket-view.md"
    local_result="$worktree_path/.ticket/${result_name}"
    cp -f "$ticket_path" "$ticket_copy"
    printf '%s' "$view" >"$view_copy"
    rm -f "$local_result" "$worktree_path/${result_name}"
  fi

  {
    sed \
      -e "s|{{TICKET_PATH}}|.ticket/ticket.md|g" \
      -e "s|{{TICKET_VIEW_PATH}}|.ticket/ticket-view.md|g" \
      -e "s|{{RESULT_PATH}}|.ticket/${result_name}|g" \
      -e "s|{{TICKET_ID}}|${ticket_id}|g" \
      "$template"
    printf '\n\n## Ticket phase view (embedded — authoritative for this hop)\n\n```markdown\n'
    printf '%s' "$view"
    printf '\n```\n'
    printf '\nFull ticket (omitted sections): `.ticket/ticket.md`. Write JSON to `.ticket/%s`.\n' "$result_name"
  } >"$prompt_path"

  printf '%s\n' "$prompt_path"
  printf '%s\n' "$local_result"
}

# Mark research_start + emit progress (shared by mock/live).
ticket_worker_mark_research_start() {
  local ticket_id=$1 backend=$2
  ticket_progress_emit "$ticket_id" "research_start" \
    "research phase started (backend=$backend)" --phase researching
}

# Run research worker. Args: ticket_id worktree_path backend
ticket_worker_research() {
  local ticket_id=$1 worktree_path=${2:-} backend=${3:-claude}
  local root ticket_path result_path
  root="$(ticket_store_root)"
  ticket_path="$root/_data/${ticket_id}/ticket.md"
  result_path="$root/_data/${ticket_id}/worker-result.json"
  rm -f "$result_path"

  ticket_worker_mark_research_start "$ticket_id" "$backend"
  ticket_progress_heartbeat_start "$ticket_id" "researching"

  if [[ "${TICKET_WORKER_MOCK:-0}" == "1" ]]; then
    ticket_log "worker MOCK research id=$ticket_id (via host-agent-invoke)"
    local prepared prompt_path mock_cwd
    prepared="$(ticket_worker_prepare_prompt "$ticket_id" "" research)"
    prompt_path="$(printf '%s\n' "$prepared" | sed -n '1p')"
    mock_cwd="$root/_data/${ticket_id}"
    mkdir -p "$mock_cwd"
    HOST_AGENT_INVOKE_MOCK=1 \
      HOST_AGENT_INVOKE_TRACE="${HOST_AGENT_INVOKE_TRACE:-$root/_data/${ticket_id}/host-invoke.trace.jsonl}" \
      ticket_worker_invoke "$backend" "$mock_cwd" "$prompt_path" \
      "$root/_data/${ticket_id}/worker.log" write "$ticket_id" research
    ticket_progress_heartbeat_stop "$ticket_id"
    ticket_worker_write_mock_result "$result_path" "$ticket_path"
    ticket_worker_apply_result "$ticket_id"
    return 0
  fi

  [[ -n "$worktree_path" && -d "$worktree_path" ]] || {
    ticket_progress_heartbeat_stop "$ticket_id"
    ticket_die "worktree required for live worker"
  }
  local prepared prompt_path local_result
  prepared="$(ticket_worker_prepare_prompt "$ticket_id" "$worktree_path" research)"
  prompt_path="$(printf '%s\n' "$prepared" | sed -n '1p')"
  local_result="$(printf '%s\n' "$prepared" | sed -n '2p')"

  ticket_worker_invoke "$backend" "$worktree_path" "$prompt_path" \
    "$root/_data/${ticket_id}/worker.log" write "$ticket_id" research
  ticket_progress_heartbeat_stop "$ticket_id"

  if [[ -f "$local_result" ]]; then
    cp -f "$local_result" "$result_path"
  elif [[ -f "$worktree_path/worker-result.json" ]]; then
    cp -f "$worktree_path/worker-result.json" "$result_path"
  fi
  if [[ ! -f "$result_path" ]]; then
    ticket_die "worker did not write result JSON — see worker.log" 2
  fi
  ticket_worker_apply_result "$ticket_id"
}

ticket_worker_mark_implement_start() {
  local ticket_id=$1 backend=$2
  env TICKETS_ROOT="$(ticket_store_root)" TOOL_ROOT="$(ticket_tool_root)" \
    ID="$ticket_id" BACKEND="$backend" python3 - <<'PY'
import importlib.util, os
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
tid = os.environ["ID"]
backend = os.environ.get("BACKEND") or "claude"
meta, body = mod.read_ticket(tid)
meta["status"] = "in_progress"
meta["owner"] = "worker"
meta["phase"] = "implementing"
mod.write_ticket(tid, meta, body)
mod.append_event(tid, {"type": "implement_start", "backend": backend})
mod.write_progress(
    tid,
    "implement_start",
    f"implement phase started (backend={backend})",
    phase="implementing",
    extra={"backend": backend},
)
mod.reindex()
PY
}

# Run implement worker. Args: ticket_id worktree_path backend
ticket_worker_implement() {
  local ticket_id=$1 worktree_path=${2:-} backend=${3:-claude}
  local root ticket_path result_path
  root="$(ticket_store_root)"
  ticket_path="$root/_data/${ticket_id}/ticket.md"
  result_path="$root/_data/${ticket_id}/implement-result.json"
  rm -f "$result_path"

  ticket_worker_mark_implement_start "$ticket_id" "$backend"
  ticket_progress_heartbeat_start "$ticket_id" "implementing"

  if [[ "${TICKET_WORKER_MOCK:-0}" == "1" ]]; then
    ticket_log "worker MOCK implement id=$ticket_id (via host-agent-invoke)"
    local prepared prompt_path mock_cwd
    prepared="$(ticket_worker_prepare_prompt "$ticket_id" "" implement)"
    prompt_path="$(printf '%s\n' "$prepared" | sed -n '1p')"
    mock_cwd="$root/_data/${ticket_id}"
    mkdir -p "$mock_cwd"
    HOST_AGENT_INVOKE_MOCK=1 \
      HOST_AGENT_INVOKE_TRACE="${HOST_AGENT_INVOKE_TRACE:-$root/_data/${ticket_id}/host-invoke.trace.jsonl}" \
      ticket_worker_invoke "$backend" "$mock_cwd" "$prompt_path" \
      "$root/_data/${ticket_id}/implement.log" write "$ticket_id" implement
    ticket_progress_heartbeat_stop "$ticket_id"
    ticket_worker_write_mock_implement_result "$result_path"
    ticket_worker_apply_implement_result "$ticket_id"
    return 0
  fi

  [[ -n "$worktree_path" && -d "$worktree_path" ]] || {
    ticket_progress_heartbeat_stop "$ticket_id"
    ticket_die "worktree required for live implement"
  }
  local prepared prompt_path local_result
  prepared="$(ticket_worker_prepare_prompt "$ticket_id" "$worktree_path" implement)"
  prompt_path="$(printf '%s\n' "$prepared" | sed -n '1p')"
  local_result="$(printf '%s\n' "$prepared" | sed -n '2p')"

  ticket_worker_invoke "$backend" "$worktree_path" "$prompt_path" \
    "$root/_data/${ticket_id}/implement.log" write "$ticket_id" implement
  ticket_progress_heartbeat_stop "$ticket_id"

  if [[ -f "$local_result" ]]; then
    cp -f "$local_result" "$result_path"
  elif [[ -f "$worktree_path/implement-result.json" ]]; then
    cp -f "$worktree_path/implement-result.json" "$result_path"
  fi
  if [[ ! -f "$result_path" ]]; then
    ticket_die "implement worker did not write result JSON — see implement.log" 2
  fi
  ticket_worker_apply_implement_result "$ticket_id"
}
