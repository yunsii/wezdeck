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

# Claude session harness status for a session_id: shell|busy|idle|waiting|…
# Empty when no alive ~/.claude/sessions/*.json matches.
bg_claude_session_status() {
  local session_id="$1"
  [[ -n "$session_id" ]] || { printf ''; return 0; }
  python3 - "$session_id" <<'PY' 2>/dev/null || true
import json, glob, os, sys
sid = sys.argv[1]
for path in glob.glob(os.path.expanduser("~/.claude/sessions/*.json")):
    try:
        d = json.load(open(path))
    except Exception:
        continue
    if (d.get("sessionId") or d.get("session_id")) != sid:
        continue
    pid = d.get("pid")
    if not pid or not os.path.exists(f"/proc/{pid}"):
        continue
    print(d.get("status") or "")
    break
PY
}

# Scan Claude tasks dir for non-exited shell outputs → outstanding JSON array.
bg_live_task_outputs_json() {
  local session_id="$1" tasks_dir
  command -v jq >/dev/null 2>&1 || { printf '%s' '[]'; return 0; }
  tasks_dir="$(bg_claude_tasks_dir "$session_id" 2>/dev/null || true)"
  if [[ -z "$tasks_dir" || ! -d "$tasks_dir" ]]; then
    printf '%s' '[]'
    return 0
  fi
  python3 - "$tasks_dir" <<'PY' 2>/dev/null || printf '%s' '[]'
import json, os, sys
from pathlib import Path
root = Path(sys.argv[1])
out = []
for p in sorted(root.glob("*.output")):
    if p.is_symlink():
        continue
    try:
        data = p.read_text(errors="replace")
    except Exception:
        continue
    if "[exited with code" in data:
        continue
    name = p.name[: -len(".output")] if p.name.endswith(".output") else p.name
    out.append({"id": name, "type": "shell", "summary": f"task:{name}"})
print(json.dumps(out, ensure_ascii=False))
PY
}

