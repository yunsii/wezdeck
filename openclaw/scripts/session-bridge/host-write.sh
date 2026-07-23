#!/usr/bin/env bash
# Gated host writes: host-send-keys (P2). Requires lease + allowlist + no panic.
# shellcheck source=lib.sh
set -euo pipefail

_SB_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$_SB_LIB_DIR/lib.sh"
# shellcheck disable=SC1091
source "$_SB_LIB_DIR/lease.sh"
# shellcheck disable=SC1091
source "$_SB_LIB_DIR/host-snapshot.sh"

# Max literal text length for send_text
SB_SEND_TEXT_MAX="${SB_SEND_TEXT_MAX:-500}"

# Prompt anchors for --approve-visible. Structural tokens only — generic words
# like "continue"/"allow"/"approve" matched ordinary pane output and auto-sent an
# approval key (adversarial-review host-write.sh:62). Matching is also restricted
# to the last lines of the capture (see sb_prompt_visible).
SB_APPROVE_ANCHORS="${SB_APPROVE_ANCHORS:-Do you want|[y/N]|[Y/n]|(y/n)|y/n|Yes / No|❯ 1. Yes|1. Yes|Proceed?}"

sb_host_allowlist_match() {
  local session_name="$1"
  local cfg patterns
  cfg="$(sb_config_path)"
  if [[ ! -f "$cfg" ]]; then
    # no config → deny all host writes (safe default)
    return 1
  fi
  patterns="$(jq -c '.host_allowlist.send_keys_panes // []' "$cfg")"
  if [[ "$(jq -er 'length' <<<"$patterns")" -eq 0 ]]; then
    return 1
  fi
  # glob match each pattern against session name
  local pat
  while IFS= read -r pat; do
    [[ -z "$pat" ]] && continue
    # shellcheck disable=SC2254
    case "$session_name" in
      $pat) return 0 ;;
    esac
  done < <(jq -r '.[]' <<<"$patterns")
  return 1
}

sb_host_session_from_target() {
  local t
  t="$(sb_normalize_host_target "$1")"
  # sess:win.pane → sess
  printf '%s\n' "${t%%:*}"
}

sb_host_capture_text_raw() {
  local tmux_target="$1"
  local lines="${2:-40}"
  if ! sb_host_tmux_ok; then
    return 1
  fi
  local text
  text="$(sb_tmux capture-pane -t "$tmux_target" -p 2>/dev/null)" || return 1
  printf '%s\n' "$text" | tail -n "$lines"
}

# Shared tail-anchor matcher. anchors = pipe-separated, case-insensitive.
sb_text_has_anchor() {
  local text="$1"
  local anchors="$2"
  local tail_n="${3:-6}"
  local tail_text a al lower
  tail_text="$(printf '%s\n' "$text" | tail -n "$tail_n")"
  lower="$(printf '%s' "$tail_text" | tr '[:upper:]' '[:lower:]')"
  local IFS='|'
  for a in $anchors; do
    al="$(printf '%s' "$a" | tr '[:upper:]' '[:lower:]')"
    [[ -z "$al" ]] && continue
    if [[ "$lower" == *"$al"* ]]; then
      return 0
    fi
  done
  return 1
}

sb_prompt_visible() {
  local text="$1"
  # Only inspect the last few lines: a real permission prompt sits at the bottom
  # of the pane, so scrollback like "Continue reading..." can no longer satisfy
  # the gate (adversarial-review host-write.sh:62).
  # Narrow anchors only — used by host-send-keys --approve-visible.
  sb_text_has_anchor "$text" "$SB_APPROVE_ANCHORS" "${SB_APPROVE_TAIL_LINES:-6}"
}

# Watch / take "needs human" detector — broader than approve-visible.
# Covers Claude permission_prompt AND AskUserQuestion / elicitation choice UIs
# (footer: "Enter to select · ↑/↓ to navigate · Esc to cancel").
# Do NOT reuse for auto-key approve — choice menus are not y/N.
SB_WATCH_HUMAN_ANCHORS="${SB_WATCH_HUMAN_ANCHORS:-Do you want|[y/N]|[Y/n]|(y/n)|y/n|Yes / No|❯ 1. Yes|1. Yes|Proceed?|Enter to select|Esc to cancel|to navigate|Tab to amend|Type something.|Chat about this|Yes, and don}"

