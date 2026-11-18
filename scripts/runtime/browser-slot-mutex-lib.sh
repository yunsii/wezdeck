#!/usr/bin/env bash
# Browser-slot mutual exclusion: the slot holds one backend at a time.
# When backend=ego → CDP debug Chrome auto_start off + stop chrome-debug.
# When backend=cdp → CDP auto_start on (+ wait for :port) + stop Ego.
#
# Sourced by apply-browser-backend.sh. Glossary:
#   docs/browser-debug.md#browser-glossary
#
# Requires (callers usually already sourced):
#   windows-runtime-paths-lib.sh, windows-shell-lib.sh
# Optional: runtime-log-lib.sh, browser-agent-status-lib.sh

# Capture at source time — BASH_SOURCE inside a function can be wrong under zsh.
_BROWSER_SLOT_MUTEX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

browser_slot_mutex_default_ego_exe() {
  if declare -F browser_agent_ego_exe_win >/dev/null 2>&1; then
    browser_agent_ego_exe_win
    return 0
  fi
  printf '%s\n' 'C:\Program Files\Citro Labs\ego lite\Application\ego.exe'
}

browser_slot_mutex_read_json_field() {
  local key="$1" file="$2"
  [[ -f "$file" ]] || return 1
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg k "$key" 'if type=="object" then (.[$k] // empty) else empty end' "$file" 2>/dev/null
    return 0
  fi
  local line
  line="$(grep -oE "\"${key}\"[[:space:]]*:[[:space:]]*(\"[^\"]*\"|[0-9]+|true|false)" "$file" 2>/dev/null | head -n1 || true)"
  [[ -n "$line" ]] || return 1
  if [[ "$line" =~ :[[:space:]]*\"([^\"]*)\" ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  elif [[ "$line" =~ :[[:space:]]*(true|false|[0-9]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  else
    return 1
  fi
}

# Nested: chromeDebugAutoStart.userDataDir via jq; grep fallback for flat keys only.
browser_slot_mutex_read_nested() {
  local path="$1" file="$2"
  [[ -f "$file" ]] || return 1
  if command -v jq >/dev/null 2>&1; then
    jq -r "$path // empty" "$file" 2>/dev/null
    return 0
  fi
  return 1
}

browser_slot_mutex_resolve_chrome() {
  # Sets: BS_CHROME_PATH BS_CHROME_PORT BS_CHROME_USER_DATA (may be empty)
  BS_CHROME_PATH="${WEZDECK_CHROME_DEBUG_PATH:-chrome.exe}"
  BS_CHROME_PORT="${WEZDECK_CDP_PORT:-9222}"
  BS_CHROME_USER_DATA="${WEZDECK_CHROME_DEBUG_USER_DATA:-${BROWSER_HISTORY_PURGE_CHROME_DEBUG_USER_DATA:-}}"

  if [[ -z "${WINDOWS_RUNTIME_STATE_WSL:-}" ]]; then
    windows_runtime_detect_paths 2>/dev/null || true
  fi
  local mgr="${WINDOWS_RUNTIME_STATE_WSL:-}/state/helper/manager-config.json"
  local link_cfg="${WINDOWS_RUNTIME_STATE_WSL:-}/state/link-open/config.json"
  local v

  if [[ -z "$BS_CHROME_USER_DATA" ]]; then
    v="$(browser_slot_mutex_read_nested '.chromeDebugAutoStart.userDataDir' "$mgr" 2>/dev/null || true)"
    [[ -n "$v" && "$v" != null ]] && BS_CHROME_USER_DATA="$v"
  fi
  if [[ -z "$BS_CHROME_USER_DATA" ]]; then
    v="$(browser_slot_mutex_read_json_field user_data_dir "$link_cfg" 2>/dev/null || true)"
    [[ -n "$v" ]] && BS_CHROME_USER_DATA="$v"
  fi
  if [[ -z "$BS_CHROME_USER_DATA" && -n "${WEZDECK_REPO:-}" && -f "$WEZDECK_REPO/wezterm-x/local/constants.lua" ]]; then
    v="$(grep -oE "user_data_dir[[:space:]]*=[[:space:]]*'[^']+'" \
      "$WEZDECK_REPO/wezterm-x/local/constants.lua" 2>/dev/null | head -n1 | sed -E "s/.*'([^']+)'.*/\1/" || true)"
    [[ -n "$v" ]] && BS_CHROME_USER_DATA="$v"
  fi

  v="$(browser_slot_mutex_read_nested '.chromeDebugAutoStart.chromePath' "$mgr" 2>/dev/null || true)"
  [[ -n "$v" && "$v" != null ]] && BS_CHROME_PATH="$v"
  v="$(browser_slot_mutex_read_json_field chrome_path "$link_cfg" 2>/dev/null || true)"
  [[ -n "$v" ]] && BS_CHROME_PATH="$v"
  v="$(browser_slot_mutex_read_nested '.chromeDebugAutoStart.remoteDebuggingPort' "$mgr" 2>/dev/null || true)"
  [[ -n "$v" && "$v" != null ]] && BS_CHROME_PORT="$v"
  v="$(browser_slot_mutex_read_json_field remote_debugging_port "$link_cfg" 2>/dev/null || true)"
  [[ -n "$v" ]] && BS_CHROME_PORT="$v"
  return 0
}

browser_slot_mutex_set_chrome_auto_start() {
  local enabled="${1:?0|1}"
  browser_slot_mutex_resolve_chrome

  if [[ -z "${WINDOWS_RUNTIME_HOME_WSL:-}" ]]; then
    windows_runtime_detect_paths || return 1
  fi
  local ensure_wsl="$WINDOWS_RUNTIME_HOME_WSL/scripts/ensure-wezdeck-runtime.ps1"
  [[ -f "$ensure_wsl" ]] || {
    printf 'browser-slot-mutex: ensure script missing: %s\n' "$ensure_wsl" >&2
    return 1
  }
  local ensure_win state_win
  ensure_win="$(wslpath -w "$ensure_wsl")"
  state_win="$WINDOWS_HELPER_STATE_WIN"

  # Bound chrome args so inheritance cannot keep the previous enabled bit.
  windows_run_powershell_script_utf8 "$ensure_win" \
    -StatePath "$state_win" \
    -ChromeDebugAutoStartEnabled "$enabled" \
    -ChromeDebugChromePath "$BS_CHROME_PATH" \
    -ChromeDebugRemoteDebuggingPort "$BS_CHROME_PORT" \
    -ChromeDebugUserDataDir "${BS_CHROME_USER_DATA:-}" \
    -DiagnosticsEnabled 1 \
    -DiagnosticsCategoryEnabled 1 \
    -DiagnosticsLevel info \
    -HeartbeatTimeoutSeconds 5 \
    -HeartbeatIntervalMs 250 >/dev/null

  if declare -F runtime_log_info >/dev/null 2>&1; then
    runtime_log_info browser_agent "chrome auto_start rewritten" \
      enabled="$enabled" port="$BS_CHROME_PORT" user_data_dir="${BS_CHROME_USER_DATA:-}"
  fi
}

browser_slot_mutex_stop_chrome_debug() {
  browser_slot_mutex_resolve_chrome
  if [[ -z "$BS_CHROME_USER_DATA" ]]; then
    printf 'browser-slot-mutex: warn: no chrome-debug user_data_dir; skip stop\n' >&2
    return 0
  fi

  if [[ -z "${WINDOWS_RUNTIME_STATE_WSL:-}" ]]; then
    windows_runtime_detect_paths || return 1
  fi

  local ps_wsl="$WINDOWS_RUNTIME_STATE_WSL/tmp-browser-slot-stop-chrome.ps1"
  mkdir -p "$(dirname "$ps_wsl")"
  # Escape for PowerShell single-quoted string inside the generated script.
  local needle_ps="${BS_CHROME_USER_DATA//\'/\'\'}"
  cat >"$ps_wsl" <<EOF
\$ErrorActionPreference = 'Continue'
\$needle = '${needle_ps}'
\$holders = @(Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | Where-Object {
  \$_.CommandLine -and (\$_.CommandLine -like ('*{0}*' -f \$needle)) -and (\$_.CommandLine -notlike '*--type=*')
})
Write-Output ('holders=' + \$holders.Count)
foreach (\$p in \$holders) {
  Write-Output ('graceful pid=' + \$p.ProcessId)
  Stop-Process -Id \$p.ProcessId -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3
\$left = @(Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | Where-Object {
  \$_.CommandLine -and (\$_.CommandLine -like ('*{0}*' -f \$needle))
})
if (\$left.Count -gt 0) {
  foreach (\$p in \$left) {
    Write-Output ('force pid=' + \$p.ProcessId)
    Stop-Process -Id \$p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}
\$final = @(Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | Where-Object {
  \$_.CommandLine -and (\$_.CommandLine -like ('*{0}*' -f \$needle))
})
Write-Output ('remaining=' + \$final.Count)
EOF
  local ps_win
  ps_win="$(wslpath -w "$ps_wsl")"
  windows_run_powershell_script_utf8 "$ps_win"
  rm -f "$ps_wsl"

  if declare -F runtime_log_info >/dev/null 2>&1; then
    runtime_log_info browser_agent "stopped chrome-debug for slot mutex" \
      user_data_dir="$BS_CHROME_USER_DATA"
  fi
}

browser_slot_mutex_stop_ego() {
  local ps_body
  ps_body='Write-Output ("ego_before=" + @(Get-Process -Name ego -ErrorAction SilentlyContinue).Count); Get-Process -Name ego -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; Write-Output ("ego_after=" + @(Get-Process -Name ego -ErrorAction SilentlyContinue).Count)'
  windows_run_powershell_command_utf8 "$ps_body"
  if declare -F runtime_log_info >/dev/null 2>&1; then
    runtime_log_info browser_agent "stopped ego for slot mutex"
  fi
}

browser_slot_mutex_wait_cdp() {
  local port="${1:-${BS_CHROME_PORT:-9222}}"
  local i
  for i in $(seq 1 40); do
    if curl -sS -m 1 "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

browser_slot_mutex_init_paths() {
  # shellcheck disable=SC1091
  source "$_BROWSER_SLOT_MUTEX_DIR/windows-shell-lib.sh"
  # shellcheck disable=SC1091
  source "$_BROWSER_SLOT_MUTEX_DIR/windows-runtime-paths-lib.sh"
  windows_runtime_detect_paths || {
    printf 'browser-slot-mutex: warn: Windows paths unavailable\n' >&2
    return 1
  }
  browser_slot_mutex_resolve_chrome
  return 0
}

# Before probing CDP: turn auto_start on and wait for :port.
browser_slot_mutex_prepare_cdp() {
  local dry_run="${1:-0}"
  if ! browser_slot_mutex_init_paths; then
    return 0
  fi
  printf 'slot-mutex: prepare cdp port=%s user_data=%s dry_run=%s\n' \
    "$BS_CHROME_PORT" "${BS_CHROME_USER_DATA:-?}" "$dry_run"
  if ((dry_run)); then
    printf '  dry-run: ChromeDebugAutoStartEnabled=1 + wait :%s\n' "$BS_CHROME_PORT"
    return 0
  fi
  browser_slot_mutex_set_chrome_auto_start 1 || {
    printf 'browser-slot-mutex: warn: failed to rewrite auto_start=1\n' >&2
  }
  if browser_slot_mutex_wait_cdp "$BS_CHROME_PORT"; then
    printf 'slot-mutex: CDP :%s ready\n' "$BS_CHROME_PORT"
  else
    printf 'browser-slot-mutex: warn: CDP :%s not up after auto_start enable\n' "$BS_CHROME_PORT" >&2
  fi
}

# After the selected backend is accepted: stop the other side.
browser_slot_mutex_teardown_other() {
  local backend="${1:?ego|cdp}"
  local dry_run="${2:-0}"

  case "$backend" in
    ego|cdp) ;;
    *)
      printf 'browser-slot-mutex: backend must be ego|cdp, got %q\n' "$backend" >&2
      return 2
      ;;
  esac

  if ! browser_slot_mutex_init_paths; then
    return 0
  fi
  printf 'slot-mutex: teardown other (keep=%s) dry_run=%s\n' "$backend" "$dry_run"

  if [[ "$backend" == "ego" ]]; then
    if ((dry_run)); then
      printf '  dry-run: ChromeDebugAutoStartEnabled=0 + stop chrome-debug\n'
      return 0
    fi
    printf 'slot-mutex: disable CDP auto_start + stop chrome-debug\n'
    browser_slot_mutex_set_chrome_auto_start 0 || {
      printf 'browser-slot-mutex: warn: failed to rewrite auto_start=0\n' >&2
    }
    browser_slot_mutex_stop_chrome_debug || {
      printf 'browser-slot-mutex: warn: stop chrome-debug failed\n' >&2
    }
    return 0
  fi

  if ((dry_run)); then
    printf '  dry-run: stop ego\n'
    return 0
  fi
  printf 'slot-mutex: stop ego\n'
  browser_slot_mutex_stop_ego || {
    printf 'browser-slot-mutex: warn: stop ego failed\n' >&2
  }
}
