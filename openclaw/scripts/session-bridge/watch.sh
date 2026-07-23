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
source "$_SB_LIB_DIR/say-as-me.sh"
# shellcheck disable=SC1091
source "$_SB_LIB_DIR/host-write.sh"
# poke lives in claw-project.sh (sourced by session-bridge.sh before watch).

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

# WezTerm right-status badge path (Windows-readable, same FS as attention.json).
# Prefer WINDOWS_RUNTIME_STATE_WSL; fall back to XDG wezterm-runtime under home.
sb_watch_ui_status_path() {
  if [[ -n "${SB_WATCH_UI_STATUS_PATH:-}" ]]; then
    printf '%s\n' "$SB_WATCH_UI_STATUS_PATH"
    return 0
  fi
  if [[ -z "${WINDOWS_RUNTIME_STATE_WSL:-}" ]]; then
    local paths_lib
    paths_lib="$(cd "$_SB_LIB_DIR/../../.." && pwd)/scripts/runtime/windows-runtime-paths-lib.sh"
    # shellcheck disable=SC1091
    if [[ -f "$paths_lib" ]]; then
      # shellcheck disable=SC1091
      source "$paths_lib" 2>/dev/null || true
      windows_runtime_detect_paths 2>/dev/null || true
    fi
  fi
  if [[ -n "${WINDOWS_RUNTIME_STATE_WSL:-}" ]]; then
    printf '%s\n' "${WINDOWS_RUNTIME_STATE_WSL}/state/session-bridge-watch/status.json"
    return 0
  fi
  printf '%s\n' "${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime/state/session-bridge-watch/status.json"
}