sb_watch_human_prompt_visible() {
  local text="$1"
  sb_text_has_anchor "$text" "$SB_WATCH_HUMAN_ANCHORS" "${SB_WATCH_HUMAN_TAIL_LINES:-12}"
}

sb_host_send_keys() {
  # args via env-like named params set by caller function below
  local target="$1"
  local text="${2:-}"
  local keys="${3:-}"   # space-separated tmux key names e.g. "Enter" or "y Enter"
  local approve_visible="${4:-0}"
  local lease_id="${5:-}"
  local dry="${6:-0}"
  local enter="${7:-0}"

  sb_require_no_panic

  local tmux_target sess
  tmux_target="$(sb_normalize_host_target "$target")"
  sess="$(sb_host_session_from_target "$target")"

  if ! sb_host_allowlist_match "$sess"; then
    sb_audit "host-send-keys" "remote" "$tmux_target" "deny" "allowlist" "$text$keys"
    sb_die 2 "host-send-keys 拒绝：session '$sess' 不在 host_allowlist.send_keys_panes（空=全拒）"
  fi

  # Forbidden dangerous keys
  local forbidden='C-c C-z C-d C-\\'
  if [[ -n "$keys" ]]; then
    local k
    for k in $keys; do
      case " $forbidden " in
        *" $k "*)
          sb_audit "host-send-keys" "remote" "$tmux_target" "deny" "forbidden_key=$k" "$k"
          sb_die 2 "禁止发送危险键: $k（C-c/C-z/C-d 等不在 lease 范围）"
          ;;
      esac
    done
  fi

  if [[ -n "$text" && "${#text}" -gt "$SB_SEND_TEXT_MAX" ]]; then
    sb_die 2 "文本超过上限 ${SB_SEND_TEXT_MAX} 字符"
  fi

  local action="send_text"
  if [[ "$approve_visible" == "1" ]]; then
    action="approve_if_prompt"
  elif [[ -z "$text" && -n "$keys" ]]; then
    action="send_enter"
  fi

  local found_lease
  if ! found_lease="$(sb_lease_find_for "$tmux_target" "$action" "$lease_id")"; then
    sb_audit "host-send-keys" "remote" "$tmux_target" "deny" "no_lease action=$action" "$text$keys"
    sb_die 2 "无有效 lease（需要 action=$action, target=$tmux_target）。先: lease mint --target …"
  fi

  # approve-visible: capture must show prompt
  local capture_snip=""
  if [[ "$approve_visible" == "1" ]]; then
    if ! capture_snip="$(sb_host_capture_text_raw "$tmux_target" 30 2>/dev/null || true)"; then
      sb_audit "host-send-keys" "remote" "$tmux_target" "deny" "capture_failed" ""
      sb_die 2 "approve-visible 需要先 capture；tmux 不可用或 target 无效"
    fi
    if ! sb_prompt_visible "$capture_snip"; then
      sb_audit "host-send-keys" "remote" "$tmux_target" "deny" "prompt_not_visible" "${capture_snip: -80}"
      sb_die 2 "approve-visible：屏上未见权限/确认锚点，拒绝发送批准键"
    fi
    # default approve key sequence
    if [[ -z "$keys" && -z "$text" ]]; then
      keys="y"
      enter=1
    fi
  fi

  if [[ "$dry" == "1" ]]; then
    sb_audit "host-send-keys" "remote" "$tmux_target" "ok" "dry-run lease=$found_lease" "$text$keys"
    jq -nc \
      --arg target "$tmux_target" \
      --arg lease "$found_lease" \
      --arg action "$action" \
      --arg text "$text" \
      --arg keys "$keys" \
      --argjson enter "$enter" \
      --argjson approve_visible "$approve_visible" \
      '{
        ok: true,
        dry_run: true,
        identity: "remote",
        target: $target,
        lease_id: $lease,
        action: $action,
        text: $text,
        keys: $keys,
        enter: ($enter == 1),
        approve_visible: ($approve_visible == 1),
        note: "不会真实 send-keys；消耗 lease 仅在非 dry-run"
      }'
    return 0
  fi

  if ! sb_host_tmux_ok; then
    sb_audit "host-send-keys" "remote" "$tmux_target" "deny" "tmux_unavailable" ""
    sb_die 2 "tmux server unavailable；无法 send-keys"
  fi

  # Reserve one send atomically BEFORE delivering any keystroke. sb_lease_consume
  # is flock-serialized and re-validates under the lock, so concurrent invocations
  # cannot exceed max_sends (fixes check-then-consume race). If it fails (raced to
  # zero or expired), send nothing.
  local lease_after="null"
  if ! lease_after="$(sb_lease_consume "$found_lease" 2>/dev/null)"; then
    sb_audit "host-send-keys" "remote" "$tmux_target" "deny" "lease_consume_failed action=$action" "$text$keys"
    sb_die 2 "lease 消费失败（可能被并发抢占或已过期）；未发送任何键"
  fi

  # Execute (send already reserved above; a mid-send failure still counts as used)
  if [[ -n "$text" ]]; then
    if ! sb_tmux send-keys -t "$tmux_target" -l -- "$text" 2>/dev/null; then
      sb_audit "host-send-keys" "remote" "$tmux_target" "deny" "send_text_failed" "$text"
      sb_die 2 "tmux send-keys -l 失败: $tmux_target"
    fi
  fi
  if [[ -n "$keys" ]]; then
    # shellcheck disable=SC2086
    if ! sb_tmux send-keys -t "$tmux_target" $keys 2>/dev/null; then
      sb_audit "host-send-keys" "remote" "$tmux_target" "deny" "send_keys_failed" "$keys"
      sb_die 2 "tmux send-keys 失败: $keys"
    fi
  fi
  if [[ "$enter" == "1" ]]; then
    if ! sb_tmux send-keys -t "$tmux_target" Enter 2>/dev/null; then
      sb_audit "host-send-keys" "remote" "$tmux_target" "deny" "enter_failed" ""
      sb_die 2 "tmux send-keys Enter 失败"
    fi
  fi

  sb_audit "host-send-keys" "remote" "$tmux_target" "ok" "lease=$found_lease action=$action" "$text$keys"

  # Optional human-readable receipt (always have audit; bot announce opt-in)
  local receipt_mode receipt_note=""
  receipt_mode="$(sb_cfg_get '.defaults.receipt.mode' 2>/dev/null || true)"
  [[ -z "$receipt_mode" || "$receipt_mode" == "null" ]] && receipt_mode="audit_only"
  local receipt_enabled
  receipt_enabled="$(sb_cfg_get '.defaults.receipt.enabled' 2>/dev/null || true)"
  if [[ "$receipt_enabled" == "true" && "$receipt_mode" == "bot_announce" ]]; then
    # best-effort short card via bot-send dry path only unless SB_RECEIPT_CONFIRM=1
    local receipt_text
    receipt_text="session-bridge 回执: 已对 ${tmux_target} 执行 ${action} (lease=${found_lease})"
    if [[ "${SB_RECEIPT_CONFIRM:-0}" == "1" ]] && declare -F sb_bot_send >/dev/null 2>&1; then
      sb_bot_send "dex" "$receipt_text" 1 "feishu" "" >/dev/null 2>&1 || true
      receipt_note="bot_announce attempted"
    else
      receipt_note="bot_announce configured but needs SB_RECEIPT_CONFIRM=1 (default audit_only)"
    fi
  else
    receipt_note="audit_only (see ~/.openclaw/logs/session-bridge-audit.jsonl)"
  fi

  jq -nc \
    --arg target "$tmux_target" \
    --arg lease "$found_lease" \
    --arg action "$action" \
    --arg text "$text" \
    --arg keys "$keys" \
    --argjson enter "$enter" \
    --argjson lease_after "$lease_after" \
    --arg receipt "$receipt_note" \
    '{
      ok: true,
      dry_run: false,
      identity: "remote",
      target: $target,
      lease_id: $lease,
      action: $action,
      text: $text,
      keys: $keys,
      enter: ($enter == 1),
      lease_after: $lease_after,
      receipt: $receipt,
      note: "遥控≠写码权；单写者仍成立"
    }'
}
