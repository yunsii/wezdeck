#!/usr/bin/env bash
# Human-handoff run store: agent proposes a script; human peeks/runs via `x`.
# Agent self-exec is out of scope — this store only holds handoff payloads.
#
# Layout (WSL ext4 via wsl-runtime-paths-lib.sh):
#   state/agent-run/HEAD.json
#   state/agent-run/entries/<id>.json   # body immutable; status/result mutate under flock
#   logs/agent-run.jsonl                # append-only audit
#
# Concurrency: single-slot HEAD + CAS on run. Peek never leases HEAD.
# Fail-closed on write/CAS (unlike hook-side fail-open ledgers).
# Retention (like runtime.log): prune old entries + rotate audit jsonl.
# cwd is required and must resolve to an existing absolute directory.

# shellcheck disable=SC2034

AGENT_RUN_VERSION=1
AGENT_RUN_EXIT_SUPERSEDED=2
AGENT_RUN_EXIT_BUSY=3
AGENT_RUN_EXIT_MISSING=4
AGENT_RUN_EXIT_CANCELLED=5
AGENT_RUN_EXIT_TIMEOUT=124

# Caps — override via env for tests / tight hosts.
: "${AGENT_RUN_ENTRY_KEEP:=50}"
: "${AGENT_RUN_AUDIT_ROTATE_BYTES:=5242880}"
: "${AGENT_RUN_AUDIT_ROTATE_COUNT:=5}"

__AGENT_RUN_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

agent_run_init_paths() {
  # shellcheck disable=SC1091
  . "$__AGENT_RUN_LIB_DIR/wsl-runtime-paths-lib.sh"
  AGENT_RUN_DIR="$WSL_AGENT_RUN_DIR"
  AGENT_RUN_HEAD_FILE="$WSL_AGENT_RUN_HEAD_FILE"
  AGENT_RUN_ENTRIES_DIR="$WSL_AGENT_RUN_ENTRIES_DIR"
  AGENT_RUN_AUDIT_FILE="$WSL_AGENT_RUN_AUDIT_FILE"
  AGENT_RUN_LOCK_FILE="${AGENT_RUN_HEAD_FILE}.lock"
}

agent_run_ensure_dirs() {
  agent_run_init_paths
  mkdir -p "$AGENT_RUN_ENTRIES_DIR" "$(dirname "$AGENT_RUN_AUDIT_FILE")" || return 1
}

agent_run_now_ms() {
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    printf '%s\n' "$(( ${EPOCHREALTIME//./} / 1000 ))"
    return 0
  fi
  date +%s%3N 2>/dev/null || date +%s000
}

agent_run_new_id() {
  local ms rand
  ms="$(agent_run_now_ms)"
  if command -v openssl >/dev/null 2>&1; then
    rand="$(openssl rand -hex 6 2>/dev/null || true)"
  fi
  if [[ -z "${rand:-}" ]]; then
    rand="$(printf '%04x%04x' "$RANDOM" "$RANDOM")"
  fi
  printf 'ar%s%s\n' "$ms" "$rand"
}

agent_run_sha256() {
  local data="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$data" | sha256sum | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$data" | shasum -a 256 | awk '{print $1}'
    return 0
  fi
  printf 'nosha\n'
}

agent_run_require_jq() {
  command -v jq >/dev/null 2>&1 || {
    printf 'wd-run: jq is required\n' >&2
    return 1
  }
}

# Atomic write of non-empty payload (attention_state_write pattern).
agent_run_write_file() {
  local path="$1" payload="$2" tmp
  [[ -n "$payload" ]] || return 1
  tmp="${path}.tmp.$$"
  printf '%s\n' "$payload" >"$tmp" || {
    rm -f "$tmp"
    return 1
  }
  mv -f "$tmp" "$path"
}

