#!/usr/bin/env bash
# Session Adapter Kit — thin CLI (P0–P3)
# Concept: narrow adapter, not a second session runtime.
#
# Exit codes:
#   0 ok
#   2 target/runtime/policy failure
#   3 usage
#   75 panic freeze
set -euo pipefail

SB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SB_ROOT/session-bridge/lib.sh"
# shellcheck disable=SC1091
source "$SB_ROOT/session-bridge/host-snapshot.sh"
# shellcheck disable=SC1091
source "$SB_ROOT/session-bridge/claw-project.sh"
# shellcheck disable=SC1091
source "$SB_ROOT/session-bridge/lease.sh"
# shellcheck disable=SC1091
source "$SB_ROOT/session-bridge/host-write.sh"
# shellcheck disable=SC1091
source "$SB_ROOT/session-bridge/bot-send.sh"
# shellcheck disable=SC1091
source "$SB_ROOT/session-bridge/say-as-me.sh"
# shellcheck disable=SC1091
source "$SB_ROOT/session-bridge/watch.sh"

SB_JSON="${SB_JSON:-1}"
export SB_JSON

usage() {
  cat <<'EOF'
session-bridge — Host ↔ Claw Session Adapter Kit (P0–P3)

Usage:
  session-bridge.sh [--json|--text] <command> …

Read:
  host-ls | host-status
  host-capture --target <tmux:sess:w.p|sess:w.p> [--lines N]
  claw-ls [--active minutes]
  claw-show --id <session-key|alias>
  claw-tail --id <session-key|alias> [--lines N]
  audit tail [--lines N]
  lease status [id]

Write / gated:
  poke --id <key|alias> -m <text> [--dry-run] [--agent ID]     # agent-poke
  lease mint --target <pane> [--ttl SEC] [--max-sends N] [--note …]
  lease revoke <id>
  host-send-keys --target <pane> [--text T] [--keys "Enter"] [--enter]
                 [--approve-visible] [--lease ID] [--dry-run]
  bot-send --to <alias|chat> -m <text> [--confirm] [--channel feishu]
  say-as-me --to <alias|id> -m <text> [--confirm] [--interactive]  # user identity
  take [--focus|--target sess:w.p] [--pane-id %N] [--note …] [--ttl SEC]
       [--notify-to alias] [--confirm-notify] [--no-ack] [--dry-run]
  watch-status
  watch-stop --id <job>|--all
  watch-loop                    # internal poller (flock); take starts it
  panic on|off|status

Notes:
  - Default output is JSON.
  - panic freezes ALL writes (exit 75).
  - host-send-keys needs valid lease + host_allowlist + no panic.
  - bot-send / say-as-me default dry-run; --confirm to actually send.
  - host-status may enrich cards from WezDeck attention.json (inferred).
  - take: hand focused/any pane to cheap watch poller; notify only on
    need_human (waiting) or ended — no per-tick LLM.
  - Config: ~/.openclaw/session-bridge.json
  - Audit: ~/.openclaw/logs/session-bridge-audit.jsonl
  - Watch jobs: ~/.openclaw/state/session-bridge-watch/
EOF
}

print_result() {
  local json
  json="$(cat)"
  if [[ "${SB_JSON}" == "1" ]]; then
    printf '%s\n' "$json"
  else
    printf '%s\n' "$json" | jq -r '
      if .error then "ERR: \(.error)"
      elif .cards then "\(.side // "sessions"): \(.cards|length) cards"
      elif .lease then "lease \(.lease.id) target=\(.lease.target) expires=\(.lease.expires_at)"
      elif .text then .text
      elif .summary then .summary
      elif .would_run then ("dry-run: " + (.would_run|join(" ")))
      elif .panic != null then "panic=\(.panic)"
      else (. | tostring) end
    '
  fi
}

cmd_panic() {
  local sub="${1:-status}"
  local p
  p="$(sb_panic_path)"
  case "$sub" in
    on)
      mkdir -p "$(dirname "$p")"
      printf 'on %s\n' "$(sb_now_iso)" >"$p"
      sb_audit "panic" "local" "$p" "ok" "on"
      jq -nc --arg path "$p" '{ok:true, panic:true, path:$path, note:"所有写路径已冻结；需手动 panic off"}' | print_result
      ;;
    off)
      rm -f "$p"
      sb_audit "panic" "local" "$p" "ok" "off"
      jq -nc --arg path "$p" '{ok:true, panic:false, path:$path}' | print_result
      ;;
    status)
      if sb_panic_active; then
        jq -nc --arg path "$p" --arg body "$(cat "$p" 2>/dev/null || true)" \
          '{ok:true, panic:true, path:$path, body:$body}' | print_result
      else
        jq -nc --arg path "$p" '{ok:true, panic:false, path:$path}' | print_result
      fi
      ;;
    *)
      sb_die 3 "panic 子命令: on|off|status"
      ;;
  esac
}

