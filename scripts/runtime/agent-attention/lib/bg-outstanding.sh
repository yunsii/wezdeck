#!/usr/bin/env bash
# Background-task outstanding set for agent-attention.
#
# Sidecar (Claude / provisional): <attention-dir>/bg-sidecar/<session_id>.json
#   { "tasks": { "<id>": { "type":"shell", "summary":"…", "ts": <ms> } } }
#
# Collect merges provider Stop payloads (Grok backgroundTasks) with the
# sidecar, then filters by WEZTERM_ATTENTION_BG_TYPES (default: shell).
#
# Sourced by emit.sh. Requires attention-state-lib.sh already loaded
# (for attention_state_path / attention_state_now_ms).

set -u

bg_attention_dir() {
  local state_path
  state_path="$(attention_state_path)"
  printf '%s' "${state_path%/*}"
}

bg_sidecar_dir() {
  printf '%s/bg-sidecar' "$(bg_attention_dir)"
}

bg_sidecar_path() {
  local session_id="$1"
  # Sanitize path segment: session ids are UUIDs / pane:N; reject slashes.
  case "$session_id" in
    ''|*/*|*..*) printf ''; return 1 ;;
  esac
  printf '%s/%s.json' "$(bg_sidecar_dir)" "$session_id"
}

bg_types_allow() {
  # Comma/space separated. Default shell only.
  local raw="${WEZTERM_ATTENTION_BG_TYPES:-shell}"
  printf '%s' "$raw" | tr ', ' '\n\n' | tr '[:upper:]' '[:lower:]' \
    | sed '/^$/d'
}

bg_type_allowed() {
  local t="$1" allowed
  t="$(printf '%s' "$t" | tr '[:upper:]' '[:lower:]')"
  [[ -z "$t" ]] && t="shell"
  while IFS= read -r allowed; do
    [[ "$allowed" == "$t" ]] && return 0
  done < <(bg_types_allow)
  return 1
}

bg_sidecar_read() {
  local session_id="$1" path
  path="$(bg_sidecar_path "$session_id")" || { printf '%s' '{"tasks":{}}'; return 0; }
  if [[ -f "$path" ]] && command -v jq >/dev/null 2>&1; then
    if jq -e . "$path" >/dev/null 2>&1; then
      jq -c '{tasks:(.tasks // {})}' "$path" 2>/dev/null || printf '%s' '{"tasks":{}}'
      return 0
    fi
  fi
  printf '%s' '{"tasks":{}}'
}

bg_sidecar_write() {
  local session_id="$1" payload="$2" path dir tmp
  path="$(bg_sidecar_path "$session_id")" || return 1
  [[ -n "$payload" ]] || return 1
  dir="$(dirname "$path")"
  mkdir -p "$dir"
  tmp="${path}.tmp.$$"
  printf '%s\n' "$payload" >"$tmp"
  mv "$tmp" "$path"
}

# bg_sidecar_add <session_id> <task_id> [type] [summary]
bg_sidecar_add() {
  local session_id="$1" task_id="$2" typ="${3:-shell}" summary="${4:-}"
  local now current next
  [[ -n "$session_id" && -n "$task_id" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  bg_type_allowed "$typ" || return 0
  now="$(attention_state_now_ms)"
  current="$(bg_sidecar_read "$session_id")"
  next="$(jq -c --arg id "$task_id" --arg typ "$typ" --arg sum "$summary" \
    --argjson ts "$now" '
      .tasks[$id] = {
        type: $typ,
        summary: $sum,
        ts: $ts
      }
    ' <<<"$current")" || return 0
  bg_sidecar_write "$session_id" "$next" || true
}

bg_sidecar_remove_ids() {
  local session_id="$1"
  shift
  local current next id
  [[ -n "$session_id" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  current="$(bg_sidecar_read "$session_id")"
  next="$current"
  for id in "$@"; do
    [[ -n "$id" ]] || continue
    next="$(jq -c --arg id "$id" 'del(.tasks[$id])' <<<"$next")" || return 0
  done
  bg_sidecar_write "$session_id" "$next" || true
}

bg_sidecar_clear() {
  local session_id="$1" path
  path="$(bg_sidecar_path "$session_id")" || return 0
  rm -f "$path" 2>/dev/null || true
}

# Find Claude tasks dir for a session (best-effort under /tmp/claude-*).
bg_claude_tasks_dir() {
  local session_id="$1" d
  [[ -n "$session_id" ]] || return 1
  while IFS= read -r -d '' d; do
    printf '%s' "$d"
    return 0
  done < <(find /tmp -maxdepth 6 -type d -path "*/${session_id}/tasks" 2>/dev/null -print0)
  return 1
}

