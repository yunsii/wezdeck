#!/usr/bin/env bash
# take / watch-loop: focused-pane handoff + cheap status poller (no LLM).
# shellcheck source=lib.sh
set -euo pipefail

_SB_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$_SB_LIB_DIR/lib.sh"
# shellcheck disable=SC1091
source "$_SB_LIB_DIR/host-snapshot.sh"
# shellcheck disable=SC1091
source "$_SB_LIB_DIR/bot-send.sh"
# shellcheck disable=SC1091
source "$_SB_LIB_DIR/host-write.sh"

sb_watch_dir() {
  local d
  d="$(sb_state_dir)/session-bridge-watch"
  mkdir -p "$d"
  printf '%s\n' "$d"
}

sb_watch_lock_path() {
  printf '%s/watch-loop.lock\n' "$(sb_watch_dir)"
}

sb_watch_log_path() {
  printf '%s/session-bridge-watch.log\n' "$(sb_log_dir)"
}

sb_watch_default_ttl() {
  local n
  n="$(sb_cfg_get '.defaults.watch.ttl_sec' 2>/dev/null || true)"
  if [[ -z "$n" || "$n" == "null" ]]; then
    n=5400
  fi
  printf '%s\n' "$n"
}

sb_watch_default_interval() {
  local n
  n="$(sb_cfg_get '.defaults.watch.interval_sec' 2>/dev/null || true)"
  if [[ -z "$n" || "$n" == "null" ]]; then
    n=10
  fi
  printf '%s\n' "$n"
}

sb_watch_default_notify_to() {
  local t
  t="$(sb_cfg_get '.defaults.watch.notify_to' 2>/dev/null || true)"
  if [[ -z "$t" || "$t" == "null" ]]; then
    t="dex"
  fi
  printf '%s\n' "$t"
}

# Agent pane? kind alone is insufficient: Claude often runs as cmd=sh with a
# task title (no "claude" substring) → sb_infer_kind returns shell. Combine
# kind + attention.json + title/cmd heuristics.
sb_watch_is_agent_pane() {
  local kind="${1:-}" cmd="${2:-}" title="${3:-}" pane_id="${4:-}"
  case "$kind" in
    claude-tui|codex-tui|grok-tui|claude|codex|grok) return 0 ;;
  esac
  local s
  s="$(printf '%s %s' "$cmd" "$title" | tr '[:upper:]' '[:lower:]')"
  case "$s" in
    *claude*|*codex*|*grok*|*"claude code"*|*opencode*) return 0 ;;
  esac
  # WezDeck / Claude Code often prefix agent titles with ✳
  if [[ "$title" == *'✳'* ]]; then
    return 0
  fi
  # Live attention entry for this pane ⇒ agent runtime has hooked it
  if [[ -n "$pane_id" ]]; then
    local attn
    attn="$(sb_attention_index_json | jq -r --arg p "$pane_id" '.[$p].status // empty' 2>/dev/null || true)"
    if [[ -n "$attn" ]]; then
      return 0
    fi
  fi
  return 1
}

sb_watch_job_path() {
  printf '%s/%s.json\n' "$(sb_watch_dir)" "$1"
}

sb_watch_now_epoch() {
  date -u +%s
}

sb_watch_new_id() {
  # w-<utc compact>-<4 hex>
  local ts rnd
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  rnd="$(printf '%04x' "$((RANDOM % 65536))")"
  printf 'w-%s-%s\n' "$ts" "$rnd"
}