# Publish poller heartbeat for WezTerm SB·N badge. running=0|1
sb_watch_publish_ui_status() {
  local running="${1:-1}"
  local path dir tmp jobs waiting pid hb
  path="$(sb_watch_ui_status_path)"
  dir="$(dirname "$path")"
  mkdir -p "$dir" 2>/dev/null || true

  jobs=0
  waiting=0
  local f st act
  for f in "$(sb_watch_dir)"/w-*.json; do
    [[ -f "$f" ]] || continue
    # Soft-stopped jobs stay on disk for audit but do not count as watching.
    act="$(jq -r 'if .active == false then "0" else "1" end' "$f" 2>/dev/null || echo 1)"
    [[ "$act" == "1" ]] || continue
    jobs=$((jobs + 1))
    st="$(jq -r '.last_status // empty' "$f" 2>/dev/null || true)"
    if [[ "$st" == "waiting" ]]; then
      waiting=$((waiting + 1))
    fi
  done

  pid=""
  if [[ -f "$(sb_watch_dir)/watch-loop.pid" ]]; then
    pid="$(cat "$(sb_watch_dir)/watch-loop.pid" 2>/dev/null || true)"
  fi
  if [[ "$running" == "1" && -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
    running=0
  fi

  hb="$(date +%s%3N 2>/dev/null || echo $(($(date +%s) * 1000)))"
  # bash date +%s%3N may literally print %3N on some systems
  if [[ ! "$hb" =~ ^[0-9]+$ ]]; then
    hb="$(($(date +%s) * 1000))"
  fi

  tmp="${path}.tmp.$$"
  local pid_json="null"
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    pid_json="$pid"
  fi
  jq -nc \
    --argjson running "$([[ "$running" == "1" ]] && echo true || echo false)" \
    --argjson jobs "$jobs" \
    --argjson waiting "$waiting" \
    --argjson pid "$pid_json" \
    --argjson hb "$hb" \
    --arg ts "$(sb_now_iso)" \
    '{
      version: 1,
      poller_running: $running,
      poller_pid: $pid,
      job_count: $jobs,
      waiting_count: $waiting,
      heartbeat_at_ms: $hb,
      updated_at: $ts
    }' >"$tmp" 2>/dev/null && mv -f "$tmp" "$path" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
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

# Who delivers watch events?
#   user      — say-as-me（本人飞书 → Dex 会话；Dex 当作用户消息处理）
#   poke      — agent-poke 注入 Dex session（Dex 必跑一轮；非飞书身份）
#   user+poke — 默认：本人发飞书 + poke，确保 Dex「注意到」
#   bot       — 旧路径：bot → 主人（看起来像 Dex 主动找你，易误导；不推荐）
sb_watch_default_notify_identity() {
  local t
  t="$(sb_cfg_get '.defaults.watch.notify_identity' 2>/dev/null || true)"
  if [[ -z "$t" || "$t" == "null" ]]; then
    t="user+poke"
  fi
  printf '%s\n' "$t"
}

# Agent pane? Process (FG → tree) → kind/cmd name → live attention.
# Title is never consulted (kept as unused 3rd arg for call-site compat).
sb_watch_is_agent_pane() {
  local kind="${1:-}" cmd="${2:-}" _title="${3:-}" pane_id="${4:-}"

  # 1) Foreground / tree process (authoritative when pane_id known)
  if [[ -n "$pane_id" ]] && sb_pane_has_agent_process "$pane_id"; then
    return 0
  fi

  # 2) Already-resolved kind or pane_current_command name
  case "$kind" in
    claude-tui|codex-tui|grok-tui|claude|codex|grok) return 0 ;;
  esac
  if sb_name_to_agent_kind "$cmd" >/dev/null 2>&1; then
    return 0
  fi

  # 3) Live attention entry ⇒ agent runtime has hooked this pane
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

  # Fallback: pane bottom looks like permission OR choice UI → waiting.
  # Broader than sb_prompt_visible (approve-key gate): Claude AskUserQuestion
  # shows "Enter to select · Esc to cancel" with no y/N anchors.
  local tail_text
  tail_text="$(sb_host_capture_text_raw "$tmux_target" 20 2>/dev/null || true)"
  if [[ -n "$tail_text" ]] && sb_watch_human_prompt_visible "$tail_text"; then
    printf 'waiting\n'
    return 0
  fi

  printf 'running\n'
}

sb_watch_find_by_target() {
  local target="$1"
  local f t act
  local norm
  norm="$(sb_normalize_host_target "$target")"
  local hit_active="" hit_any=""
  for f in "$(sb_watch_dir)"/w-*.json; do
    [[ -f "$f" ]] || continue
    t="$(jq -r '.target // empty' "$f" 2>/dev/null || true)"
    t="$(sb_normalize_host_target "${t:-}")"
    [[ "$t" == "$norm" ]] || continue
    hit_any="$(jq -r '.id // empty' "$f")"
    act="$(jq -r 'if .active == false then "0" else "1" end' "$f" 2>/dev/null || echo 1)"
    if [[ "$act" == "1" ]]; then
      hit_active="$hit_any"
      break
    fi
  done
  # Prefer an active job; else reuse soft-stopped record for the same pane.
  if [[ -n "$hit_active" ]]; then
    printf '%s\n' "$hit_active"
    return 0
  fi
  if [[ -n "$hit_any" ]]; then
    printf '%s\n' "$hit_any"
    return 0
  fi
  return 1
}

# True when job JSON is still an active watch (default true if field missing).
sb_watch_job_is_active() {
  local path="$1"
  local act
  act="$(jq -r 'if .active == false then "0" else "1" end' "$path" 2>/dev/null || echo 1)"
  [[ "$act" == "1" ]]
}

# Deliver a watch event. Returns 0 if at least one channel succeeded.
# confirm=1 → real send; 0 → dry-run only.
sb_watch_notify() {
  local to="$1"
  local message="$2"
  local confirm="${3:-1}"
  local identity="${4:-}"
  if [[ -z "$identity" ]]; then
    identity="$(sb_watch_default_notify_identity)"
  fi

  local dry=1
  [[ "$confirm" == "1" ]] && dry=0

  local ok=0
  local want_user=0 want_poke=0 want_bot=0
  case "$identity" in
    user) want_user=1 ;;
    poke) want_poke=1 ;;
    bot) want_bot=1 ;;
    user+poke|poke+user) want_user=1; want_poke=1 ;;
    *)
      # unknown → safe default
      want_user=1
      want_poke=1
      ;;
  esac

  # 1) user → Dex Feishu p2p (say-as-me). Prefer dex_chat_id; else dex_bot_open_id
  #    as --user-id (lark resolves p2p). Never use owner dex_user_id (that is you).
  if [[ "$want_user" == "1" ]]; then
    if declare -F sb_say_as_me >/dev/null 2>&1; then
      if sb_say_as_me "$to" "$message" "$([[ "$dry" == "0" ]] && echo 1 || echo 0)" 0 >/dev/null 2>&1; then
        ok=1
      else
        sb_audit "watch-notify" "user" "$to" "deny" "say-as-me-failed" "${message:0:80}"
      fi
    else
      sb_audit "watch-notify" "user" "$to" "deny" "say-as-me-unavailable" "${message:0:80}"
    fi
  fi

  # 2) poke Dex session so Main actually runs a turn (not just a Feishu toast).
  if [[ "$want_poke" == "1" ]]; then
    if declare -F sb_claw_poke_cmd >/dev/null 2>&1; then
      if sb_claw_poke_cmd "$to" "$message" "$dry" "" >/dev/null 2>&1; then
        ok=1
      else
        sb_audit "watch-notify" "agent-poke" "$to" "deny" "poke-failed" "${message:0:80}"
      fi
    else
      sb_audit "watch-notify" "agent-poke" "$to" "deny" "poke-unavailable" "${message:0:80}"
    fi
  fi

  # 3) legacy bot → owner (opt-in only)
  if [[ "$want_bot" == "1" ]]; then
    if sb_bot_send "$to" "$message" "$([[ "$dry" == "0" ]] && echo 1 || echo 0)" "feishu" "" >/dev/null 2>&1; then
      ok=1
    else
      sb_audit "watch-notify" "bot" "$to" "deny" "bot-send-failed" "${message:0:80}"
    fi
  fi

  [[ "$ok" == "1" ]]
}

