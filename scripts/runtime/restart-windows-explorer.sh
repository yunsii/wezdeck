#!/usr/bin/env bash
# Ctrl+k e / windows.restart-explorer — restart Windows Explorer (shell).
#
# Typical trigger: after lock→unlock the shell gets stuck — auto-hide hover
# dies (Win/Meta still works), and/or a "maximized" WezTerm grows to the full
# screen bounds and covers the taskbar band (working area ignored).
#
# Steps (implemented in restart-windows-explorer.ps1):
#   1. Recycle explorer.exe (+ ShellHost / ShellExperienceHost /
#      StartMenuExperienceHost / SearchHost) and verify a new explorer PID.
#   2. Settle ABM against StuckRects3 (post-recycle ABM often races to off).
#   3. When auto-hide is on: bounce StuckRects3 byte8 off→on, remamaximize
#      WezTerm (standing preference), then Assert-TrayTopmost LAST so the
#      bar reveals above a true maximized window (no permanent bottom gap).
#   4. When auto-hide is off: re-fit covering wezterm-gui into the working
#      area, then remamaximize windows that were maximized at start.
#
# Outcome contract: toast + runtime.log invoked → completed|failed (duration_ms).
# stdout MUST stay empty for run-shell (view-mode / status COPY risk).
# Always exit 0 from the hotkey wrapper so tmux does not append "returned N".
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/windows-shell-lib.sh"
export WEZTERM_RUNTIME_LOG_SOURCE="restart-windows-explorer.sh"

toast() {
  local msg="${1:-}"
  msg="${msg//$'\n'/ }"
  if ((${#msg} > 120)); then
    msg="${msg:0:117}..."
  fi
  tmux display-message -d 3000 "$msg" 2>/dev/null || true
}

start_ms="$(runtime_log_now_ms)"
common_fields=(
  "hotkey_id=windows.restart-explorer"
)

runtime_log_info workspace "windows explorer restart invoked" "${common_fields[@]}"

if [[ -z "${WSL_DISTRO_NAME:-}" ]] || ! command -v powershell.exe >/dev/null 2>&1; then
  duration_ms="$(runtime_log_duration_ms "$start_ms")"
  toast_msg='Restart Explorer: hybrid-wsl / powershell.exe required.'
  runtime_log_warn workspace "windows explorer restart failed" \
    "${common_fields[@]}" \
    "duration_ms=$duration_ms" \
    "error=not_hybrid_wsl" \
    "toast=$toast_msg"
  toast "$toast_msg"
  exit 0
fi

if ! command -v wslpath >/dev/null 2>&1; then
  duration_ms="$(runtime_log_duration_ms "$start_ms")"
  toast_msg='Restart Explorer: wslpath required.'
  runtime_log_warn workspace "windows explorer restart failed" \
    "${common_fields[@]}" \
    "duration_ms=$duration_ms" \
    "error=no_wslpath" \
    "toast=$toast_msg"
  toast "$toast_msg"
  exit 0
fi

# Body lives in a sibling .ps1 — EncodedCommand hits Windows argv length limits
# once settle / edge-gap logic is inlined.
ps1_path="$SCRIPT_DIR/restart-windows-explorer.ps1"
if [[ ! -f "$ps1_path" ]]; then
  duration_ms="$(runtime_log_duration_ms "$start_ms")"
  toast_msg='Restart Explorer: missing restart-windows-explorer.ps1.'
  runtime_log_warn workspace "windows explorer restart failed" \
    "${common_fields[@]}" \
    "duration_ms=$duration_ms" \
    "error=missing_ps1" \
    "toast=$toast_msg"
  toast "$toast_msg"
  exit 0
fi
ps1_win="$(wslpath -w "$ps1_path")"

ec=0
ps_out=""
ps_out="$(windows_run_powershell_script_utf8 "$ps1_win" 2>&1)" || ec=$?
duration_ms="$(runtime_log_duration_ms "$start_ms")"
status_line="$(printf '%s\n' "$ps_out" | tr -d '\r' | grep -E '^ok=' | tail -n 1 || true)"

ok=""
new_pid=""
start_t=""
autohide=""
wezterm_healed=""
tray_topmost=""
shellhost_recycled=""
stuckrects_bounce=""
abm_val=""
byte8_val=""
if [[ -n "$status_line" ]]; then
  [[ "$status_line" =~ ok=([^ ]+) ]] && ok="${BASH_REMATCH[1]}"
  [[ "$status_line" =~ pid=([^ ]+) ]] && new_pid="${BASH_REMATCH[1]}"
  [[ "$status_line" =~ start=([^ ]+) ]] && start_t="${BASH_REMATCH[1]}"
  [[ "$status_line" =~ autohide=([^ ]+) ]] && autohide="${BASH_REMATCH[1]}"
  [[ "$status_line" =~ wezterm_healed=([^ ]+) ]] && wezterm_healed="${BASH_REMATCH[1]}"
  [[ "$status_line" =~ tray_topmost=([^ ]+) ]] && tray_topmost="${BASH_REMATCH[1]}"
  [[ "$status_line" =~ shellhost_recycled=([^ ]+) ]] && shellhost_recycled="${BASH_REMATCH[1]}"
  [[ "$status_line" =~ stuckrects_bounce=([^ ]+) ]] && stuckrects_bounce="${BASH_REMATCH[1]}"
  [[ "$status_line" =~ abm=([^ ]+) ]] && abm_val="${BASH_REMATCH[1]}"
  [[ "$status_line" =~ byte8=([^ ]+) ]] && byte8_val="${BASH_REMATCH[1]}"
fi

if ((ec != 0)) || [[ "$ok" != "True" && "$ok" != "true" ]]; then
  toast_msg="Restart Explorer failed (exit ${ec}; ok=${ok:-?})."
  runtime_log_warn workspace "windows explorer restart failed" \
    "${common_fields[@]}" \
    "duration_ms=$duration_ms" \
    "exit_code=$ec" \
    "status=${status_line:-}" \
    "toast=$toast_msg" \
    "stderr=${ps_out//$'\n'/ }"
  toast "$toast_msg"
  exit 0
fi

toast_msg="Explorer ok (pid ${new_pid} @ ${start_t}; autohide ${autohide}"
if [[ -n "${stuckrects_bounce}" && "${stuckrects_bounce}" != "skip" ]]; then
  toast_msg+=", bounce ${stuckrects_bounce}"
fi
if [[ -n "${wezterm_healed}" && "${wezterm_healed}" != "0" ]]; then
  toast_msg+=", wezterm healed ${wezterm_healed}"
fi
if [[ -n "${tray_topmost}" && "${tray_topmost}" != "skip" ]]; then
  toast_msg+=", tray ${tray_topmost}"
fi
toast_msg+=")."

runtime_log_info workspace "windows explorer restart completed" \
  "${common_fields[@]}" \
  "duration_ms=$duration_ms" \
  "explorer_pid=${new_pid}" \
  "explorer_start=${start_t}" \
  "autohide=${autohide}" \
  "abm=${abm_val:-}" \
  "byte8=${byte8_val:-}" \
  "shellhost_recycled=${shellhost_recycled:-}" \
  "stuckrects_bounce=${stuckrects_bounce:-}" \
  "wezterm_healed=${wezterm_healed:-0}" \
  "tray_topmost=${tray_topmost:-}" \
  "toast=$toast_msg"
toast "$toast_msg"
exit 0