# Resolve focused tmux pane → prints: target\tpane_id\tcwd\tcmd\ttitle
# target form: sess:win.pane
sb_resolve_focus() {
  if ! sb_host_tmux_ok; then
    sb_die 2 "tmux 不可用，无法 resolve focus"
  fi

  local target pane_id cwd cmd title sess win pane fmt line

  # 1) Inside a tmux client: current pane is the focus.
  if [[ -n "${TMUX:-}" ]]; then
    fmt='#{session_name}|#{window_index}|#{pane_index}|#{pane_id}|#{pane_current_path}|#{pane_current_command}|#{pane_title}'
    line="$(sb_tmux display-message -p "$fmt" 2>/dev/null || true)"
    if [[ -n "$line" ]]; then
      IFS='|' read -r sess win pane pane_id cwd cmd title <<<"$line"
      target="${sess}:${win}.${pane}"
      printf '%s\t%s\t%s\t%s\t%s\n' "$target" "${pane_id:-}" "${cwd:-}" "${cmd:-}" "${title:-}"
      return 0
    fi
  fi

  # 2) Outside: most recently active client → its current pane.
  local clients best_act=-1 best_sess=""
  clients="$(sb_tmux list-clients -F '#{client_activity}|#{client_session}' 2>/dev/null || true)"
  if [[ -n "$clients" ]]; then
    while IFS='|' read -r act sess_name; do
      [[ -z "${sess_name:-}" ]] && continue
      if [[ "${act:-0}" =~ ^[0-9]+$ ]] && (( act > best_act )); then
        best_act=$act
        best_sess=$sess_name
      fi
    done <<<"$clients"
  fi

  if [[ -n "$best_sess" ]]; then
    fmt='#{session_name}|#{window_index}|#{pane_index}|#{pane_id}|#{pane_current_path}|#{pane_current_command}|#{pane_title}|#{pane_active}'
    while IFS='|' read -r sess win pane pane_id cwd cmd title active; do
      [[ "${active:-0}" == "1" ]] || continue
      target="${sess}:${win}.${pane}"
      printf '%s\t%s\t%s\t%s\t%s\n' "$target" "${pane_id:-}" "${cwd:-}" "${cmd:-}" "${title:-}"
      return 0
    done < <(sb_tmux list-panes -t "$best_sess" -F "$fmt" 2>/dev/null || true)
  fi

  # 3) Fallback: any active pane across sessions (prefer non-shell kinds later via caller).
  fmt='#{session_name}|#{window_index}|#{pane_index}|#{pane_id}|#{pane_current_path}|#{pane_current_command}|#{pane_title}|#{pane_active}'
  local count=0 only_target="" only_line=""
  while IFS='|' read -r sess win pane pane_id cwd cmd title active; do
    [[ "${active:-0}" == "1" ]] || continue
    count=$((count + 1))
    only_target="${sess}:${win}.${pane}"
    only_line="$(printf '%s\t%s\t%s\t%s\t%s' "$only_target" "${pane_id:-}" "${cwd:-}" "${cmd:-}" "${title:-}")"
  done < <(sb_tmux list-panes -a -F "$fmt" 2>/dev/null || true)

  if [[ "$count" -eq 1 ]]; then
    printf '%s\n' "$only_line"
    return 0
  fi

  if [[ "$count" -gt 1 ]]; then
    sb_die 2 "多个 active pane 且无前台 client；请用 --target sess:win.pane 指定"
  fi
  sb_die 2 "找不到 focused tmux pane（无 client / 无 active pane）"
}

# Lookup pane metadata for an explicit target. Prints same TSV as resolve_focus.
sb_target_meta() {
  local target="$1"
  local tmux_target sess want_win want_pane
  tmux_target="$(sb_normalize_host_target "$target")"
  sess="${tmux_target%%:*}"
  local rest="${tmux_target#*:}"
  want_win="${rest%%.*}"
  want_pane="${rest#*.}"

  if ! sb_host_tmux_ok; then
    sb_die 2 "tmux 不可用"
  fi

  local fmt line sess_i win pane pane_id cwd cmd title
  fmt='#{session_name}|#{window_index}|#{pane_index}|#{pane_id}|#{pane_current_path}|#{pane_current_command}|#{pane_title}'
  while IFS='|' read -r sess_i win pane pane_id cwd cmd title; do
    if [[ "$sess_i" == "$sess" && "$win" == "$want_win" && "$pane" == "$want_pane" ]]; then
      printf '%s\t%s\t%s\t%s\t%s\n' "${sess_i}:${win}.${pane}" "${pane_id:-}" "${cwd:-}" "${cmd:-}" "${title:-}"
      return 0
    fi
  done < <(sb_tmux list-panes -a -F "$fmt" 2>/dev/null || true)

  # Pane may have died; still allow take with empty meta.
  printf '%s\t\t\t\t\n' "$tmux_target"
}

sb_watch_status_for_job() {
  # stdout: status token — running|waiting|done|idle|unknown
  local target="$1"
  local pane_id="${2:-}"
  local tmux_target
  tmux_target="$(sb_normalize_host_target "$target")"

  if ! sb_host_tmux_ok; then
    printf 'unknown\n'
    return 0
  fi

  # Pane gone?
  local alive=0
  if [[ -n "$pane_id" ]]; then
    if sb_tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -Fxq "$pane_id"; then
      alive=1
    fi
  else
    if sb_tmux list-panes -t "$tmux_target" -F '#{pane_id}' >/dev/null 2>&1; then
      alive=1
    fi
  fi
  if [[ "$alive" != "1" ]]; then
    printf 'done\n'
    return 0
  fi

  # attention.json by pane id (best signal for Claude etc.)
  if [[ -n "$pane_id" ]]; then
    local attn_idx attn
    attn_idx="$(sb_attention_index_json)"
    attn="$(jq -r --arg p "$pane_id" '.[$p].status // empty' <<<"$attn_idx" 2>/dev/null || true)"
    case "$attn" in
      waiting|running|done)
        printf '%s\n' "$attn"
        return 0
        ;;
    esac
  fi

  # Fallback: permission-looking prompt in last lines → waiting
  local tail_text
  tail_text="$(sb_host_capture_text_raw "$tmux_target" 12 2>/dev/null || true)"
  if [[ -n "$tail_text" ]] && sb_prompt_visible "$tail_text"; then
    printf 'waiting\n'
    return 0
  fi

  printf 'running\n'
}

