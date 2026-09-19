#!/usr/bin/env bash
# watch notify policy + delivery + NotifyCard payload builders (no LLM).
# Sourced by watch.sh. Split out to keep watch.sh under repo-hygiene hard budget.
# shellcheck source=lib.sh
set -euo pipefail

_SB_NOTIFY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Prefer parent _SB_LIB_DIR when already sourced from watch.sh.
if [[ -z "${_SB_LIB_DIR:-}" ]]; then
  _SB_LIB_DIR="$_SB_NOTIFY_DIR"
fi
# shellcheck disable=SC1091
source "$_SB_LIB_DIR/lib.sh"
# shellcheck disable=SC1091
source "$_SB_LIB_DIR/host-snapshot.sh"
# shellcheck disable=SC1091
source "$_SB_LIB_DIR/bot-send.sh"
# shellcheck disable=SC1091
source "$_SB_LIB_DIR/say-as-me.sh"
# poke: sb_claw_poke_cmd from claw-project.sh (session-bridge.sh sources it before watch).

# Who delivers watch events?
#   none|off|silent — 不发（只 audit / 状态机）
#   owner     — bot → 主人 open_id（决策通知：找人，不冒充本人进 Dex）
#   user      — say-as-me（本人飞书 → Dex 会话；易刷屏，仅显式配置时用）
#   poke      — agent-poke 注入 Dex session
#   user+poke — 本人飞书 + poke（旧默认；已弃用）
#   bot       — bot → feishu_targets 解析（可能落到 chat_id；决策请用 owner）
#
# 默认按事件分流（可用 defaults.watch.notify_by_event 覆盖）：
#   need_human → owner（真要人决策才推飞书）
#   turn_idle / take / ended → none
# 若配置了非空 defaults.watch.notify_identity，则作为全事件毯子覆盖（兼容旧配置）。
sb_watch_default_notify_identity() {
  local t
  t="$(sb_cfg_get '.defaults.watch.notify_identity' 2>/dev/null || true)"
  if [[ -z "$t" || "$t" == "null" ]]; then
    t=""
  fi
  printf '%s\n' "$t"
}

# Per-event identity. Empty / none → no outbound notify.
sb_watch_notify_identity_for_event() {
  local event="${1:-}"
  local blanket per
  blanket="$(sb_watch_default_notify_identity)"
  if [[ -n "$blanket" ]]; then
    printf '%s\n' "$blanket"
    return 0
  fi
  per="$(sb_cfg_get ".defaults.watch.notify_by_event.${event}" 2>/dev/null || true)"
  if [[ -n "$per" && "$per" != "null" ]]; then
    printf '%s\n' "$per"
    return 0
  fi
  case "$event" in
    need_human) printf 'owner\n' ;;
    turn_idle|take|ended) printf 'none\n' ;;
    *) printf 'none\n' ;;
  esac
}

# Sliding TTL renew on status transitions (not every tick). Default on.
# Note: sb_cfg_get uses `expr // empty`, which collapses JSON false → empty;
# read the raw token here so false/0/off actually disable renew.
sb_watch_ttl_renew_on_activity() {
  local cfg raw
  cfg="$(sb_config_path)"
  raw=""
  if [[ -f "$cfg" ]]; then
    raw="$(jq -r '.defaults.watch.ttl_renew_on_activity | if . == null then "" else tostring end' "$cfg" 2>/dev/null || true)"
  fi
  case "$raw" in
    0|false|False|no|off) printf '0\n' ;;
    *) printf '1\n' ;; # empty / null / true → on
  esac
}

sb_watch_owner_feishu_target() {
  local dest
  dest="$(sb_cfg_get '.feishu_targets.dex_user_id' 2>/dev/null || true)"
  if [[ -z "$dest" || "$dest" == "null" ]]; then
    dest=""
  fi
  printf '%s\n' "$dest"
}

# Feishu user-channel format: markdown (lark post) | text (plain).
sb_watch_default_notify_format() {
  local t
  t="$(sb_cfg_get '.defaults.watch.notify_format' 2>/dev/null || true)"
  if [[ -z "$t" || "$t" == "null" ]]; then
    t="markdown"
  fi
  case "$t" in
    markdown|md|post) printf 'markdown\n' ;;
    *) printf 'text\n' ;;
  esac
}

sb_watch_notify_card_py() {
  printf '%s\n' "$_SB_LIB_DIR/notify_card.py"
}