cmd_audit_tail() {
  local n="${1:-30}"
  local f
  f="$(sb_audit_path)"
  if [[ ! -f "$f" ]]; then
    jq -nc --arg path "$f" '{ok:true, path:$path, lines:[]}' | print_result
    return 0
  fi
  local lines
  lines="$(tail -n "$n" "$f" | jq -s -c '.')"
  jq -nc --arg path "$f" --argjson lines "$lines" \
    '{ok:true, path:$path, lines:$lines}' | print_result
}

cmd_host_capture() {
  local target="" lines=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --target) target="${2:-}"; shift 2 ;;
      --lines) lines="${2:-}"; shift 2 ;;
      *) sb_die 3 "未知参数: $1" ;;
    esac
  done
  [[ -n "$target" ]] || sb_die 3 "host-capture 需要 --target"
  sb_host_capture "$target" "${lines:-}" | print_result
}

cmd_claw_ls() {
  local active=180
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --active) active="${2:-180}"; shift 2 ;;
      *) sb_die 3 "未知参数: $1" ;;
    esac
  done
  sb_claw_list_cards "$active" | print_result
}

cmd_claw_show() {
  local id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id|--alias) id="${2:-}"; shift 2 ;;
      *) sb_die 3 "未知参数: $1" ;;
    esac
  done
  [[ -n "$id" ]] || sb_die 3 "claw-show 需要 --id|--alias"
  sb_claw_show "$id" | print_result
}

cmd_claw_tail() {
  local id="" lines=40
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id|--alias) id="${2:-}"; shift 2 ;;
      --lines|--tail) lines="${2:-40}"; shift 2 ;;
      *) sb_die 3 "未知参数: $1" ;;
    esac
  done
  [[ -n "$id" ]] || sb_die 3 "claw-tail 需要 --id|--alias"
  sb_claw_tail "$id" "$lines" | print_result
}

cmd_poke() {
  local id="" message="" dry=0 agent=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id|--alias) id="${2:-}"; shift 2 ;;
      -m|--message) message="${2:-}"; shift 2 ;;
      --dry-run) dry=1; shift ;;
      --agent) agent="${2:-}"; shift 2 ;;
      *) sb_die 3 "未知参数: $1" ;;
    esac
  done
  [[ -n "$id" ]] || sb_die 3 "poke 需要 --id|--alias"
  [[ -n "$message" ]] || sb_die 3 "poke 需要 -m|--message"
  if [[ "${SB_POKE_REQUIRE_DRY:-0}" == "1" && "$dry" != "1" ]]; then
    dry=1
  fi
  sb_claw_poke_cmd "$id" "$message" "$dry" "$agent" | print_result
}

cmd_lease() {
  local sub="${1:-status}"
  shift || true
  case "$sub" in
    mint)
      local target="" ttl="" max_sends=3 note="" minted_by="claw"
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --target) target="${2:-}"; shift 2 ;;
          --ttl) ttl="${2:-}"; shift 2 ;;
          --max-sends) max_sends="${2:-3}"; shift 2 ;;
          --note) note="${2:-}"; shift 2 ;;
          --minted-by) minted_by="${2:-}"; shift 2 ;;
          *) sb_die 3 "未知参数: $1" ;;
        esac
      done
      [[ -n "$target" ]] || sb_die 3 "lease mint 需要 --target"
      sb_lease_mint "$target" "$ttl" "$max_sends" "$minted_by" "$note" | print_result
      ;;
    status)
      local id="${1:-}"
      sb_lease_status "$id" | print_result
      ;;
    revoke)
      local id="${1:-}"
      [[ -n "$id" ]] || sb_die 3 "lease revoke 需要 id"
      sb_lease_revoke "$id" | print_result
      ;;
    *)
      sb_die 3 "lease 子命令: mint|status|revoke"
      ;;
  esac
}

cmd_host_send_keys() {
  local target="" text="" keys="" approve=0 lease="" dry=0 enter=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --target) target="${2:-}"; shift 2 ;;
      --text) text="${2:-}"; shift 2 ;;
      --keys) keys="${2:-}"; shift 2 ;;
      --lease) lease="${2:-}"; shift 2 ;;
      --approve-visible) approve=1; shift ;;
      --enter) enter=1; shift ;;
      --dry-run) dry=1; shift ;;
      *) sb_die 3 "未知参数: $1" ;;
    esac
  done
  [[ -n "$target" ]] || sb_die 3 "host-send-keys 需要 --target"
  if [[ -z "$text" && -z "$keys" && "$approve" != "1" ]]; then
    sb_die 3 "host-send-keys 需要 --text / --keys / --approve-visible 之一"
  fi
  sb_host_send_keys "$target" "$text" "$keys" "$approve" "$lease" "$dry" "$enter" | print_result
}