sb_watch_find_by_target() {
  local target="$1"
  local f t
  local norm
  norm="$(sb_normalize_host_target "$target")"
  for f in "$(sb_watch_dir)"/w-*.json; do
    [[ -f "$f" ]] || continue
    t="$(jq -r '.target // empty' "$f" 2>/dev/null || true)"
    t="$(sb_normalize_host_target "${t:-}")"
    if [[ "$t" == "$norm" ]]; then
      jq -r '.id // empty' "$f"
      return 0
    fi
  done
  return 1
}

sb_watch_notify() {
  local to="$1"
  local message="$2"
  local confirm="${3:-1}"
  # Never call LLM. bot-send only.
  if [[ "$confirm" == "1" ]]; then
    sb_bot_send "$to" "$message" 1 "feishu" "" >/dev/null
  else
    sb_bot_send "$to" "$message" 0 "feishu" "" >/dev/null
  fi
}

sb_watch_ensure_loop() {
  local lock pidfile log
  lock="$(sb_watch_lock_path)"
  pidfile="$(sb_watch_dir)/watch-loop.pid"
  log="$(sb_watch_log_path)"

  # Already running?
  if [[ -f "$pidfile" ]]; then
    local old
    old="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
      return 0
    fi
  fi

  # Spawn detached loop via the CLI entry (same env).
  local cli
  cli="$(cd "$_SB_LIB_DIR/.." && pwd)/session-bridge.sh"
  nohup bash "$cli" watch-loop >>"$log" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" >"$pidfile"
  # brief settle
  sleep 0.05
  return 0
}

# take: register watch job for focused/explicit target; start loop; optional ack notify.
# Args via named-style env-like positional set by cmd_take.
sb_watch_take() {
  local target="${1:-}"          # empty → focus
  local pane_id_in="${2:-}"
  local note="${3:-}"
  local ttl="${4:-}"
  local notify_to="${5:-}"
  local confirm_notify="${6:-0}"
  local dry="${7:-0}"
  local no_ack="${8:-0}"

  if [[ -z "$ttl" ]]; then
    ttl="$(sb_watch_default_ttl)"
  fi
  if [[ -z "$notify_to" ]]; then
    notify_to="$(sb_watch_default_notify_to)"
  fi

  local meta target_r pane_id cwd cmd title kind
  if [[ -n "$target" ]]; then
    meta="$(sb_target_meta "$target")"
  else
    meta="$(sb_resolve_focus)"
  fi
  IFS=$'\t' read -r target_r pane_id cwd cmd title <<<"$meta"
  if [[ -n "$pane_id_in" ]]; then
    pane_id="$pane_id_in"
  fi
  kind="$(sb_infer_kind "${cmd:-}" "${title:-}")"

  # Agent only — plain shell has no attention signal and would idle-poll until TTL.
  if ! sb_watch_is_agent_pane "$kind" "${cmd:-}" "${title:-}" "${pane_id:-}"; then
    sb_die 2 "当前 pane 不是 agent（kind=${kind} cmd=${cmd:-?} title=${title:-?}）。take 只支持 Claude/Codex/Grok 等 agent 会话"
  fi

  local now exp id path existing
  now="$(sb_watch_now_epoch)"
  exp=$((now + ttl))
  existing="$(sb_watch_find_by_target "$target_r" || true)"
  if [[ -n "$existing" ]]; then
    id="$existing"
  else
    id="$(sb_watch_new_id)"
  fi
  path="$(sb_watch_job_path "$id")"

  local status0
  status0="$(sb_watch_status_for_job "$target_r" "$pane_id")"

  local job
  job="$(jq -nc \
    --arg id "$id" \
    --arg target "$target_r" \
    --arg pane_id "${pane_id:-}" \
    --arg cwd "${cwd:-}" \
    --arg kind "$kind" \
    --arg cmd "${cmd:-}" \
    --arg title "${title:-}" \
    --arg note "${note:-}" \
    --arg notify_to "$notify_to" \
    --arg status "$status0" \
    --arg started "$(sb_now_iso)" \
    --argjson ttl "$ttl" \
    --argjson now "$now" \
    --argjson exp "$exp" \
    '{
      id: $id,
      target: $target,
      tmux_pane: (if $pane_id == "" then null else $pane_id end),
      cwd: (if $cwd == "" then null else $cwd end),
      kind: $kind,
      current_command: (if $cmd == "" then null else $cmd end),
      title: (if $title == "" then null else $title end),
      note: $note,
      notify_to: $notify_to,
      started_at: $started,
      started_epoch: $now,
      expires_at_epoch: $exp,
      ttl_sec: $ttl,
      last_status: $status,
      last_event: null,
      last_notified_event: null,
      last_notified_at: null,
      active: true
    }')"

  if [[ "$dry" == "1" ]]; then
    jq -nc --argjson job "$job" \
      '{ok:true, dry_run:true, action:"take", job:$job, note:"未写 job、未启 poller、未通知"}'
    return 0
  fi

  printf '%s\n' "$job" >"$path"
  sb_audit "take" "local" "$target_r" "ok" "watch-registered" "$note"

  sb_watch_ensure_loop

  local ack_msg
  ack_msg="$(printf '已接管 %s（%s）· status=%s · %sm 内仅在「需确认/结束」时通知%s' \
    "$target_r" "$kind" "$status0" "$((ttl / 60))" \
    "$( [[ -n "$note" ]] && printf ' · note: %s' "$note" || true )")"

  local notified=false
  if [[ "$no_ack" != "1" ]]; then
    if sb_watch_notify "$notify_to" "$ack_msg" "$confirm_notify" 2>/dev/null; then
      notified=true
      # record ack as notified (not an event type for poller)
      jq --arg ts "$(sb_now_iso)" '.last_notified_at=$ts | .last_notified_event="take_ack"' \
        "$path" >"${path}.tmp" && mv "${path}.tmp" "$path"
    fi
  fi

  jq -nc \
    --argjson job "$(cat "$path")" \
    --argjson notified "$notified" \
    --arg ack "$ack_msg" \
    '{ok:true, action:"take", job:$job, ack_notified:$notified, ack_message:$ack, poller:"watch-loop"}'
}

