#!/usr/bin/env bash
# Open an http(s) URL using the same link.open_target switch as WezTerm
# Ctrl+LeftClick / QuickSelect (published to state/link-open/config.json).
#
# Usage:
#   link-open.sh <url>
#   link-open.sh --target slot|system <url>   # override for one shot
#
# slot   → visible browser slot (cdp: WezDeck Chrome; ego: Ego lite)
# system → OS system handler (Start-Process)
# Legacy override/value "debug" is accepted as an alias of "slot".
# Glossary: docs/browser-debug.md#browser-glossary
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/windows-shell-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/windows-runtime-paths-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/runtime-log-lib.sh" 2>/dev/null || true

WEZTERM_RUNTIME_LOG_SOURCE="${WEZTERM_RUNTIME_LOG_SOURCE:-link-open}"

usage() {
  printf 'link-open: usage: link-open.sh [--target slot|system] <url>\n' >&2
  exit 2
}

override_target=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      [[ $# -ge 2 ]] || usage
      override_target="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      url="$1"
      shift
      break
      ;;
  esac
done
[[ -z "${1-}" ]] || usage
[[ -n "$url" ]] || usage

# Keep only the URL; strip accidental trailing punctuation from pickers.
url="$(printf '%s' "$url" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/[.,;:)\]>]+$//')"
[[ "$url" =~ ^https?:// ]] || {
  printf 'link-open: refusing non-http(s) URL: %s\n' "$url" >&2
  exit 2
}

json_escape() {
  local s="${1-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"
  s="${s//$'\r'/}"
  printf '"%s"' "$s"
}

read_config_field() {
  local key="$1"
  local file="$2"
  [[ -f "$file" ]] || return 1
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg k "$key" '.[$k] // empty' "$file" 2>/dev/null
    return 0
  fi
  # Minimal fallback: "key":"value" or "key":123
  local line
  line="$(grep -oE "\"${key}\"[[:space:]]*:[[:space:]]*(\"[^\"]*\"|[0-9]+)" "$file" 2>/dev/null | head -n1 || true)"
  [[ -n "$line" ]] || return 1
  if [[ "$line" =~ :[[:space:]]*\"([^\"]*)\" ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  elif [[ "$line" =~ :[[:space:]]*([0-9]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  else
    return 1
  fi
}

windows_runtime_detect_paths || true
config_file="${WINDOWS_RUNTIME_STATE_WSL:-}/state/link-open/config.json"
chrome_state="${WINDOWS_RUNTIME_STATE_WSL:-}/state/chrome-debug/state.json"
browser_agent_status="${WINDOWS_RUNTIME_STATE_WSL:-}/state/browser-agent/status.json"
helper_client="${WINDOWS_HELPER_CLIENT_WSL:-}"
helper_pipe="${WINDOWS_HELPER_IPC_ENDPOINT:-\\\\.\\pipe\\wezdeck-runtime-v1}"

open_target="${override_target:-}"
if [[ -z "$open_target" ]]; then
  open_target="$(read_config_field open_target "$config_file" 2>/dev/null || true)"
fi
case "$open_target" in
  system) ;;
  slot|debug) open_target=slot ;; # legacy debug ≡ slot
  *) open_target=slot ;;
esac

backend="$(read_config_field backend "$config_file" 2>/dev/null || true)"
if [[ -z "$backend" && -f "$browser_agent_status" ]]; then
  backend="$(read_config_field backend "$browser_agent_status" 2>/dev/null || true)"
fi
case "$backend" in
  ego|cdp) ;;
  *) backend=cdp ;;
esac

ps_quote() {
  # PowerShell single-quoted string: ' → ''
  local s="${1-}"
  s="${s//\'/\'\'}"
  printf "'%s'" "$s"
}