# Drop sidecar tasks whose Claude output shows exit, or missing+stale.
# Keeps empty outputs (still running). Returns remaining tasks JSON array.
bg_reconcile_claude_sidecar() {
  local session_id="$1"
  local current tasks_dir next removed id path data
  command -v jq >/dev/null 2>&1 || { bg_sidecar_list_json "$session_id"; return 0; }
  current="$(bg_sidecar_read "$session_id")"
  tasks_dir="$(bg_claude_tasks_dir "$session_id" 2>/dev/null || true)"
  removed=()
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    if [[ -z "$tasks_dir" ]]; then
      continue
    fi
    path="$tasks_dir/${id}.output"
    if [[ -L "$path" ]]; then
      # subagent symlink — not a shell bg task we track
      removed+=("$id")
      continue
    fi
    if [[ -f "$path" ]]; then
      data="$(head -c 8192 "$path" 2>/dev/null || true)"
      if [[ "$data" == *"[exited with code"* ]]; then
        removed+=("$id")
      fi
    fi
    # Missing output file: leave in sidecar (may not have been created yet).
  done < <(jq -r '.tasks // {} | keys[]' <<<"$current" 2>/dev/null || true)

  if [[ ${#removed[@]} -gt 0 ]]; then
    bg_sidecar_remove_ids "$session_id" "${removed[@]}"
  fi
  bg_sidecar_list_json "$session_id"
}

bg_sidecar_list_json() {
  local session_id="$1"
  command -v jq >/dev/null 2>&1 || { printf '%s' '[]'; return 0; }
  bg_sidecar_read "$session_id" | jq -c '
    [(.tasks // {}) | to_entries[] | {
      id: .key,
      type: (.value.type // "shell"),
      summary: (.value.summary // "")
    }]
  ' 2>/dev/null || printf '%s' '[]'
}

# Parse Grok/Claude-compat Stop backgroundTasks into normalized array JSON.
bg_parse_stop_tasks_json() {
  local stdin_json="${1:-}"
  if [[ -z "$stdin_json" ]] || ! command -v jq >/dev/null 2>&1; then
    printf '%s' '[]'
    return 0
  fi
  printf '%s' "$stdin_json" | jq -c '
    def arr: if . == null then [] elif type == "array" then . else [] end;
    [((.backgroundTasks // .background_tasks // null) | arr)[]
      | {
          id: (.id // .taskId // .task_id // ""),
          type: ((.type // .taskType // "shell") | ascii_downcase),
          summary: (
            .command // .description // .summary // ""
            | tostring | .[0:120]
          )
        }
      | select(.id != "")
    ]
  ' 2>/dev/null || printf '%s' '[]'
}

# Merge sidecar + stop payload, filter by allowed types → JSON array.
# Usage: bg_collect_outstanding <session_id> [stdin_json]
bg_collect_outstanding() {
  local session_id="$1" stdin_json="${2:-}"
  local from_side from_stop
  command -v jq >/dev/null 2>&1 || { printf '%s' '[]'; return 0; }

  # Reconcile Claude outputs before merge.
  from_side="$(bg_reconcile_claude_sidecar "$session_id")"
  from_stop="$(bg_parse_stop_tasks_json "$stdin_json")"

  local allow_json
  allow_json="$(bg_types_allow | jq -R . | jq -s -c .)"

  jq -c -n --argjson side "$from_side" --argjson stop "$from_stop" \
    --argjson allow "$allow_json" '
      def ok($t):
        (($t // "shell") | ascii_downcase) as $x
        | ($allow | index($x)) != null;
      ([ $side[] | select(ok(.type)) ]
       + [ $stop[] | select(ok(.type)) ])
      | unique_by(.id)
    ' 2>/dev/null || printf '%s' '[]'
}

# Try to open a bg account from a Pre/PostToolUse payload (Bash).
# Returns 0 if an id was added.
bg_track_from_tool_payload() {
  local session_id="$1" stdin_json="${2:-}"
  [[ -n "$session_id" && -n "$stdin_json" ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1

  local meta
  meta="$(printf '%s' "$stdin_json" | jq -c '
    def tool:
      (.tool_name // .toolName // .tool.name // "");
    def input:
      (.tool_input // .toolInput // .input // {});
    def result:
      (.tool_result // .toolResult // .tool_response // {});
    (tool | ascii_downcase) as $tn
    | (input) as $in
    | (result) as $res
    | {
        is_bash: ($tn == "bash" or $tn == "run_terminal_command"),
        run_bg: (
          ($in.run_in_background // $in.runInBackground // false) == true
          or ($in.background // false) == true
        ),
        bg_user: (
          ($res.backgroundedByUser // $res.backgrounded_by_user // false) == true
        ),
        task_id: (
          $res.backgroundTaskId // $res.background_task_id
          // $res.taskId // $res.task_id
          // $in.backgroundTaskId // ""
          | tostring
        ),
        summary: (
          $in.command // $in.description // ""
          | tostring | .[0:120]
        )
      }
  ' 2>/dev/null || true)"

  [[ -n "$meta" ]] || return 1

  local is_bash run_bg bg_user task_id summary
  is_bash="$(jq -r '.is_bash' <<<"$meta")"
  run_bg="$(jq -r '.run_bg' <<<"$meta")"
  bg_user="$(jq -r '.bg_user' <<<"$meta")"
  task_id="$(jq -r '.task_id // empty' <<<"$meta")"
  summary="$(jq -r '.summary // empty' <<<"$meta")"

  [[ "$is_bash" == "true" ]] || return 1
  if [[ "$run_bg" != "true" && "$bg_user" != "true" && -z "$task_id" ]]; then
    return 1
  fi
  if [[ -z "$task_id" ]]; then
    # Provisional id until PostToolUse supplies the real one.
    task_id="provisional-$(printf '%s' "$summary" | sha1sum 2>/dev/null | cut -c1-10)"
    [[ "$task_id" == "provisional-" ]] && task_id="provisional-unknown"
  fi
  bg_sidecar_add "$session_id" "$task_id" "shell" "$summary"
  return 0
}

# Build a short reason line from outstanding JSON array.
bg_reason_from_outstanding() {
  local outstanding_json="${1:-[]}"
  command -v jq >/dev/null 2>&1 || { printf '%s' 'bg·shell'; return 0; }
  jq -r '
    if (type != "array") or (length == 0) then "bg·shell"
    else
      (.[0].type // "shell") as $t
      | (.[0].summary // .[0].id // "") as $s
      | if $s == "" then "bg·\($t)"
        else "bg·\($t): \($s)"
        end
      | .[0:120]
    end
  ' <<<"$outstanding_json" 2>/dev/null || printf '%s' 'bg·shell'
}

# Bump ts + refresh bg snapshot for entries still in running_kind=background
# whose outstanding set is non-empty. Drops to done (via caller) is NOT done
# here — emit's next Stop/reconcile owns that. Returns count bumped.
bg_bump_alive_entries() {
  local path lock current next now count
  command -v jq >/dev/null 2>&1 || return 0
  path="$(attention_state_path)"
  [[ -f "$path" ]] || return 0
  now="$(attention_state_now_ms)"
  lock="$(attention_state_lock_path)"
  (
    flock -x 9
    current="$(attention_state_read)"
    # For each background entry, reconcile sidecar and refresh ts/bg when
    # still outstanding; demote to done when empty (so TTL/focus paths see
    # a terminal state without waiting for another Stop).
    next="$current"
    while IFS= read -r sid; do
      [[ -n "$sid" ]] || continue
      outstanding="$(bg_collect_outstanding "$sid" "")"
      if [[ "$(jq -r 'length' <<<"$outstanding" 2>/dev/null || echo 0)" -gt 0 ]]; then
        next="$(jq -c --arg sid "$sid" --argjson ts "$now" --argjson tasks "$outstanding" \
          --arg reason "$(bg_reason_from_outstanding "$outstanding")" '
            if (.entries[$sid] // null) == null then .
            else
              .entries[$sid].ts = $ts
              | .entries[$sid].running_kind = "background"
              | .entries[$sid].status = "running"
              | .entries[$sid].bg = {tasks: $tasks}
              | .entries[$sid].reason = $reason
            end
          ' <<<"$next")" || true
      else
        # No outstanding left: flip to done in place (keep sticky fields).
        next="$(jq -c --arg sid "$sid" --argjson ts "$now" '
            if (.entries[$sid] // null) == null then .
            else
              .entries[$sid].status = "done"
              | .entries[$sid].reason = "bg finished"
              | .entries[$sid].ts = $ts
              | del(.entries[$sid].running_kind, .entries[$sid].bg)
            end
          ' <<<"$next")" || true
        bg_sidecar_clear "$sid"
      fi
    done < <(jq -r '
      (.entries // {}) | to_entries[]
      | select(.value.status == "running" and (.value.running_kind // "") == "background")
      | .key
    ' <<<"$current" 2>/dev/null || true)
    attention_state_write "$next"
  ) 9>"$lock"
}