# Wrap body so Dex never mistakes host choice UI for its own Feishu 1/2/3 menu.
sb_watch_frame_for_dex() {
  local event="$1"   # take | need_human | ended
  local body="$2"
  case "$event" in
    take)
      printf '%s\n' \
        "【host-watch · take】" \
        "我（主人）用 Ctrl+K w 把本机 tmux agent pane 交给你盯梢。" \
        "这是 host→你 的交接，不是 bot 广播，也不是让你代按 TUI。" \
        "" \
        "$body" \
        "" \
        "规则：只在「需我确认 / 会话结束」时再找我；不要把后文选项当成你的飞书菜单。"
      ;;
    need_human)
      printf '%s\n' \
        "【host-watch · need_human】" \
        "本机 host 会话卡住、需要我本人回 tmux 处理。" \
        "下面摘要来自 host pane 截取——不是你的飞书 1/2/3 菜单，请勿代选。" \
        "" \
        "$body" \
        "" \
        "请提醒我回主机处理。除非我明确授权 lease/host-send-keys，不要代按键。"
      ;;
    ended)
      printf '%s\n' \
        "【host-watch · ended】" \
        "本机盯梢结束（done / pane 消失 / TTL）。" \
        "" \
        "$body"
      ;;
    *)
      printf '%s\n' "【host-watch · ${event}】" "$body"
      ;;
  esac
}

# Structured Feishu body for need_human (choice UI / permission), not raw pane dump.
sb_watch_format_need_human_msg() {
  local target="$1"
  local kind="$2"
  local note="${3:-}"
  local tmux_target raw fmt
  tmux_target="$(sb_normalize_host_target "$target")"
  # Capture enough history to include full AskUserQuestion box (not just footer).
  raw="$(sb_host_capture_text_raw "$tmux_target" 80 2>/dev/null || true)"
  fmt="$_SB_LIB_DIR/format-need-human.py"
  if [[ -f "$fmt" && -n "$raw" ]]; then
    if printf '%s\n' "$raw" | python3 "$fmt" "$target" "$kind" "$note" 2>/dev/null; then
      return 0
    fi
  fi
  # Fallback: short plain line
  printf '🔔 需要确认\n\n会话: %s\n类型: %s\n%s\n→ 回对应 tmux pane 处理\n' \
    "$target" "$kind" \
    "$( [[ -n "$note" ]] && printf '备注: %s\n' "$note" || true )"
}