sb_watch_list_jobs() {
  local arr='[]' f
  for f in "$(sb_watch_dir)"/w-*.json; do
    [[ -f "$f" ]] || continue
    arr="$(jq -c --slurpfile j "$f" '. + $j' <<<"$arr")"
  done
  printf '%s\n' "$arr"
}

sb_watch_status_cmd() {
  local jobs
  jobs="$(sb_watch_list_jobs)"
  local pidfile pid running=false
  pidfile="$(sb_watch_dir)/watch-loop.pid"
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    running=true
  fi
  jq -nc \
    --argjson jobs "$jobs" \
    --argjson running "$running" \
    --arg pid "${pid:-}" \
    --arg dir "$(sb_watch_dir)" \
    '{ok:true, poller_running:$running, poller_pid:(if $pid=="" then null else ($pid|tonumber) end),
      job_dir:$dir, jobs:$jobs}'
}

sb_watch_stop() {
  local id="${1:-}"
  local all="${2:-0}"
  local stopped='[]'

  if [[ "$all" == "1" ]]; then
    local f
    for f in "$(sb_watch_dir)"/w-*.json; do
      [[ -f "$f" ]] || continue
      local jid
      jid="$(jq -r '.id' "$f")"
      rm -f "$f"
      stopped="$(jq -c --arg id "$jid" '. + [$id]' <<<"$stopped")"
      sb_audit "watch-stop" "local" "$jid" "ok" "all"
    done
  else
    [[ -n "$id" ]] || sb_die 3 "watch-stop 需要 --id 或 --all"
    local p
    p="$(sb_watch_job_path "$id")"
    if [[ ! -f "$p" ]]; then
      sb_die 2 "job 不存在: $id"
    fi
    rm -f "$p"
    stopped="$(jq -nc --arg id "$id" '[$id]')"
    sb_audit "watch-stop" "local" "$id" "ok" "one"
  fi

  # If no jobs left, try stop loop (best-effort)
  local left
  left="$(find "$(sb_watch_dir)" -maxdepth 1 -name 'w-*.json' 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$left" == "0" ]]; then
    local pidfile pid
    pidfile="$(sb_watch_dir)/watch-loop.pid"
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi

  jq -nc --argjson stopped "$stopped" '{ok:true, stopped:$stopped}'
}