open_system() {
  local escaped="${url//\'/\'\'}"
  windows_run_powershell_command_utf8 "Start-Process '$escaped'"
  if declare -F runtime_log_info >/dev/null 2>&1; then
    runtime_log_info link "opened url via system handler" url="$url" open_target=system
  fi
}

ensure_cdp_visible() {
  local chrome_path user_data_dir port request_body request_b64
  chrome_path="$(read_config_field chrome_path "$config_file" 2>/dev/null || true)"
  user_data_dir="$(read_config_field user_data_dir "$config_file" 2>/dev/null || true)"
  port="$(read_config_field remote_debugging_port "$config_file" 2>/dev/null || true)"
  [[ -n "$chrome_path" ]] || chrome_path=chrome.exe
  [[ -n "$port" ]] || port=9222
  if [[ -z "$user_data_dir" ]]; then
    printf 'link-open: missing user_data_dir in %s (set chrome_debug_browser.user_data_dir)\n' "$config_file" >&2
    return 1
  fi
  if [[ ! -f "$helper_client" ]]; then
    printf 'link-open: wezdeck-runtime-cli missing at %s\n' "$helper_client" >&2
    return 1
  fi

  local trace_id="link-open-$$"
  request_body="$(printf '{"version":2,"trace_id":%s,"message_type":"request","domain":"chrome","action":"focus_or_start","payload":{"chrome_path":%s,"remote_debugging_port":%s,"user_data_dir":%s,"headless":false}}' \
    "$(json_escape "$trace_id")" \
    "$(json_escape "$chrome_path")" \
    "$port" \
    "$(json_escape "$user_data_dir")")"
  request_b64="$(printf '%s' "$request_body" | base64 | tr -d '\r\n')"
  "$helper_client" request --pipe "$helper_pipe" --payload-base64 "$request_b64" --timeout-ms 8000 >/dev/null

  # Hand the URL to the same profile (Chrome singleton opens a tab).
  # Discrete ArgumentList entries — a single string becomes one chrome argv.
  windows_run_powershell_command_utf8 \
    "Start-Process -FilePath $(ps_quote "$chrome_path") -ArgumentList @($(ps_quote "--remote-debugging-port=${port}"),$(ps_quote "--user-data-dir=${user_data_dir}"),$(ps_quote '--remote-allow-origins=*'),$(ps_quote "$url"))"
}

ensure_ego_and_open() {
  local ego_exe script_win
  ego_exe="$(read_config_field ego_exe "$config_file" 2>/dev/null || true)"
  [[ -n "$ego_exe" ]] || ego_exe='C:\Program Files\Citro Labs\ego lite\Application\ego.exe'

  local ego_script_wsl="${WINDOWS_RUNTIME_HOME_WSL:-}/scripts/ego-window.ps1"
  if [[ -f "$ego_script_wsl" ]]; then
    script_win="$(wslpath -w "$ego_script_wsl")"
    windows_run_powershell_script_utf8 "$script_win" -Focus -Exe "$ego_exe" >/dev/null || true
  fi
  windows_run_powershell_command_utf8 \
    "Start-Process -FilePath $(ps_quote "$ego_exe") -ArgumentList $(ps_quote "$url")"
}

if [[ "$open_target" == "system" ]]; then
  open_system
  exit 0
fi

if [[ "$backend" == "ego" ]]; then
  ensure_ego_and_open
  if declare -F runtime_log_info >/dev/null 2>&1; then
    runtime_log_info link "opened url via ego" url="$url" open_target=slot backend=ego
  fi
  exit 0
fi

if ensure_cdp_visible; then
  if declare -F runtime_log_info >/dev/null 2>&1; then
    runtime_log_info link "opened url via slot chrome-debug" url="$url" open_target=slot backend=cdp
  fi
  exit 0
fi

printf 'link-open: slot open failed; falling back to system handler\n' >&2
if declare -F runtime_log_warn >/dev/null 2>&1; then
  runtime_log_warn link "slot open failed; system fallback" url="$url"
fi
open_system