cmd_bot_send() {
  local to="" message="" confirm=0 channel="feishu" account=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --to) to="${2:-}"; shift 2 ;;
      -m|--message) message="${2:-}"; shift 2 ;;
      --confirm) confirm=1; shift ;;
      --channel) channel="${2:-feishu}"; shift 2 ;;
      --account) account="${2:-}"; shift 2 ;;
      *) sb_die 3 "未知参数: $1" ;;
    esac
  done
  [[ -n "$to" ]] || sb_die 3 "bot-send 需要 --to"
  [[ -n "$message" ]] || sb_die 3 "bot-send 需要 -m|--message"
  sb_bot_send "$to" "$message" "$confirm" "$channel" "$account" | print_result
}

cmd_say_as_me() {
  local to="" message="" confirm=0 interactive=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --to) to="${2:-}"; shift 2 ;;
      -m|--message) message="${2:-}"; shift 2 ;;
      --confirm) confirm=1; shift ;;
      --interactive) interactive=1; shift ;;
      *) sb_die 3 "未知参数: $1" ;;
    esac
  done
  [[ -n "$to" ]] || sb_die 3 "say-as-me 需要 --to"
  [[ -n "$message" ]] || sb_die 3 "say-as-me 需要 -m|--message"
  sb_say_as_me "$to" "$message" "$confirm" "$interactive" | print_result
}

cmd_take() {
  local target="" pane_id="" note="" ttl="" notify_to=""
  local confirm_notify=0 dry=0 no_ack=0 focus=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --focus) focus=1; shift ;;
      --target) target="${2:-}"; shift 2 ;;
      --pane-id) pane_id="${2:-}"; shift 2 ;;
      --note) note="${2:-}"; shift 2 ;;
      --ttl) ttl="${2:-}"; shift 2 ;;
      --notify-to) notify_to="${2:-}"; shift 2 ;;
      --confirm-notify) confirm_notify=1; shift ;;
      --no-ack) no_ack=1; shift ;;
      --dry-run) dry=1; shift ;;
      *) sb_die 3 "未知参数: $1" ;;
    esac
  done
  # Default: focus when neither --target nor explicit empty
  if [[ -z "$target" ]]; then
    focus=1
  fi
  # focus flag alone clears target
  if [[ "$focus" == "1" && -z "$target" ]]; then
    target=""
  fi
  sb_watch_take "$target" "$pane_id" "$note" "$ttl" "$notify_to" \
    "$confirm_notify" "$dry" "$no_ack" | print_result
}

cmd_watch_stop() {
  local id="" all=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id) id="${2:-}"; shift 2 ;;
      --all) all=1; shift ;;
      *) sb_die 3 "未知参数: $1" ;;
    esac
  done
  sb_watch_stop "$id" "$all" | print_result
}

# --- main ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) SB_JSON=1; shift ;;
    --text) SB_JSON=0; shift ;;
    -h|--help|help)
      usage
      exit 0
      ;;
    *) break ;;
  esac
done

cmd="${1:-}"
[[ -n "$cmd" ]] || { usage >&2; exit 3; }
shift || true

case "$cmd" in
  host-ls|host-status)
    sb_host_status | print_result
    ;;
  host-capture)
    cmd_host_capture "$@"
    ;;
  host-send-keys)
    cmd_host_send_keys "$@"
    ;;
  claw-ls)
    cmd_claw_ls "$@"
    ;;
  claw-show)
    cmd_claw_show "$@"
    ;;
  claw-tail)
    cmd_claw_tail "$@"
    ;;
  poke)
    cmd_poke "$@"
    ;;
  lease)
    cmd_lease "$@"
    ;;
  bot-send)
    cmd_bot_send "$@"
    ;;
  say-as-me)
    cmd_say_as_me "$@"
    ;;
  take)
    cmd_take "$@"
    ;;
  watch-status)
    sb_watch_status_cmd | print_result
    ;;
  watch-stop)
    cmd_watch_stop "$@"
    ;;
  watch-loop)
    # internal; no JSON wrapper noise on the long-running process beyond audits
    sb_watch_loop
    ;;
  panic)
    cmd_panic "$@"
    ;;
  audit)
    sub="${1:-tail}"; shift || true
    case "$sub" in
      tail)
        n=30
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --lines) n="${2:-30}"; shift 2 ;;
            *) sb_die 3 "未知参数: $1" ;;
          esac
        done
        cmd_audit_tail "$n"
        ;;
      *) sb_die 3 "audit 子命令: tail" ;;
    esac
    ;;
  help)
    usage
    ;;
  *)
    sb_die 3 "未知命令: $cmd（help 看用法）"
    ;;
esac