sb_watch_tick_job() {
  local path="$1"
  [[ -f "$path" ]] || return 0

  local job id target pane_id last_status notify_to exp note kind
  job="$(cat "$path")"
  id="$(jq -r '.id' <<<"$job")"
  target="$(jq -r '.target' <<<"$job")"
  pane_id="$(jq -r '.tmux_pane // empty' <<<"$job")"
  last_status="$(jq -r '.last_status // "unknown"' <<<"$job")"
  notify_to="$(jq -r '.notify_to // "dex"' <<<"$job")"
  exp="$(jq -r '.expires_at_epoch // 0' <<<"$job")"
  note="$(jq -r '.note // empty' <<<"$job")"
  kind="$(jq -r '.kind // "unknown"' <<<"$job")"
  local last_notified_event
  last_notified_event="$(jq -r '.last_notified_event // empty' <<<"$job")"

  local now cur event="" msg=""
  now="$(sb_watch_now_epoch)"

  if [[ "$exp" =~ ^[0-9]+$ ]] && (( now > exp )); then
    event="ended"
    msg="$(printf '盯梢到期 · %s（%s）· 已停止' "$target" "$kind")"
    cur="done"
  else
    cur="$(sb_watch_status_for_job "$target" "$pane_id")"
    if [[ "$cur" == "waiting" && "$last_status" != "waiting" ]]; then
      event="need_human"
      local tail
      tail="$(sb_host_capture_text_raw "$(sb_normalize_host_target "$target")" 6 2>/dev/null \
        | tr -d '\r' | tail -n 3 | sed 's/^/  /' || true)"
      msg="$(printf '需要确认 · %s（%s）\n%s%s' \
        "$target" "$kind" \
        "$( [[ -n "$note" ]] && printf 'note: %s\n' "$note" || true )" \
        "${tail:-}")"
    elif [[ "$cur" == "done" && "$last_status" != "done" ]]; then
      event="ended"
      msg="$(printf '会话结束 · %s（%s）· status=done' "$target" "$kind")"
    fi
  fi

  # update last_status always
  local updated
  updated="$(jq -c --arg st "$cur" --arg ev "${event:-}" \
    '.last_status=$st | if $ev != "" then .last_event=$ev else . end' <<<"$job")"

  if [[ -n "$event" && "$event" != "$last_notified_event" ]]; then
    # confirm notify for real (poller always real send; panic blocks)
    if sb_watch_notify "$notify_to" "$msg" 1 2>/dev/null; then
      updated="$(jq -c --arg ev "$event" --arg ts "$(sb_now_iso)" \
        '.last_notified_event=$ev | .last_notified_at=$ts' <<<"$updated")"
      sb_audit "watch-notify" "bot" "$target" "ok" "$event" "${msg:0:80}"
    else
      sb_audit "watch-notify" "bot" "$target" "deny" "$event-failed" "${msg:0:80}"
    fi
  fi

  if [[ "$event" == "ended" ]] || [[ "$cur" == "done" && "$event" == "ended" ]]; then
    rm -f "$path"
    sb_audit "watch-end" "local" "$target" "ok" "${event:-done}"
    return 0
  fi

  # TTL ended path already set event=ended and removed above — if only status done without event re-fire:
  if [[ "$cur" == "done" ]]; then
    # already notified or first time done without transition? still close job
    if [[ "$last_status" == "done" ]]; then
      rm -f "$path"
      return 0
    fi
  fi

  printf '%s\n' "$updated" >"$path"
}

sb_watch_loop() {
  local lock
  lock="$(sb_watch_lock_path)"
  mkdir -p "$(sb_watch_dir)"

  # Single instance
  exec 9>"$lock"
  if ! flock -n 9; then
    # another loop holds the lock
    return 0
  fi

  printf '%s\n' "$$" >"$(sb_watch_dir)/watch-loop.pid"

  local interval empty_ticks=0
  interval="$(sb_watch_default_interval)"
  if ! [[ "$interval" =~ ^[0-9]+$ ]] || (( interval < 2 )); then
    interval=10
  fi

  while true; do
    local any=0 f
    for f in "$(sb_watch_dir)"/w-*.json; do
      [[ -f "$f" ]] || continue
      any=1
      sb_watch_tick_job "$f" || true
    done

    if [[ "$any" -eq 0 ]]; then
      empty_ticks=$((empty_ticks + 1))
      # exit after ~30s idle with no jobs
      if (( empty_ticks >= 3 )); then
        rm -f "$(sb_watch_dir)/watch-loop.pid"
        return 0
      fi
    else
      empty_ticks=0
    fi

    sleep "$interval"
  done
}
