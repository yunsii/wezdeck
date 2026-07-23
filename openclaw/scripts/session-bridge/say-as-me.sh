#!/usr/bin/env bash
# say-as-me (P3): send Feishu message as the human user via lark-cli.
# Default dry-run; requires --confirm (and optional interactive TTY yes).
# shellcheck source=lib.sh
set -euo pipefail

_SB_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$_SB_LIB_DIR/lib.sh"

sb_say_as_me() {
  local to="$1"
  local message="$2"
  local confirm="${3:-0}"
  local interactive="${4:-0}"

  sb_require_no_panic

  if ! command -v lark-cli >/dev/null 2>&1; then
    sb_die 2 "lark-cli 不在 PATH（say-as-me 需要用户身份 CLI）"
  fi

  local resolved dest_user="" dest_chat="" owner_user=""
  resolved="$(sb_resolve_alias "$to")"
  # Prefer explicit feishu_targets map.
  # For alias "dex": chat_id (p2p with bot) or bot_open_id — NOT owner user_id.
  # Owner dex_user_id is who *you* are; messaging it is not "talk to Dex".
  if [[ -f "$(sb_config_path)" ]]; then
    dest_chat="$(jq -er --arg k "$to" '
      .feishu_targets[($k + "_chat_id")] // .feishu_targets.dex_chat_id // empty
    ' "$(sb_config_path)" 2>/dev/null || true)"
    dest_user="$(jq -er --arg k "$to" '
      .feishu_targets[($k + "_bot_open_id")]
      // .feishu_targets.dex_bot_open_id
      // empty
    ' "$(sb_config_path)" 2>/dev/null || true)"
    owner_user="$(jq -er --arg k "$to" '
      .feishu_targets[($k + "_user_id")] // .feishu_targets.dex_user_id // empty
    ' "$(sb_config_path)" 2>/dev/null || true)"
  fi
  # Heuristic: ou_ → user-id, oc_ → chat-id (only when map empty)
  if [[ -z "$dest_user" && -z "$dest_chat" ]]; then
    case "$resolved" in
      ou_*)
        # Refuse owner open_id masquerading as Dex destination
        if [[ -n "$owner_user" && "$resolved" == "$owner_user" ]]; then
          sb_die 2 "say-as-me → dex 需要 feishu_targets.dex_chat_id 或 dex_bot_open_id（不是 dex_user_id=主人自己）"
        fi
        dest_user="$resolved"
        ;;
      oc_*) dest_chat="$resolved" ;;
      agent:*)
        sb_die 2 "say-as-me 需要 feishu_targets.dex_chat_id 或 dex_bot_open_id，不能直接用 session key"
        ;;
      *)
        if [[ -n "$owner_user" ]]; then
          sb_die 2 "say-as-me → ${to} 需要 feishu_targets.${to}_chat_id 或 ${to}_bot_open_id"
        fi
        dest_user="$resolved"
        ;;
    esac
  fi
  if [[ -z "$dest_user" && -z "$dest_chat" ]]; then
    sb_die 2 "say-as-me 无目标：配置 feishu_targets.dex_chat_id（推荐）或 dex_bot_open_id"
  fi

  local -a cmd
  cmd=(lark-cli im +messages-send --text "$message")
  if [[ -n "$dest_chat" ]]; then
    cmd+=(--chat-id "$dest_chat")
  else
    cmd+=(--user-id "$dest_user")
  fi

  if [[ "$confirm" != "1" ]]; then
    sb_audit "say-as-me" "user" "${dest_chat:-$dest_user}" "ok" "dry-run" "$message"
    jq -nc \
      --arg identity "user" \
      --arg to "${dest_chat:-$dest_user}" \
      --arg message "$message" \
      --argjson argv "$(printf '%s\0' "${cmd[@]}" | jq -Rs 'split("\u0000")|map(select(length>0))')" \
      '{
        ok: true,
        dry_run: true,
        identity: $identity,
        to: $to,
        message: $message,
        would_run: $argv,
        note: "身份=user（lark-cli 本人）。默认 dry-run；真发需 --confirm（建议交互终端）"
      }'
    return 0
  fi

  if [[ "$interactive" == "1" ]]; then
    if [[ ! -t 0 ]]; then
      sb_die 2 "say-as-me --confirm 建议在 TTY 下加 --interactive；非交互请仅 --confirm 且你已明确授权"
    fi
    printf 'say-as-me: 将以【本人】身份发送到 %s\n内容: %s\n确认发送? [y/N] ' "${dest_chat:-$dest_user}" "$message" >&2
    local ans=""
    read -r ans || true
    case "$ans" in
      y|Y|yes|YES) ;;
      *)
        sb_audit "say-as-me" "user" "${dest_chat:-$dest_user}" "deny" "user_aborted" "$message"
        sb_die 2 "已取消 say-as-me"
        ;;
    esac
  fi

  sb_audit "say-as-me" "user" "${dest_chat:-$dest_user}" "ok" "execute" "$message"
  local out ec=0
  out="$("${cmd[@]}" 2>&1)" || ec=$?
  if [[ $ec -ne 0 ]]; then
    sb_audit "say-as-me" "user" "${dest_chat:-$dest_user}" "deny" "exit=$ec" "$message"
    sb_die "$ec" "say-as-me 失败 (exit $ec): $out"
  fi
  jq -nc \
    --arg identity "user" \
    --arg to "${dest_chat:-$dest_user}" \
    --arg out "$out" \
    '{ok:true, dry_run:false, identity:$identity, to:$to, output:$out}'
}
