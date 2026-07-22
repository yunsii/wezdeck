#!/usr/bin/env bash
# bot-send: openclaw message send (bot identity). Default dry-run; --confirm to execute.
# shellcheck source=lib.sh
set -euo pipefail

_SB_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$_SB_LIB_DIR/lib.sh"

sb_bot_send() {
  local to="$1"
  local message="$2"
  local confirm="${3:-0}"
  local channel="${4:-feishu}"
  local account="${5:-}"

  sb_require_no_panic

  # resolve alias → if looks like session key, try feishu_targets map; else use as-is
  local resolved target_cfg
  resolved="$(sb_resolve_alias "$to")"
  target_cfg=""
  if [[ -f "$(sb_config_path)" ]]; then
    # Prefer explicit chat/user id maps over session-key aliases.
    target_cfg="$(jq -er --arg k "$to" '
      .feishu_targets[$k]
      // .feishu_targets[($k + "_chat_id")]
      // .feishu_targets[($k + "_user_id")]
      // empty
    ' "$(sb_config_path)" 2>/dev/null || true)"
  fi
  local dest="$resolved"
  if [[ -n "$target_cfg" ]]; then
    dest="$target_cfg"
  fi

  local -a cmd
  cmd=(openclaw message send --channel "$channel" --target "$dest" --message "$message")
  if [[ -n "$account" ]]; then
    cmd+=(--account "$account")
  fi

  if [[ "$confirm" != "1" ]]; then
    sb_audit "bot-send" "bot" "$dest" "ok" "dry-run" "$message"
    jq -nc \
      --arg identity "bot" \
      --arg to "$dest" \
      --arg message "$message" \
      --arg channel "$channel" \
      --argjson argv "$(printf '%s\0' "${cmd[@]}" | jq -Rs 'split("\u0000")|map(select(length>0))')" \
      '{
        ok: true,
        dry_run: true,
        identity: $identity,
        to: $to,
        channel: $channel,
        message: $message,
        would_run: $argv,
        note: "默认 dry-run；真实发送需 --confirm。身份=bot，不是本人 user，也不是 agent-poke"
      }'
    return 0
  fi

  sb_audit "bot-send" "bot" "$dest" "ok" "execute" "$message"
  local out ec=0
  out="$("${cmd[@]}" 2>&1)" || ec=$?
  if [[ $ec -ne 0 ]]; then
    sb_audit "bot-send" "bot" "$dest" "deny" "exit=$ec" "$message"
    sb_die "$ec" "bot-send 失败 (exit $ec): $out"
  fi
  jq -nc \
    --arg identity "bot" \
    --arg to "$dest" \
    --arg out "$out" \
    '{ok:true, dry_run:false, identity:$identity, to:$to, output:$out}'
}
