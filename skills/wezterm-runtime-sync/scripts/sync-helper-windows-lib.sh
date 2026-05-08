#!/usr/bin/env bash
# sync-helper-windows-lib.sh
#
# Windows host-helper install + ensure round-trips for sync-runtime.sh.
# Sourced (do not execute). Each entry point bails out cleanly on hosts
# where the WSL/Windows runtime path or PowerShell isn't available.
#
# Skip-if-current gates:
#   helper_install_skip_if_current  → skips dotnet publish round-trip
#                                     when sources are unchanged since the
#                                     last successful install (~1-1.5s save)
#   helper_ensure_skip_if_running   → skips PS heartbeat probe when state
#                                     file shows ready=1 with fresh mtime
#                                     and no runtime change since (~400-500ms)
#
# Both gates can be force-bypassed:
#   WEZTERM_SYNC_FORCE_HELPER_INSTALL=1
#   WEZTERM_SYNC_FORCE_HELPER_ENSURE=1
#
# Required from caller's environment:
#   - sync_trace, runtime_log_{info,warn,error} functions
#   - windows_run_powershell_script_utf8 from windows-shell-lib.sh
#   - $NATIVE_SOURCE_DIR (repo's native/ path)

helper_install_skip_if_current() {
  # Returns 0 if a previous install is still current — i.e., the install
  # state file and helper-manager binary exist AND no relevant source file
  # is newer than the state file. Caller should skip the dotnet-publish
  # round-trip into PowerShell when this returns 0. Only checks the local
  # build path's inputs (.NET sources + release manifest); the release
  # path has its own PS-side skip-if-current via Test-ReleaseInstallCurrent.
  local target_runtime_dir="${1:?missing target runtime dir}"
  local target_home install_root state_file binary_path src_dir manifest newer

  [[ "${WEZTERM_SYNC_FORCE_HELPER_INSTALL:-0}" == "1" ]] && return 1

  target_home="$(dirname "$target_runtime_dir")"
  install_root="$target_home/AppData/Local/wezterm-runtime/bin"
  state_file="$install_root/helper-install-state.json"
  binary_path="$install_root/helper-manager.exe"
  src_dir="$NATIVE_SOURCE_DIR/host-helper/windows/src"
  manifest="$NATIVE_SOURCE_DIR/host-helper/windows/release-manifest.json"

  [[ -f "$state_file" ]] || return 1
  [[ -f "$binary_path" ]] || return 1
  [[ -d "$src_dir" ]] || return 1

  newer="$(find "$src_dir" -type f -newer "$state_file" -print -quit 2>/dev/null)"
  [[ -z "$newer" ]] || return 1
  if [[ -f "$manifest" && "$manifest" -nt "$state_file" ]]; then
    return 1
  fi
  return 0
}