# Build dual payloads from NotifyCard: feishu (md|plain) + poke_text (framed).
# Prints: JSON {"feishu":"...","poke":"...","format":"markdown|text"}
sb_watch_build_notify_payloads() {
  local event="$1"
  local target="$2"
  local kind="$3"
  local note="${4:-}"
  local capture="${5:-}"   # raw capture; empty for take/ended
  shift 5 || true
  local -a extra_args=()
  local kv
  for kv in "$@"; do
    [[ -n "$kv" ]] && extra_args+=(--extra "$kv")
  done

  local py fmt channel_feishu
  py="$(sb_watch_notify_card_py)"
  fmt="$(sb_watch_default_notify_format)"
  if [[ "$fmt" == "markdown" ]]; then
    channel_feishu="feishu_md"
  else
    channel_feishu="plain"
  fi

  local card_json feishu poke
  if [[ -n "$capture" ]]; then
    card_json="$(printf '%s\n' "$capture" | python3 "$py" extract \
      --event "$event" --target "$target" --kind "$kind" --note "$note" \
      "${extra_args[@]}" 2>/dev/null)" || card_json=""
  else
    card_json="$(python3 "$py" card \
      --event "$event" --target "$target" --kind "$kind" --note "$note" \
      "${extra_args[@]}" 2>/dev/null)" || card_json=""
  fi

  if [[ -z "$card_json" ]]; then
    # Last-resort minimal payloads
    feishu="$(printf '%s\n会话: %s\n类型: %s\n' "$event" "$target" "$kind")"
    poke="$(printf '【host-watch · %s】\n会话: %s\n类型: %s\n' "$event" "$target" "$kind")"
    jq -nc --arg f "$feishu" --arg p "$poke" --arg fmt text \
      '{feishu:$f, poke:$p, format:$fmt}'
    return 0
  fi

  feishu="$(printf '%s\n' "$card_json" | python3 "$py" render --channel "$channel_feishu" 2>/dev/null || true)"
  poke="$(printf '%s\n' "$card_json" | python3 "$py" render --channel poke_text 2>/dev/null || true)"
  if [[ -z "$feishu" || -z "$poke" ]]; then
    feishu="$(printf '%s\n' "$card_json" | python3 "$py" render --channel plain 2>/dev/null || printf '%s\n' "$card_json")"
    poke="$feishu"
    fmt="text"
  fi
  jq -nc --arg f "$feishu" --arg p "$poke" --arg fmt "$fmt" \
    '{feishu:$f, poke:$p, format:$fmt}'
}


# Deliver a watch event. Returns 0 if at least one channel succeeded
# (or identity is none — intentional silence counts as success).
# confirm=1 → real send; 0 → dry-run only.
# Dual-channel notify: feishu_msg for user/bot/owner, poke_msg for agent-poke.
# Optional 6th arg content_format=markdown|text (default text) for say-as-me.
sb_watch_notify() {
  local to="$1"
  local feishu_msg="$2"
  local confirm="${3:-1}"
  local identity="${4:-}"
  local poke_msg="${5:-}"
  local content_format="${6:-}"
  if [[ -z "$identity" ]]; then
    # Legacy callers with empty identity: stay silent (new default), do not
    # revive user+poke. Prefer sb_watch_notify_identity_for_event at call sites.
    identity="none"
  fi
  if [[ -z "$poke_msg" ]]; then
    poke_msg="$feishu_msg"
  fi
  if [[ -z "$content_format" ]]; then
    content_format="$(sb_watch_default_notify_format)"
  fi

  local dry=1
  [[ "$confirm" == "1" ]] && dry=0

  local ok=0
  local want_user=0 want_poke=0 want_bot=0 want_owner=0
  case "$identity" in
    none|off|silent|"")
      sb_audit "watch-notify" "none" "$to" "ok" "suppressed" "${feishu_msg:0:80}"
      return 0
      ;;
    user) want_user=1 ;;
    poke) want_poke=1 ;;
    bot) want_bot=1 ;;
    owner) want_owner=1 ;;
    owner+poke|poke+owner) want_owner=1; want_poke=1 ;;
    user+poke|poke+user) want_user=1; want_poke=1 ;;
    *)
      sb_audit "watch-notify" "unknown" "$to" "deny" "bad-identity=$identity" "${feishu_msg:0:80}"
      return 1
      ;;
  esac

  # 1) user → Dex Feishu p2p (say-as-me). Prefer dex_chat_id; else dex_bot_open_id
  #    as --user-id (lark resolves p2p). Never use owner dex_user_id (that is you).
  if [[ "$want_user" == "1" ]]; then
    if declare -F sb_say_as_me >/dev/null 2>&1; then
      if sb_say_as_me "$to" "$feishu_msg" "$([[ "$dry" == "0" ]] && echo 1 || echo 0)" 0 "$content_format" >/dev/null 2>&1; then
        ok=1
      else
        sb_audit "watch-notify" "user" "$to" "deny" "say-as-me-failed" "${feishu_msg:0:80}"
      fi
    else
      sb_audit "watch-notify" "user" "$to" "deny" "say-as-me-unavailable" "${feishu_msg:0:80}"
    fi
  fi

  # 2) poke Dex session so Main actually runs a turn (not just a Feishu toast).
  #    Always plain short digest (never markdown dump).
  if [[ "$want_poke" == "1" ]]; then
    if declare -F sb_claw_poke_cmd >/dev/null 2>&1; then
      if sb_claw_poke_cmd "$to" "$poke_msg" "$dry" "" >/dev/null 2>&1; then
        ok=1
      else
        sb_audit "watch-notify" "agent-poke" "$to" "deny" "poke-failed" "${poke_msg:0:80}"
      fi
    else
      sb_audit "watch-notify" "agent-poke" "$to" "deny" "poke-unavailable" "${poke_msg:0:80}"
    fi
  fi

  # 3) owner → bot DM to dex_user_id (decision ping to the human, not say-as-me)
  if [[ "$want_owner" == "1" ]]; then
    local owner_dest
    owner_dest="$(sb_watch_owner_feishu_target)"
    if [[ -z "$owner_dest" ]]; then
      sb_audit "watch-notify" "owner" "$to" "deny" "missing-dex_user_id" "${feishu_msg:0:80}"
    elif [[ "$dry" == "1" ]]; then
      sb_audit "watch-notify" "owner" "$owner_dest" "ok" "dry-run" "${feishu_msg:0:80}"
      ok=1
    elif declare -F sb_bot_send >/dev/null 2>&1; then
      # Pass raw open_id so bot-send does not prefer dex_chat_id over owner.
      if sb_bot_send "$owner_dest" "$feishu_msg" 1 "feishu" "" >/dev/null 2>&1; then
        ok=1
      else
        sb_audit "watch-notify" "owner" "$owner_dest" "deny" "bot-send-failed" "${feishu_msg:0:80}"
      fi
    else
      sb_audit "watch-notify" "owner" "$owner_dest" "deny" "bot-send-unavailable" "${feishu_msg:0:80}"
    fi
  fi

  # 4) legacy bot → feishu_targets resolution (chat_id may win); plain text
  if [[ "$want_bot" == "1" ]]; then
    if sb_bot_send "$to" "$feishu_msg" "$([[ "$dry" == "0" ]] && echo 1 || echo 0)" "feishu" "" >/dev/null 2>&1; then
      ok=1
    else
      sb_audit "watch-notify" "bot" "$to" "deny" "bot-send-failed" "${feishu_msg:0:80}"
    fi
  fi

  [[ "$ok" == "1" ]]
}

