#!/usr/bin/env bash
# Canary / last-good helpers for WezTerm config safety.
#
# After `sync-runtime.sh` (default canary stage):
#   --launch    open an isolated WezTerm window on the canary tree
#   --promote   backup live → last-good, then canary → live
#   --recover   restore last-good → live (and optionally launch WezTerm)
#
# See docs/daily-workflow.md.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$repo_root/scripts/runtime/windows-runtime-paths-lib.sh" 2>/dev/null || true

target_runtime_state_dir() {
  local target_home="${1:?missing target home}"
  if [[ "$target_home" =~ ^/mnt/[A-Za-z]/Users/[^/]+$ ]]; then
    printf '%s/AppData/Local/wezterm-runtime\n' "$target_home"
    return 0
  fi
  printf '%s/.local/state/wezterm-runtime\n' "$target_home"
}

usage() {
  cat <<'EOF'
Usage:
  scripts/dev/wezterm-canary.sh --auto [--timeout SEC]
  scripts/dev/wezterm-canary.sh --launch
  scripts/dev/wezterm-canary.sh --promote
  scripts/dev/wezterm-canary.sh --recover [--start]

Options:
  --auto       Default path: launch canary, wait for healthy.stamp, promote on
               success. Live tree is left untouched if the probe fails/times out.
  --timeout N  Seconds to wait for healthy.stamp in --auto (default 20).
  --launch     Start wezterm.exe on the canary tree only (no promote).
  --promote    Copy live → last-good, then canary → live.
  --recover    Copy last-good → live. With --start, also launch WezTerm on live.
  -h, --help   Show help.
EOF
}