install_windows_helper_manager() {
  local target_runtime_dir="${1:?missing target runtime dir}"
  local install_script="$target_runtime_dir/scripts/install-windows-runtime-helper-manager.ps1"
  local install_script_win="" runtime_dir_win="" install_output="" manager_path=""
  local target_home="" target_home_win="" diagnostics_file_win=""
  local install_source="${WEZTERM_WINDOWS_HELPER_INSTALL_SOURCE:-auto}"

  [[ "$target_runtime_dir" =~ ^/mnt/[A-Za-z]/Users/ ]] || return 0
  command -v powershell.exe >/dev/null 2>&1 || return 0
  command -v wslpath >/dev/null 2>&1 || return 0
  [[ -f "$install_script" ]] || return 0
  case "$install_source" in
    auto|local|release) ;;
    *)
      printf 'Unsupported WEZTERM_WINDOWS_HELPER_INSTALL_SOURCE: %s\n' "$install_source" >&2
      return 1
      ;;
  esac

  if helper_install_skip_if_current "$target_runtime_dir"; then
    sync_trace "step=helper-install status=skipped reason=up-to-date target_runtime_dir=$target_runtime_dir install_source=$install_source"
    runtime_log_info sync "skipped windows helper install (up-to-date)" \
      "target_runtime_dir=$target_runtime_dir" \
      "install_source=$install_source"
    return 0
  fi

  install_script_win="$(wslpath -w "$install_script" 2>/dev/null || true)"
  runtime_dir_win="$(wslpath -w "$target_runtime_dir" 2>/dev/null || true)"
  target_home="$(dirname "$target_runtime_dir")"
  target_home_win="$(wslpath -w "$target_home" 2>/dev/null || true)"
  [[ -n "$target_home_win" ]] && diagnostics_file_win="${target_home_win}\\AppData\\Local\\wezterm-runtime\\logs\\helper.log"
  [[ -n "$install_script_win" && -n "$runtime_dir_win" && -n "$diagnostics_file_win" ]] || return 0

  sync_trace "step=helper-install status=starting target_runtime_dir=$target_runtime_dir runtime_dir_win=$runtime_dir_win install_script_win=$install_script_win install_source=$install_source"
  if ! install_output="$(
    windows_run_powershell_script_utf8 "$install_script_win" \
      -RuntimeDir "$runtime_dir_win" \
      -InstallSource "$install_source" \
      -Trigger runtime_sync \
      -DiagnosticsEnabled 1 \
      -DiagnosticsCategoryEnabled 1 \
      -DiagnosticsLevel info \
      -DiagnosticsFile "$diagnostics_file_win" \
      -DiagnosticsMaxBytes 5242880 \
      -DiagnosticsMaxFiles 5 2>&1 | tr -d '\r'
  )"; then
    [[ -n "$install_output" ]] && printf '%s\n' "$install_output" >&2
    sync_trace "step=helper-install status=failed target_runtime_dir=$target_runtime_dir install_source=$install_source"
    runtime_log_error sync "failed to install windows helper manager after sync" \
      "target_runtime_dir=$target_runtime_dir" \
      "install_source=$install_source"
    return 1
  fi

  [[ -n "$install_output" ]] && printf '%s\n' "$install_output"
  manager_path="$(printf '%s\n' "$install_output" | tail -n 1)"
  sync_trace "step=helper-install status=completed manager_path=${manager_path:-unknown} install_source=$install_source"
  runtime_log_info sync "installed windows helper manager after sync" \
    "target_runtime_dir=$target_runtime_dir" \
    "manager_path=${manager_path:-unknown}" \
    "install_source=$install_source"
  return 0
}

helper_ensure_skip_if_running() {
  # Returns 0 if the helper is already running with a fresh heartbeat AND
  # has not missed any subsequent runtime change — i.e., it's safe to skip
  # the PowerShell ensure round-trip (~400-500ms cold). Mirrors the cheap
  # parts of PS Test-HelperStateFresh; pid/process/config_hash checks stay
  # behind in PS for the cases where we don't bail out here.
  local target_runtime_dir="${1:?missing target runtime dir}"
  local target_home state_env runtime_dir_win
  local ready="" state_runtime_dir="" key value
  local state_mtime now_s age_s newer_runtime

  [[ "${WEZTERM_SYNC_FORCE_HELPER_ENSURE:-0}" == "1" ]] && return 1

  target_home="$(dirname "$target_runtime_dir")"
  state_env="$target_home/AppData/Local/wezterm-runtime/state/helper/state.env"
  [[ -f "$state_env" ]] || return 1

  # state.env is written by PowerShell with CRLF line endings; strip \r
  # off each value so string comparisons against "1" / runtime_dir work.
  while IFS='=' read -r key value; do
    value="${value%$'\r'}"
    case "$key" in
      ready) ready="$value" ;;
      runtime_dir) state_runtime_dir="$value" ;;
    esac
  done < "$state_env"

  [[ "$ready" == "1" ]] || return 1

  # Use state.env's filesystem mtime instead of the heartbeat_at_ms field:
  # both are updated together when the helper writes state, but the FS
  # mtime is consistent with our `find -newer` check below and avoids the
  # ~250ms WSL/Windows clock skew that breaks naive epoch-ms comparisons.
  state_mtime="$(stat -c '%Y' "$state_env" 2>/dev/null || echo 0)"
  [[ "$state_mtime" -gt 0 ]] || return 1
  now_s="$(date '+%s')"
  age_s=$((now_s - state_mtime))
  # Tolerate a few seconds of clock skew either way; 10s window is well
  # above the helper's ~250ms heartbeat cadence.
  (( age_s > -5 && age_s < 10 )) || return 1

  if [[ -n "$state_runtime_dir" ]] && command -v wslpath >/dev/null 2>&1; then
    runtime_dir_win="$(wslpath -w "$target_runtime_dir" 2>/dev/null || true)"
    [[ -z "$runtime_dir_win" || "$state_runtime_dir" == "$runtime_dir_win" ]] || return 1
  fi

  # state.env is touched every heartbeat (~250ms); anything newer than it
  # under the runtime dir is a change the helper has not yet observed, so
  # we must let PS run and possibly push fresh config. Exclude metadata
  # files we rewrite every sync (they don't affect helper config).
  newer_runtime="$(find "$target_runtime_dir" -type f -newer "$state_env" \
    -not -name 'repo-root.txt' \
    -not -name 'repo-main-root.txt' \
    -not -name 'repo-worktree-task.env' \
    -print -quit 2>/dev/null)"
  [[ -z "$newer_runtime" ]] || return 1

  return 0
}