# Merge sidecar collect + entry.bg.tasks + live task outputs.
# Usage: bg_collect_outstanding_rich <session_id> [stdin_json] [entry_bg_tasks_json]
bg_collect_outstanding_rich() {
  local session_id="$1" stdin_json="${2:-}" entry_tasks="${3:-[]}"
  local from_side from_live
  command -v jq >/dev/null 2>&1 || { printf '%s' '[]'; return 0; }
  from_side="$(bg_collect_outstanding "$session_id" "$stdin_json")"
  from_live="$(bg_live_task_outputs_json "$session_id")"
  if [[ -z "$entry_tasks" ]] || ! printf '%s' "$entry_tasks" | jq -e . >/dev/null 2>&1; then
    entry_tasks='[]'
  fi
  jq -c -n --argjson side "$from_side" --argjson live "$from_live" \
    --argjson entry "$entry_tasks" '
      ($entry
        | if type == "array" then .
          elif type == "object" and (.tasks | type) == "array" then .tasks
          else [] end
      ) as $ent
      | ($side + $live + $ent)
      | map({id:(.id//""), type:(.type//"shell"), summary:(.summary//"")})
      | map(select(.id != ""))
      | unique_by(.id)
    ' 2>/dev/null || printf '%s' '[]'
}

# Recover outstanding when sidecar was cleared but Claude still in shell /
# task outputs are still open. Used by Stop gate and bump demote guard.
bg_recover_if_shell_alive() {
  local session_id="$1" entry_tasks="${2:-[]}"
  local st live
  st="$(bg_claude_session_status "$session_id")"
  live="$(bg_live_task_outputs_json "$session_id")"
  if [[ "$st" == "shell" ]]; then
    if [[ "$(jq -r 'length // 0' <<<"$live" 2>/dev/null || echo 0)" -eq 0 ]]; then
      # status=shell but no task files yet — keep a placeholder so Stop
      # does not drop to done while harness says shell.
      live="$(jq -cn --arg sid "$session_id" \
        '[{id:("shell-"+($sid|.[0:8])), type:"shell", summary:"claude status=shell"}]')"
    fi
    # Re-seed sidecar from recovered list so later bumps see them.
    if command -v jq >/dev/null 2>&1; then
      while IFS= read -r row; do
        [[ -n "$row" ]] || continue
        local id typ sum
        id="$(jq -r '.id // empty' <<<"$row")"
        typ="$(jq -r '.type // "shell"' <<<"$row")"
        sum="$(jq -r '.summary // empty' <<<"$row")"
        [[ -n "$id" ]] && bg_sidecar_add "$session_id" "$id" "$typ" "$sum"
      done < <(jq -c '.[]' <<<"$live" 2>/dev/null || true)
    fi
    printf '%s' "$live"
    return 0
  fi
  # Not shell: still return live non-exited outputs if any.
  if [[ "$(jq -r 'length // 0' <<<"$live" 2>/dev/null || echo 0)" -gt 0 ]]; then
    printf '%s' "$live"
    return 0
  fi
  printf '%s' '[]'
}

# Bump ts for bg-running entries. Demote to done only when outstanding is
# empty AND Claude is not status=shell AND no live task outputs remain.
bg_bump_alive_entries() {
  local path lock current next now
  command -v jq >/dev/null 2>&1 || return 0
  path="$(attention_state_path)"
  [[ -f "$path" ]] || return 0
  now="$(attention_state_now_ms)"
  lock="$(attention_state_lock_path)"
  (
    flock -x 9
    current="$(attention_state_read)"
    next="$current"
    while IFS= read -r sid; do
      [[ -n "$sid" ]] || continue
      entry_tasks="$(jq -c --arg sid "$sid" '
        (.entries[$sid].bg.tasks // [])
      ' <<<"$current" 2>/dev/null || printf '%s' '[]')"
      outstanding="$(bg_collect_outstanding_rich "$sid" "" "$entry_tasks")"
      n="$(jq -r 'length // 0' <<<"${outstanding:-[]}" 2>/dev/null || echo 0)"
      if [[ "${n:-0}" -eq 0 ]]; then
        recovered="$(bg_recover_if_shell_alive "$sid" "$entry_tasks")"
        n="$(jq -r 'length // 0' <<<"${recovered:-[]}" 2>/dev/null || echo 0)"
        if [[ "${n:-0}" -gt 0 ]]; then
          outstanding="$recovered"
          if declare -F runtime_log_info >/dev/null 2>&1; then
            runtime_log_info attention "bg bump recover shell/live" \
              "session_id=$sid" "bg_count=$n" \
              "claude_status=$(bg_claude_session_status "$sid")" 2>/dev/null || true
          fi
        fi
      fi
      if [[ "${n:-0}" -gt 0 ]]; then
        next="$(jq -c --arg sid "$sid" --argjson ts "$now" --argjson tasks "$outstanding" \
          --arg reason "$(bg_reason_from_outstanding "$outstanding")" '
            if (.entries[$sid] // null) == null then .
            else
              .entries[$sid].ts = $ts
              | .entries[$sid].running_kind = "background"
              | .entries[$sid].status = "running"
              | .entries[$sid].bg = {tasks: $tasks}
              | .entries[$sid].reason = $reason
              | del(.entries[$sid].done_kind)
            end
          ' <<<"$next")" || true
        if declare -F runtime_log_info >/dev/null 2>&1; then
          runtime_log_info attention "bg bump kept" \
            "session_id=$sid" "bg_count=$n" 2>/dev/null || true
        fi
      else
        claude_st="$(bg_claude_session_status "$sid")"
        # Hard hold: never demote while Claude still reports shell.
        if [[ "$claude_st" == "shell" ]]; then
          next="$(jq -c --arg sid "$sid" --argjson ts "$now" '
            if (.entries[$sid] // null) == null then .
            else
              .entries[$sid].ts = $ts
              | .entries[$sid].running_kind = "background"
              | .entries[$sid].status = "running"
              | .entries[$sid].reason = "bg·shell (claude status=shell)"
              | del(.entries[$sid].done_kind)
            end
          ' <<<"$next")" || true
          if declare -F runtime_log_warn >/dev/null 2>&1; then
            runtime_log_warn attention "bg bump demote skipped" \
              "session_id=$sid" "reason=claude_status_shell" \
              "claude_status=$claude_st" 2>/dev/null || true
          fi
          continue
        fi
        next="$(jq -c --arg sid "$sid" --argjson ts "$now" '
            if (.entries[$sid] // null) == null then .
            else
              .entries[$sid].status = "done"
              | .entries[$sid].reason = "bg finished"
              | .entries[$sid].done_kind = "bg_finished"
              | .entries[$sid].ts = $ts
              | del(.entries[$sid].running_kind, .entries[$sid].bg)
            end
          ' <<<"$next")" || true
        bg_sidecar_clear "$sid"
        if declare -F runtime_log_info >/dev/null 2>&1; then
          runtime_log_info attention "bg bump demoted" \
            "session_id=$sid" "claude_status=${claude_st:-}" \
            "done_kind=bg_finished" 2>/dev/null || true
        fi
      fi
    done < <(jq -r '
      (.entries // {}) | to_entries[]
      | select(.value.status == "running" and (.value.running_kind // "") == "background")
      | .key
    ' <<<"$current" 2>/dev/null || true)
    attention_state_write "$next"
  ) 9>"$lock"
}