ACTION=""
START_AFTER_RECOVER=0
AUTO_TIMEOUT_SEC="${WEZTERM_CANARY_TIMEOUT_SEC:-20}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto) ACTION=auto; shift ;;
    --launch) ACTION=launch; shift ;;
    --promote) ACTION=promote; shift ;;
    --recover) ACTION=recover; shift ;;
    --start) START_AFTER_RECOVER=1; shift ;;
    --timeout)
      [[ $# -ge 2 ]] || { printf 'Missing value for --timeout\n' >&2; exit 1; }
      AUTO_TIMEOUT_SEC="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

[[ -n "$ACTION" ]] || { usage >&2; exit 1; }

# Prefer the sync-target cache so canary paths match the last sync.
if [[ -f "$repo_root/.sync-target" ]]; then
  TARGET_HOME="$(head -n1 "$repo_root/.sync-target" | tr -d '\r')"
elif windows_runtime_detect_paths 2>/dev/null; then
  TARGET_HOME="$WINDOWS_USERPROFILE_WSL"
else
  TARGET_HOME="${HOME:-}"
fi
[[ -n "$TARGET_HOME" && -d "$TARGET_HOME" ]] || {
  printf 'Cannot resolve target home (run sync once, or set .sync-target).\n' >&2
  exit 1
}

STATE_DIR="$(target_runtime_state_dir "$TARGET_HOME")"
CANARY_ROOT="$STATE_DIR/canary"
LAST_GOOD_ROOT="$STATE_DIR/last-good"
LIVE_BOOTSTRAP="$TARGET_HOME/.wezterm.lua"
LIVE_RUNTIME="$TARGET_HOME/.wezterm-x"
CANARY_BOOTSTRAP="$CANARY_ROOT/.wezterm.lua"
CANARY_RUNTIME="$CANARY_ROOT/.wezterm-x"
LAST_GOOD_BOOTSTRAP="$LAST_GOOD_ROOT/.wezterm.lua"
LAST_GOOD_RUNTIME="$LAST_GOOD_ROOT/.wezterm-x"
CANARY_STAMP="$CANARY_ROOT/healthy.stamp"

find_wezterm_exe() {
  local candidate
  for candidate in \
    "$(command -v wezterm.exe 2>/dev/null || true)" \
    "/mnt/c/Program Files/WezTerm/wezterm.exe" \
    "/mnt/c/Program Files/WezTerm/wezterm-gui.exe" \
    "${WINDOWS_USERPROFILE_WSL:-}/scoop/apps/wezterm/current/wezterm.exe" \
    "${WINDOWS_USERPROFILE_WSL:-}/AppData/Local/Programs/WezTerm/wezterm.exe" \
    "${WINDOWS_USERPROFILE_WSL:-}/AppData/Local/Microsoft/WinGet/Packages"/*/WezTerm*/wezterm.exe
  do
    [[ -n "$candidate" && -f "$candidate" ]] || continue
    printf '%s\n' "$candidate"
    return 0
  done
  # Last resort: PATH wezterm (posix-local)
  if command -v wezterm >/dev/null 2>&1; then
    command -v wezterm
    return 0
  fi
  return 1
}

to_win_path() {
  local p="$1"
  if command -v wslpath >/dev/null 2>&1 && [[ "$p" == /mnt/* ]]; then
    wslpath -w "$p"
  else
    printf '%s\n' "$p"
  fi
}

# QuitApplication from Lua is unreliable on Windows for these short-lived
# probe instances; kill by command-line marker instead.
kill_canary_processes() {
  command -v powershell.exe >/dev/null 2>&1 || return 0
  powershell.exe -NoProfile -Command '
$procs = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq "wezterm.exe" -or $_.Name -eq "wezterm-gui.exe") -and
  ($_.CommandLine -match "wezdeck-canary" -or $_.CommandLine -match "wezterm-runtime\\canary")
}
foreach ($p in $procs) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Output ("killed=" + @($procs).Count)
' 2>/dev/null || true
}

backup_tree() {
  local src_bootstrap="$1" src_runtime="$2" dest_root="$3"
  mkdir -p "$dest_root"
  if [[ -f "$src_bootstrap" ]]; then
    cp -f "$src_bootstrap" "$dest_root/.wezterm.lua"
  fi
  if [[ -d "$src_runtime" ]]; then
    mkdir -p "$dest_root/.wezterm-x"
    rsync -a --delete "$src_runtime"/ "$dest_root/.wezterm-x"/
  fi
}

promote_tree() {
  local src_bootstrap="$1" src_runtime="$2" dest_bootstrap="$3" dest_runtime="$4"
  [[ -f "$src_bootstrap" ]] || {
    printf 'Missing source bootstrap: %s\n' "$src_bootstrap" >&2
    return 1
  }
  [[ -d "$src_runtime" ]] || {
    printf 'Missing source runtime: %s\n' "$src_runtime" >&2
    return 1
  }
  mkdir -p "$(dirname "$dest_bootstrap")"
  mkdir -p "$dest_runtime"
  # Bootstrap last so a mid-copy reload still sees the old entrypoint longer.
  rsync -a --delete "$src_runtime"/ "$dest_runtime"/
  local tmp="${dest_bootstrap}.tmp.$$"
  cp -f "$src_bootstrap" "$tmp"
  mv -f "$tmp" "$dest_bootstrap"
  touch "$dest_bootstrap"
}

launch_canary_process() {
  [[ -f "$CANARY_BOOTSTRAP" ]] || {
    printf 'Canary bootstrap missing: %s\nRun: skills/wezterm-runtime-sync/scripts/sync-runtime.sh\n' \
      "$CANARY_BOOTSTRAP" >&2
    return 1
  }
  [[ -d "$CANARY_RUNTIME" ]] || {
    printf 'Canary runtime missing: %s\nRun sync first.\n' "$CANARY_RUNTIME" >&2
    return 1
  }

  local wez
  wez="$(find_wezterm_exe)" || {
    printf 'wezterm.exe not found on PATH or common install locations.\n' >&2
    return 1
  }

  local cfg_win
  cfg_win="$(to_win_path "$CANARY_BOOTSTRAP")"

  printf 'Launching canary WezTerm\n'
  printf '  exe   : %s\n' "$wez"
  printf '  config: %s\n' "$cfg_win"
  printf '  class : wezdeck-canary (isolated process)\n'

  # --always-new-process: do not merge into the live GUI
  # --class: separate windowing class from the main instance
  # --workspace default + --no-auto-connect: light smoke, no managed cold-open
  if [[ "$wez" == *.exe || "$wez" == */wezterm.exe || "$wez" == */wezterm-gui.exe ]]; then
    "$wez" --config-file "$cfg_win" start \
      --always-new-process \
      --class wezdeck-canary \
      --workspace default \
      --no-auto-connect \
      >/dev/null 2>&1 &
  else
    "$wez" --config-file "$CANARY_BOOTSTRAP" start \
      --always-new-process \
      --class wezdeck-canary \
      --workspace default \
      --no-auto-connect \
      >/dev/null 2>&1 &
  fi
  CANARY_LAUNCH_PID=$!
  disown 2>/dev/null || true
  printf 'Canary process started (pid %s).\n' "$CANARY_LAUNCH_PID"
}

do_launch() {
  launch_canary_process || exit 1
  printf 'Tip: main wezdeck keeps the old config until --promote / --auto succeeds.\n'
}

do_auto() {
  local deadline now
  [[ "$AUTO_TIMEOUT_SEC" =~ ^[0-9]+$ ]] || AUTO_TIMEOUT_SEC=20

  # Clear leftovers from prior probes that failed to quit.
  kill_canary_processes >/dev/null
  rm -f "$CANARY_STAMP"
  # Best-effort Lua-side quit; Windows kill below is the reliable closer.
  mkdir -p "$CANARY_ROOT"
  : >"$CANARY_ROOT/auto-quit.flag"
  launch_canary_process || {
    rm -f "$CANARY_ROOT/auto-quit.flag"
    exit 1
  }

  printf 'Waiting up to %ss for healthy.stamp …\n' "$AUTO_TIMEOUT_SEC"
  deadline=$(( $(date +%s) + AUTO_TIMEOUT_SEC ))
  while true; do
    if [[ -f "$CANARY_STAMP" ]] && grep -q '^ok=1' "$CANARY_STAMP" 2>/dev/null; then
      printf 'Canary healthy (%s).\n' "$CANARY_STAMP"
      # Close probe windows before promote so they do not linger / multiply.
      kill_canary_processes
      do_promote
      rm -f "$CANARY_ROOT/auto-quit.flag"
      printf 'Auto-promote complete (canary windows closed).\n'
      return 0
    fi
    now="$(date +%s)"
    if (( now >= deadline )); then
      break
    fi
    sleep 0.25
  done

  rm -f "$CANARY_ROOT/auto-quit.flag"
  kill_canary_processes
  printf 'Canary probe FAILED: no healthy.stamp within %ss.\n' "$AUTO_TIMEOUT_SEC" >&2
  printf 'Live bootstrap left untouched: %s\n' "$LIVE_BOOTSTRAP" >&2
  printf 'Fix the config and re-run sync.\n' >&2
  printf 'Emergency: scripts/dev/wezterm-canary.sh --recover\n' >&2
  return 1
}

do_promote() {
  [[ -f "$CANARY_BOOTSTRAP" && -d "$CANARY_RUNTIME" ]] || {
    printf 'Canary tree incomplete. Run sync-runtime.sh first.\n' >&2
    exit 1
  }

  printf 'Backing up live → last-good …\n'
  backup_tree "$LIVE_BOOTSTRAP" "$LIVE_RUNTIME" "$LAST_GOOD_ROOT"

  printf 'Promoting canary → live …\n'
  promote_tree "$CANARY_BOOTSTRAP" "$CANARY_RUNTIME" "$LIVE_BOOTSTRAP" "$LIVE_RUNTIME"

  printf 'Done.\n'
  printf '  live bootstrap : %s\n' "$LIVE_BOOTSTRAP"
  printf '  last-good      : %s\n' "$LAST_GOOD_ROOT"
  printf 'Reload the main WezTerm window (or open a new one) to pick up the promoted config.\n'
}

do_recover() {
  [[ -f "$LAST_GOOD_BOOTSTRAP" ]] || {
    printf 'No last-good bootstrap at %s\nPromote at least once before recover.\n' \
      "$LAST_GOOD_BOOTSTRAP" >&2
    exit 1
  }

  printf 'Restoring last-good → live …\n'
  promote_tree "$LAST_GOOD_BOOTSTRAP" "$LAST_GOOD_RUNTIME" "$LIVE_BOOTSTRAP" "$LIVE_RUNTIME"
  printf 'Restored.\n'

  if (( START_AFTER_RECOVER )); then
    local wez
    wez="$(find_wezterm_exe)" || {
      printf 'wezterm.exe not found; live files restored but not launched.\n' >&2
      exit 0
    }
    local cfg_win
    cfg_win="$(to_win_path "$LIVE_BOOTSTRAP")"
    printf 'Starting WezTerm on restored live config …\n'
    if [[ "$wez" == *.exe || "$wez" == */wezterm.exe || "$wez" == */wezterm-gui.exe ]]; then
      "$wez" --config-file "$cfg_win" start --always-new-process >/dev/null 2>&1 &
    else
      "$wez" start --always-new-process >/dev/null 2>&1 &
    fi
    disown 2>/dev/null || true
  else
    printf 'Reload or restart WezTerm to use the recovered config.\n'
  fi
}

case "$ACTION" in
  auto) do_auto ;;
  launch) do_launch ;;
  promote) do_promote ;;
  recover) do_recover ;;
esac