# Resolve and validate cwd: must exist, become absolute canonical path.
# Usage: agent_run_resolve_cwd <path>  → prints abs path or fails.
agent_run_resolve_cwd() {
  local raw="${1:-}"
  local abs
  if [[ -z "$raw" ]]; then
    printf 'wd-run: --cwd is required (absolute or resolvable directory)\n' >&2
    return 1
  fi
  if [[ ! -d "$raw" ]]; then
    printf 'wd-run: cwd does not exist or is not a directory: %s\n' "$raw" >&2
    return 1
  fi
  abs="$(cd "$raw" && pwd -P)" || {
    printf 'wd-run: cannot resolve cwd: %s\n' "$raw" >&2
    return 1
  }
  if [[ "$abs" != /* ]]; then
    printf 'wd-run: cwd must resolve to an absolute path: %s\n' "$abs" >&2
    return 1
  fi
  printf '%s\n' "$abs"
}

agent_run_file_size() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    printf '0\n'
    return 0
  fi
  wc -c <"$file" | tr -d '[:space:]'
}

# Rotate audit jsonl when over AGENT_RUN_AUDIT_ROTATE_BYTES (runtime.log pattern).
agent_run_audit_rotate_if_needed() {
  local file max_bytes max_files size index next_index
  agent_run_init_paths
  file="$AGENT_RUN_AUDIT_FILE"
  max_bytes="${AGENT_RUN_AUDIT_ROTATE_BYTES:-0}"
  max_files="${AGENT_RUN_AUDIT_ROTATE_COUNT:-0}"
  [[ "$max_bytes" =~ ^[0-9]+$ && "$max_files" =~ ^[0-9]+$ ]] || return 0
  (( max_bytes > 0 && max_files > 0 )) || return 0
  [[ -f "$file" ]] || return 0
  size="$(agent_run_file_size "$file")"
  [[ "$size" =~ ^[0-9]+$ ]] || return 0
  (( size >= max_bytes )) || return 0
  [[ -f "$file.$max_files" ]] && rm -f "$file.$max_files"
  for (( index=max_files-1; index>=1; index-=1 )); do
    if [[ -f "$file.$index" ]]; then
      next_index=$((index + 1))
      mv "$file.$index" "$file.$next_index"
    fi
  done
  mv "$file" "$file.1"
}

# Prune entry files down to AGENT_RUN_ENTRY_KEEP.
# Never delete HEAD id or status=running. Prefer deleting oldest by created_ms
# among terminal statuses (done/failed/cancelled/superseded), then oldest pending
# that is not HEAD. Caller should hold flock when invoked from propose.
agent_run_gc_entries() {
  local keep head_id count path id created status
  agent_run_init_paths
  keep="${AGENT_RUN_ENTRY_KEEP:-50}"
  [[ "$keep" =~ ^[0-9]+$ ]] || keep=50
  (( keep >= 1 )) || keep=1
  head_id=""
  if [[ -s "$AGENT_RUN_HEAD_FILE" ]]; then
    head_id="$(jq -r '.id // empty' "$AGENT_RUN_HEAD_FILE" 2>/dev/null || true)"
  fi
  count="$(find "$AGENT_RUN_ENTRIES_DIR" -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l | tr -d '[:space:]')"
  [[ "$count" =~ ^[0-9]+$ ]] || return 0
  (( count > keep )) || return 0

  # Build TSV: created_ms \t protect(0/1) \t path  — unprotected first, oldest first.
  local list
  list="$(
    for path in "$AGENT_RUN_ENTRIES_DIR"/*.json; do
      [[ -f "$path" ]] || continue
      id="$(basename "$path" .json)"
      created="$(jq -r '.created_ms // 0' "$path" 2>/dev/null || printf '0')"
      status="$(jq -r '.status // empty' "$path" 2>/dev/null || true)"
      protect=0
      if [[ "$id" == "$head_id" || "$status" == "running" ]]; then
        protect=1
      fi
      printf '%s\t%s\t%s\n' "$created" "$protect" "$path"
    done | sort -t $'\t' -k2,2n -k1,1n
  )"

  local deleted=0
  local excess=$((count - keep))
  while IFS=$'\t' read -r created protect path; do
    (( deleted < excess )) || break
    [[ -n "$path" ]] || continue
    [[ "$protect" == "0" ]] || continue
    rm -f "$path"
    deleted=$((deleted + 1))
  done <<<"$list"
}

agent_run_entry_path() {
  local id="$1"
  agent_run_init_paths
  printf '%s/%s.json' "$AGENT_RUN_ENTRIES_DIR" "$id"
}

agent_run_read_head_id() {
  agent_run_init_paths
  [[ -s "$AGENT_RUN_HEAD_FILE" ]] || return 1
  agent_run_require_jq || return 1
  jq -r '.id // empty' "$AGENT_RUN_HEAD_FILE" 2>/dev/null
}

agent_run_read_entry() {
  local id="$1" path
  path="$(agent_run_entry_path "$id")"
  [[ -s "$path" ]] || return 1
  cat "$path"
}

agent_run_audit() {
  local action="$1" id="$2" identity="$3" result="$4" reason="${5:-}" preview="${6:-}"
  local cwd summary body_hash ts line
  agent_run_ensure_dirs || return 0
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  cwd=""
  summary=""
  body_hash=""
  if [[ -n "$id" ]]; then
    local path
    path="$(agent_run_entry_path "$id")"
    if [[ -s "$path" ]] && command -v jq >/dev/null 2>&1; then
      cwd="$(jq -r '.session.cwd // empty' "$path" 2>/dev/null || true)"
      summary="$(jq -r '.summary // empty' "$path" 2>/dev/null || true)"
      body_hash="$(jq -r '.body_sha256 // empty' "$path" 2>/dev/null || true)"
      if [[ -z "$preview" ]]; then
        preview="$(jq -r '.body // empty' "$path" 2>/dev/null | head -c 80 || true)"
      fi
    fi
  fi
  preview="${preview//$'\n'/ }"
  if ((${#preview} > 80)); then
    preview="${preview:0:80}"
  fi
  agent_run_audit_rotate_if_needed || true
  if command -v jq >/dev/null 2>&1; then
    line="$(jq -nc \
      --arg ts "$ts" \
      --arg action "$action" \
      --arg id "$id" \
      --arg identity "$identity" \
      --arg cwd "$cwd" \
      --arg summary "$summary" \
      --arg preview "$preview" \
      --arg body_hash "$body_hash" \
      --arg result "$result" \
      --arg reason "$reason" \
      '{ts:$ts,action:$action,id:$id,identity:$identity,cwd:$cwd,summary:$summary,preview:$preview,body_hash:$body_hash,result:$result,reason:$reason}')"
  else
    line="{\"ts\":\"$ts\",\"action\":\"$action\",\"id\":\"$id\",\"result\":\"$result\"}"
  fi
  printf '%s\n' "$line" >>"$AGENT_RUN_AUDIT_FILE" 2>/dev/null || true
}

# Mark previous HEAD entry superseded (best-effort; under caller flock).
agent_run_mark_superseded() {
  local old_id="$1" path payload
  [[ -n "$old_id" ]] || return 0
  path="$(agent_run_entry_path "$old_id")"
  [[ -s "$path" ]] || return 0
  payload="$(jq -c '
    if .status == "pending" then
      .status = "superseded"
    else
      .
    end
  ' "$path" 2>/dev/null)" || return 0
  agent_run_write_file "$path" "$payload" || true
}

# propose: write immutable entry + atomically point HEAD. Prints id on stdout.
# cwd is mandatory and must resolve to an existing directory.
# Usage: agent_run_propose <actor> <cwd> <summary> <body>
agent_run_propose() {
  local actor="${1:-unknown}"
  local cwd_raw="${2:-}"
  local summary="${3:-}"
  local body="${4:-}"
  local id ms hash entry_json head_json old_id path cwd pane

  agent_run_require_jq || return 1
  agent_run_ensure_dirs || return 1
  [[ -n "$body" ]] || {
    printf 'wd-run propose: empty body\n' >&2
    return 1
  }
  cwd="$(agent_run_resolve_cwd "$cwd_raw")" || return 1
  if [[ -z "$summary" ]]; then
    summary="$(printf '%s' "$body" | head -n 1 | head -c 80)"
  fi
  if ((${#summary} > 80)); then
    summary="${summary:0:80}"
  fi

  id="$(agent_run_new_id)"
  ms="$(agent_run_now_ms)"
  hash="$(agent_run_sha256 "$body")"
  pane="${TMUX_PANE:-}"

  entry_json="$(jq -nc \
    --argjson version "$AGENT_RUN_VERSION" \
    --arg id "$id" \
    --argjson created_ms "$ms" \
    --arg actor "$actor" \
    --arg cwd "$cwd" \
    --arg pane "$pane" \
    --arg summary "$summary" \
    --arg body "$body" \
    --arg body_sha256 "$hash" \
    '{
      version: $version,
      id: $id,
      created_ms: $created_ms,
      actor: $actor,
      session: {tmux_session: "", pane_id: $pane, cwd: $cwd},
      summary: $summary,
      interpreter: "bash",
      body: $body,
      body_sha256: $body_sha256,
      status: "pending",
      result: {exit_code: null, finished_ms: null, runner: null}
    }')" || return 1

  path="$(agent_run_entry_path "$id")"
  agent_run_write_file "$path" "$entry_json" || return 1

  old_id=""
  if [[ -s "$AGENT_RUN_HEAD_FILE" ]]; then
    old_id="$(jq -r '.id // empty' "$AGENT_RUN_HEAD_FILE" 2>/dev/null || true)"
  fi

  (
    flock -x 9 || exit 1
    # Re-read under lock in case of concurrent propose.
    locked_old=""
    if [[ -s "$AGENT_RUN_HEAD_FILE" ]]; then
      locked_old="$(jq -r '.id // empty' "$AGENT_RUN_HEAD_FILE" 2>/dev/null || true)"
    fi
    if [[ -n "$locked_old" && "$locked_old" != "$id" ]]; then
      agent_run_mark_superseded "$locked_old"
      printf '%s\n' "$locked_old" >"${AGENT_RUN_DIR}/.last_superseded.$$"
    fi
    head_json="$(jq -nc \
      --argjson version "$AGENT_RUN_VERSION" \
      --arg id "$id" \
      --argjson updated_ms "$ms" \
      '{version:$version,id:$id,updated_ms:$updated_ms}')" || exit 1
    agent_run_write_file "$AGENT_RUN_HEAD_FILE" "$head_json" || exit 1
    agent_run_gc_entries || true
  ) 9>"$AGENT_RUN_LOCK_FILE" || return 1

  if [[ -f "${AGENT_RUN_DIR}/.last_superseded.$$" ]]; then
    old_id="$(cat "${AGENT_RUN_DIR}/.last_superseded.$$")"
    rm -f "${AGENT_RUN_DIR}/.last_superseded.$$"
    agent_run_audit "supersede" "$old_id" "$actor" "ok" "replaced_by=$id" || true
  fi
  agent_run_audit "propose" "$id" "$actor" "ok" "" || true

  # Optional runtime diagnostic (never the audit source of truth).
  if [[ -f "$__AGENT_RUN_LIB_DIR/runtime-log-lib.sh" ]]; then
    # shellcheck disable=SC1091
    . "$__AGENT_RUN_LIB_DIR/runtime-log-lib.sh"
    runtime_log_info agent_run "handoff proposed" "id=$id" "actor=$actor" "cwd=$cwd" 2>/dev/null || true
  fi

  printf '%s\n' "$id"
}

# CAS: claim pending entry for run if it is still HEAD (unless allow_non_head=1).
# On success prints entry path and sets status=running. Exit codes: see AGENT_RUN_EXIT_*.
# Usage: agent_run_cas_claim <expected_id> [allow_non_head]
agent_run_cas_claim() {
  local expected_id="$1"
  local allow_non_head="${2:-0}"
  local runner="${3:-human:$(hostname -s 2>/dev/null || echo host):$$}"
  local head_id path payload ms

  agent_run_require_jq || return 1
  agent_run_ensure_dirs || return 1
  [[ -n "$expected_id" ]] || return "$AGENT_RUN_EXIT_MISSING"

  (
    flock -x 9 || exit 1
    head_id=""
    if [[ -s "$AGENT_RUN_HEAD_FILE" ]]; then
      head_id="$(jq -r '.id // empty' "$AGENT_RUN_HEAD_FILE" 2>/dev/null || true)"
    fi
    if [[ "$allow_non_head" != "1" && "$head_id" != "$expected_id" ]]; then
      printf 'superseded head=%s expected=%s\n' "${head_id:-}" "$expected_id" >&2
      exit "$AGENT_RUN_EXIT_SUPERSEDED"
    fi
    path="$(agent_run_entry_path "$expected_id")"
    if [[ ! -s "$path" ]]; then
      printf 'missing entry id=%s\n' "$expected_id" >&2
      exit "$AGENT_RUN_EXIT_MISSING"
    fi
    local status
    status="$(jq -r '.status // empty' "$path" 2>/dev/null || true)"
    if [[ "$status" != "pending" ]]; then
      printf 'busy status=%s id=%s\n' "$status" "$expected_id" >&2
      exit "$AGENT_RUN_EXIT_BUSY"
    fi
    ms="$(agent_run_now_ms)"
    payload="$(jq -c \
      --arg runner "$runner" \
      --argjson ms "$ms" \
      '.status = "running" | .result.runner = $runner' "$path")" || exit 1
    agent_run_write_file "$path" "$payload" || exit 1
    printf '%s\n' "$path"
  ) 9>"$AGENT_RUN_LOCK_FILE"
}

agent_run_finish() {
  local id="$1"
  local exit_code="$2"
  local path payload ms status_word

  agent_run_require_jq || return 1
  path="$(agent_run_entry_path "$id")"
  ms="$(agent_run_now_ms)"
  if [[ "$exit_code" -eq 0 ]]; then
    status_word="done"
  else
    status_word="failed"
  fi
  (
    flock -x 9 || exit 1
    [[ -s "$path" ]] || exit 1
    payload="$(jq -c \
      --arg status "$status_word" \
      --argjson code "$exit_code" \
      --argjson ms "$ms" \
      '.status = $status | .result.exit_code = $code | .result.finished_ms = $ms' "$path")" || exit 1
    agent_run_write_file "$path" "$payload" || exit 1
  ) 9>"$AGENT_RUN_LOCK_FILE" || return 1

  if [[ "$exit_code" -eq 0 ]]; then
    agent_run_audit "run_ok" "$id" "human" "ok" "exit_code=$exit_code" || true
  else
    agent_run_audit "run_fail" "$id" "human" "fail" "exit_code=$exit_code" || true
  fi
}

# Execute claimed entry body in its recorded cwd. Caller must have cas_claim'd.
# Refuses to run if session.cwd is missing or no longer a directory.
agent_run_exec_body() {
  local id="$1"
  local path body cwd tmp status
  path="$(agent_run_entry_path "$id")"
  [[ -s "$path" ]] || return 1
  agent_run_require_jq || return 1
  body="$(jq -r '.body // empty' "$path")"
  cwd="$(jq -r '.session.cwd // empty' "$path")"
  [[ -n "$body" ]] || return 1
  if [[ -z "$cwd" ]]; then
    printf 'wd-run: entry %s has empty cwd; refuse to run\n' "$id" >&2
    agent_run_finish "$id" 1
    return 1
  fi
  if [[ ! -d "$cwd" ]]; then
    printf 'wd-run: entry cwd no longer exists: %s\n' "$cwd" >&2
    agent_run_finish "$id" 1
    return 1
  fi

  agent_run_audit "run_start" "$id" "human" "ok" "cwd=$cwd" || true
  tmp="$(mktemp -t "wd-run.${id}.XXXXXX")"
  printf '%s\n' "$body" >"$tmp"
  chmod u+x "$tmp" 2>/dev/null || true
  status=0
  (
    cd "$cwd" || exit 1
    bash "$tmp"
  ) || status=$?
  rm -f "$tmp"
  agent_run_finish "$id" "$status"
  return "$status"
}

agent_run_cancel() {
  local id="${1:-}"
  local path payload head_id

  agent_run_require_jq || return 1
  agent_run_ensure_dirs || return 1

  (
    flock -x 9 || exit 1
    if [[ -z "$id" ]]; then
      id="$(jq -r '.id // empty' "$AGENT_RUN_HEAD_FILE" 2>/dev/null || true)"
    fi
    [[ -n "$id" ]] || exit "$AGENT_RUN_EXIT_MISSING"
    path="$(agent_run_entry_path "$id")"
    [[ -s "$path" ]] || exit "$AGENT_RUN_EXIT_MISSING"
    local status
    status="$(jq -r '.status // empty' "$path")"
    if [[ "$status" != "pending" ]]; then
      printf 'cannot cancel status=%s\n' "$status" >&2
      exit "$AGENT_RUN_EXIT_BUSY"
    fi
    payload="$(jq -c '.status = "cancelled"' "$path")" || exit 1
    agent_run_write_file "$path" "$payload" || exit 1
    printf '%s\n' "$id"
  ) 9>"$AGENT_RUN_LOCK_FILE"
  local rc=$?
  [[ $rc -eq 0 ]] || return "$rc"
  agent_run_audit "cancel" "$id" "human" "ok" "" || true
  return 0
}

agent_run_format_preview() {
  local id="$1"
  local path json
  path="$(agent_run_entry_path "$id")"
  [[ -s "$path" ]] || return 1
  json="$(cat "$path")"
  # Never use a printf format that begins with '-' (bash printf treats it as flags).
  printf '%s\n' "id:      $(jq -r '.id' <<<"$json")"
  printf '%s\n' "status:  $(jq -r '.status' <<<"$json")"
  printf '%s\n' "actor:   $(jq -r '.actor' <<<"$json")"
  printf '%s\n' "cwd:     $(jq -r '.session.cwd' <<<"$json")"
  printf '%s\n' "summary: $(jq -r '.summary' <<<"$json")"
  printf '%s\n' "sha256:  $(jq -r '.body_sha256' <<<"$json")"
  printf '%s\n' '' '----- script -----'
  jq -r '.body' <<<"$json"
  printf '%s\n' '----- end -----'
}

# Block until entry reaches a terminal status. For agent "background task"
# wait — no attention/status badges; just exit when the human finished `x`.
# Usage: agent_run_wait <id> [timeout_sec] [interval_sec]
# Exit: script exit_code on done/failed; 2 superseded; 5 cancelled; 124 timeout; 4 missing.
agent_run_wait() {
  local id="${1:-}"
  local timeout_sec="${2:-0}"
  local interval_sec="${3:-1}"
  local path status code started now elapsed

  agent_run_require_jq || return 1
  agent_run_ensure_dirs || return 1
  [[ -n "$id" ]] || return "$AGENT_RUN_EXIT_MISSING"
  [[ "$timeout_sec" =~ ^[0-9]+$ ]] || timeout_sec=0
  [[ "$interval_sec" =~ ^[0-9]+$ ]] || interval_sec=1
  (( interval_sec >= 1 )) || interval_sec=1

  path="$(agent_run_entry_path "$id")"
  [[ -s "$path" ]] || {
    printf 'wd-run wait: missing entry id=%s\n' "$id" >&2
    return "$AGENT_RUN_EXIT_MISSING"
  }

  started="$(agent_run_now_ms)"
  agent_run_audit "wait_start" "$id" "agent" "ok" "timeout_sec=$timeout_sec" || true

  while true; do
    [[ -s "$path" ]] || {
      printf 'wd-run wait: entry disappeared id=%s\n' "$id" >&2
      return "$AGENT_RUN_EXIT_MISSING"
    }
    status="$(jq -r '.status // empty' "$path" 2>/dev/null || true)"
    case "$status" in
      done|failed)
        code="$(jq -r '.result.exit_code // 1' "$path" 2>/dev/null || printf '1')"
        [[ "$code" =~ ^[0-9]+$ ]] || code=1
        agent_run_audit "wait_end" "$id" "agent" "ok" "status=$status exit_code=$code" || true
        return "$code"
        ;;
      cancelled)
        agent_run_audit "wait_end" "$id" "agent" "ok" "status=cancelled" || true
        printf 'wd-run wait: cancelled id=%s\n' "$id" >&2
        return "$AGENT_RUN_EXIT_CANCELLED"
        ;;
      superseded)
        agent_run_audit "wait_end" "$id" "agent" "ok" "status=superseded" || true
        printf 'wd-run wait: superseded id=%s\n' "$id" >&2
        return "$AGENT_RUN_EXIT_SUPERSEDED"
        ;;
      pending|running)
        ;;
      *)
        printf 'wd-run wait: unknown status=%s id=%s\n' "$status" "$id" >&2
        return 1
        ;;
    esac

    if (( timeout_sec > 0 )); then
      now="$(agent_run_now_ms)"
      elapsed=$(( (now - started) / 1000 ))
      if (( elapsed >= timeout_sec )); then
        agent_run_audit "wait_end" "$id" "agent" "fail" "timeout_sec=$timeout_sec" || true
        printf 'wd-run wait: timeout after %ss id=%s\n' "$timeout_sec" "$id" >&2
        return "$AGENT_RUN_EXIT_TIMEOUT"
      fi
    fi
    sleep "$interval_sec"
  done
}