# attention.json fields for a pane → bash vars via nameref-ish prints.
# Prints: reason\twaiting_kind\tlast_user_prompt\tagent_name\tgit_branch
sb_watch_attention_fields_for_pane() {
  local pane_id="${1:-}"
  if [[ -z "$pane_id" ]]; then
    printf '\t\t\t\t\n'
    return 0
  fi
  local attn_idx
  attn_idx="$(sb_attention_index_json)"
  jq -r --arg p "$pane_id" '
    .[$p] as $e
    | [
        ($e.reason // ""),
        ($e.waiting_kind // ""),
        ($e.last_user_prompt // ""),
        ($e.agent_name // ""),
        ($e.git_branch // "")
      ]
    | @tsv
  ' <<<"$attn_idx" 2>/dev/null || printf '\t\t\t\t\n'
}

# Capture + NotifyCard payloads for need_human / turn_idle.
# Prefer attention.json structured fields; capture is only for TUI option/title parse.
sb_watch_format_need_human_payloads() {
  local target="$1" kind="$2" note="${3:-}" pane_id="${4:-}"
  local tmux_target raw reason waiting_kind last_prompt agent_name git_branch
  tmux_target="$(sb_normalize_host_target "$target")"
  IFS=$'\t' read -r reason waiting_kind last_prompt agent_name git_branch \
    <<<"$(sb_watch_attention_fields_for_pane "$pane_id")"
  raw="$(sb_host_capture_text_raw "$tmux_target" 80 2>/dev/null || true)"
  local -a extras=()
  [[ -n "$reason" ]] && extras+=("reason=$reason")
  [[ -n "$waiting_kind" ]] && extras+=("waiting_kind=$waiting_kind")
  [[ -n "$last_prompt" ]] && extras+=("last_user_prompt=$last_prompt")
  [[ -n "$agent_name" ]] && extras+=("agent_name=$agent_name")
  [[ -n "$git_branch" ]] && extras+=("git_branch=$git_branch")
  sb_watch_build_notify_payloads need_human "$target" "$kind" "$note" "$raw" \
    "${extras[@]}"
}

sb_watch_format_turn_idle_payloads() {
  local target="$1" kind="$2" note="${3:-}" pane_id="${4:-}"
  local tmux_target raw reason last_prompt agent_name
  tmux_target="$(sb_normalize_host_target "$target")"
  IFS=$'\t' read -r reason _ last_prompt agent_name _ \
    <<<"$(sb_watch_attention_fields_for_pane "$pane_id")"
  raw="$(sb_host_capture_text_raw "$tmux_target" 40 2>/dev/null || true)"
  local -a extras=()
  [[ -n "$reason" ]] && extras+=("reason=$reason")
  [[ -n "$last_prompt" ]] && extras+=("last_user_prompt=$last_prompt")
  [[ -n "$agent_name" ]] && extras+=("agent_name=$agent_name")
  sb_watch_build_notify_payloads turn_idle "$target" "$kind" "$note" "$raw" \
    "${extras[@]}"
}