ensure_windows_helper_running() {
  local target_runtime_dir="${1:?missing target runtime dir}"
  local ensure_script="$target_runtime_dir/scripts/ensure-windows-runtime-helper.ps1"
  local ensure_script_win="" target_home="" target_home_win=""
  local state_path_win="" diagnostics_file_win="" ensure_output=""

  [[ "$target_runtime_dir" =~ ^/mnt/[A-Za-z]/Users/ ]] || return 0
  command -v powershell.exe >/dev/null 2>&1 || return 0
  command -v wslpath >/dev/null 2>&1 || return 0
  [[ -f "$ensure_script" ]] || return 0

  if helper_ensure_skip_if_running "$target_runtime_dir"; then
    sync_trace "step=helper-ensure status=skipped reason=heartbeat-fresh target_runtime_dir=$target_runtime_dir"
    runtime_log_info sync "skipped windows helper ensure (heartbeat fresh)" \
      "target_runtime_dir=$target_runtime_dir"
    return 0
  fi

  ensure_script_win="$(wslpath -w "$ensure_script" 2>/dev/null || true)"
  target_home="$(dirname "$target_runtime_dir")"
  target_home_win="$(wslpath -w "$target_home" 2>/dev/null || true)"
  [[ -n "$ensure_script_win" && -n "$target_home_win" ]] || return 0

  state_path_win="${target_home_win}\\AppData\\Local\\wezterm-runtime\\state\\helper\\state.env"
  diagnostics_file_win="${target_home_win}\\AppData\\Local\\wezterm-runtime\\logs\\helper.log"

  sync_trace "step=helper-ensure status=starting target_runtime_dir=$target_runtime_dir ensure_script_win=$ensure_script_win"
  if ! ensure_output="$(
    windows_run_powershell_script_utf8 "$ensure_script_win" \
      -StatePath "$state_path_win" \
      -HeartbeatIntervalMs 250 \
      -HeartbeatTimeoutSeconds 5 \
      -DiagnosticsEnabled 1 \
      -DiagnosticsCategoryEnabled 1 \
      -DiagnosticsLevel info \
      -DiagnosticsFile "$diagnostics_file_win" \
      -DiagnosticsMaxBytes 5242880 \
      -DiagnosticsMaxFiles 5 2>&1 | tr -d '\r'
  )"; then
    [[ -n "$ensure_output" ]] && printf '%s\n' "$ensure_output" >&2
    sync_trace "step=helper-ensure status=failed target_runtime_dir=$target_runtime_dir"
    runtime_log_warn sync "failed to ensure windows helper running after install" \
      "target_runtime_dir=$target_runtime_dir"
    return 0
  fi

  sync_trace "step=helper-ensure status=completed target_runtime_dir=$target_runtime_dir"
  runtime_log_info sync "ensured windows helper running after install" \
    "target_runtime_dir=$target_runtime_dir"
  return 0
}