sb_watch_ensure_loop() {
  local lock pidfile log
  lock="$(sb_watch_lock_path)"
  pidfile="$(sb_watch_dir)/watch-loop.pid"
  log="$(sb_watch_log_path)"
  # force=1 → kill existing loop so take always loads latest script code
  # (bash sources once at process start; stale pollers kept bot-send forever).
  local force="${1:-0}"

  if [[ -f "$pidfile" ]]; then
    local old
    old="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
      if [[ "$force" != "1" ]]; then
        return 0
      fi
      kill "$old" 2>/dev/null || true
      # release flock holder
      sleep 0.15
      kill -9 "$old" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
  rm -f "$lock"

  # Spawn detached loop via the CLI entry (same env).
  local cli
  cli="$(cd "$_SB_LIB_DIR/.." && pwd)/session-bridge.sh"
  nohup bash "$cli" watch-loop >>"$log" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" >"$pidfile"
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
  # Process-first kind (FG on tty → tree → cmd name).
  kind="$(sb_resolve_pane_kind "${pane_id:-}" "${cmd:-}")"

  # Agent only — plain shell has no attention signal and would idle-poll until TTL.
  if ! sb_watch_is_agent_pane "$kind" "${cmd:-}" "${title:-}" "${pane_id:-}"; then
    sb_die 2 "当前 pane 不是 agent（kind=${kind} cmd=${cmd:-?} title=${title:-?}）。take 只支持 Claude/Codex/Grok 等 agent 会话（以 pane 前台进程为准）"
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
  # Seed last_status as "init" so the first poller tick can emit need_human
  # when the pane is *already* waiting at take time (status0==waiting would
  # otherwise never transition waiting→waiting).
  local seed_status="init"

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
    --arg status0 "$status0" \
    --arg seed "$seed_status" \
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
      status_at_take: $status0,
      last_status: $seed,
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

  # Always restart poller on take so notify_identity / formatter code is fresh.
  sb_watch_ensure_loop 1
  sb_watch_publish_ui_status 1

  local ack_body ack_msg
  ack_body="$(printf 'target: %s\nkind: %s\nstatus_at_take: %s\nttl: %sm%s' \
    "$target_r" "$kind" "$status0" "$((ttl / 60))" \
    "$( [[ -n "$note" ]] && printf '\nnote: %s' "$note" || true )")"
  ack_msg="$(sb_watch_frame_for_dex take "$ack_body")"

  local notified=false
  local notify_identity
  notify_identity="$(sb_watch_default_notify_identity)"
  # persist identity on job so poller uses the same channel
  jq --arg idn "$notify_identity" '.notify_identity=$idn' \
    "$path" >"${path}.tmp" && mv "${path}.tmp" "$path"

  if [[ "$no_ack" != "1" ]]; then
    if sb_watch_notify "$notify_to" "$ack_msg" "$confirm_notify" "$notify_identity" 2>/dev/null; then
      notified=true
      jq --arg ts "$(sb_now_iso)" '.last_notified_at=$ts | .last_notified_event="take_ack"' \
        "$path" >"${path}.tmp" && mv "${path}.tmp" "$path"
    fi
  fi

  jq -nc \
    --argjson job "$(cat "$path")" \
    --argjson notified "$notified" \
    --arg ack "$ack_msg" \
    --arg identity "$notify_identity" \
    '{ok:true, action:"take", job:$job, ack_notified:$notified, ack_message:$ack, notify_identity:$identity, poller:"watch-loop"}'
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

# Soft-stop a watch: clear active flag, keep JSON for audit / re-take.
# Does NOT delete agent-attention records. Does NOT rm the job file.
# Use SB_WATCH_PURGE=1 for hard delete (tests / manual cleanup).
sb_watch_stop() {
  local id="${1:-}"
  local all="${2:-0}"
  local stopped='[]'
  local purge="${SB_WATCH_PURGE:-0}"

  sb_watch_soft_stop_one() {
    local p="$1"
    local jid
    jid="$(jq -r '.id // empty' "$p" 2>/dev/null || true)"
    [[ -n "$jid" ]] || return 1
    if [[ "$purge" == "1" ]]; then
      rm -f "$p"
    else
      jq --arg ts "$(sb_now_iso)" --argjson now "$(sb_watch_now_epoch)" \
        '.active = false
         | .stopped_at = $ts
         | .stopped_epoch = $now
         | .last_event = "stopped"' \
        "$p" >"${p}.tmp" && mv "${p}.tmp" "$p"
    fi
    stopped="$(jq -c --arg id "$jid" '. + [$id]' <<<"$stopped")"
    sb_audit "watch-stop" "local" "$jid" "ok" "$([[ "$purge" == "1" ]] && echo purge || echo soft)"
  }

  if [[ "$all" == "1" ]]; then
    local f
    for f in "$(sb_watch_dir)"/w-*.json; do
      [[ -f "$f" ]] || continue
      sb_watch_job_is_active "$f" || continue
      sb_watch_soft_stop_one "$f" || true
    done
  else
    [[ -n "$id" ]] || sb_die 3 "watch-stop 需要 --id 或 --all"
    local p
    p="$(sb_watch_job_path "$id")"
    if [[ ! -f "$p" ]]; then
      sb_die 2 "job 不存在: $id"
    fi
    if ! sb_watch_job_is_active "$p"; then
      # Already soft-stopped — idempotent ok
      jq -nc --arg id "$id" '{ok:true, stopped:[$id], note:"already_inactive"}'
      return 0
    fi
    sb_watch_soft_stop_one "$p" || sb_die 2 "watch-stop 失败: $id"
  fi

  # If no *active* jobs left, stop poller (best-effort)
  local left=0 f
  for f in "$(sb_watch_dir)"/w-*.json; do
    [[ -f "$f" ]] || continue
    sb_watch_job_is_active "$f" || continue
    left=$((left + 1))
  done
  if [[ "$left" -eq 0 ]]; then
    local pidfile pid
    pidfile="$(sb_watch_dir)/watch-loop.pid"
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
    sb_watch_publish_ui_status 0
  else
    sb_watch_publish_ui_status 1
  fi

  jq -nc --argjson stopped "$stopped" \
    --arg mode "$([[ "$purge" == "1" ]] && echo purge || echo soft)" \
    '{ok:true, stopped:$stopped, mode:$mode}'
}

sb_watch_tick_job() {
  local path="$1"
  [[ -f "$path" ]] || return 0
  # Soft-stopped: keep file, do not poll / notify.
  sb_watch_job_is_active "$path" || return 0

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
  local notify_identity last_notified_event
  notify_identity="$(jq -r '.notify_identity // empty' <<<"$job")"
  if [[ -z "$notify_identity" ]]; then
    notify_identity="$(sb_watch_default_notify_identity)"
  fi
  last_notified_event="$(jq -r '.last_notified_event // empty' <<<"$job")"

  local now cur event="" msg="" body=""
  now="$(sb_watch_now_epoch)"

  if [[ "$exp" =~ ^[0-9]+$ ]] && (( now > exp )); then
    event="ended"
    body="$(printf 'target: %s\nkind: %s\nreason: ttl_expired' "$target" "$kind")"
    msg="$(sb_watch_frame_for_dex ended "$body")"
    cur="done"
  else
    cur="$(sb_watch_status_for_job "$target" "$pane_id")"
    if [[ "$cur" == "waiting" && "$last_status" != "waiting" ]]; then
      event="need_human"
      body="$(sb_watch_format_need_human_msg "$target" "$kind" "$note")"
      msg="$(sb_watch_frame_for_dex need_human "$body")"
    elif [[ "$cur" == "done" && "$last_status" != "done" && "$last_status" != "init" ]]; then
      event="ended"
      body="$(printf 'target: %s\nkind: %s\nreason: status=done' "$target" "$kind")"
      msg="$(sb_watch_frame_for_dex ended "$body")"
    elif [[ "$cur" == "done" && "$last_status" == "init" ]]; then
      event="ended"
      body="$(printf 'target: %s\nkind: %s\nreason: already_gone_at_take' "$target" "$kind")"
      msg="$(sb_watch_frame_for_dex ended "$body")"
    fi
  fi

  # update last_status always
  local updated
  updated="$(jq -c --arg st "$cur" --arg ev "${event:-}" \
    '.last_status=$st | if $ev != "" then .last_event=$ev else . end' <<<"$job")"

  if [[ -n "$event" && "$event" != "$last_notified_event" ]]; then
    # poller always real-notify (confirm=1); panic still freezes writes
    if sb_watch_notify "$notify_to" "$msg" 1 "$notify_identity" 2>/dev/null; then
      updated="$(jq -c --arg ev "$event" --arg ts "$(sb_now_iso)" \
        '.last_notified_event=$ev | .last_notified_at=$ts' <<<"$updated")"
      sb_audit "watch-notify" "$notify_identity" "$target" "ok" "$event" "${msg:0:80}"
    else
      sb_audit "watch-notify" "$notify_identity" "$target" "deny" "$event-failed" "${msg:0:80}"
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

  sb_watch_publish_ui_status 1

  while true; do
    local any=0 f
    for f in "$(sb_watch_dir)"/w-*.json; do
      [[ -f "$f" ]] || continue
      sb_watch_job_is_active "$f" || continue
      any=1
      sb_watch_tick_job "$f" || true
    done

    if [[ "$any" -eq 0 ]]; then
      empty_ticks=$((empty_ticks + 1))
      # exit after ~30s idle with no *active* jobs
      if (( empty_ticks >= 3 )); then
        rm -f "$(sb_watch_dir)/watch-loop.pid"
        sb_watch_publish_ui_status 0
        return 0
      fi
      sb_watch_publish_ui_status 1
    else
      empty_ticks=0
      sb_watch_publish_ui_status 1
    fi

    sleep "$interval"
  done
}
