#!/usr/bin/env bash
# Prepare WSL disk reclaim, then launch the Windows-owned compact/restart job.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MAIN_ROOT="$(dirname "$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)")"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/runtime/windows-shell-lib.sh"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/runtime/windows-runtime-paths-lib.sh"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/runtime/wsl-runtime-paths-lib.sh"

DISTRO="${WEZTERM_WSL_DISTRO:-Ubuntu-24.04}"
VHDX="${WEZTERM_WSL_VHDX_WIN:-D:\\WSL\\Ubuntu-24.04\\ext4.vhdx}"
KEEPALIVE="${WEZTERM_WSL_KEEPALIVE_TASK:-WezDeck WSL Keepalive}"
WSL_USER="${WEZTERM_WSL_USER:-$(id -un)}"
WEB_ORIGIN="${WEZDECK_REMOTE_ORIGIN:-https://wezdeck.yuns.love}"
FORCE_STOP=0
DRY_RUN=0
SMOKE=0
SHOW_STATUS=0
NONINTERACTIVE=0
TASK_ID=""
TARGET_DEVICE=""
usage() {
  printf 'usage: %s [--status|--dry-run|--smoke] [--force-stop] [--noninteractive] [--distro NAME] [--vhdx WIN_PATH] [--keepalive-task NAME] [--wsl-user NAME] [--web-origin HTTPS_URL]\n' "$0"
}
while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --smoke) SMOKE=1 ;;
    --status) SHOW_STATUS=1 ;;
    --force-stop) FORCE_STOP=1 ;;
    --noninteractive) NONINTERACTIVE=1 ;;
    --task-id) TASK_ID="${2:-}"; shift ;;
    --target-device) TARGET_DEVICE="${2:-}"; shift ;;
    --distro) DISTRO="${2:-}"; shift ;;
    --vhdx) VHDX="${2:-}"; shift ;;
    --keepalive-task) KEEPALIVE="${2:-}"; shift ;;
    --wsl-user) WSL_USER="${2:-}"; shift ;;
    --web-origin) WEB_ORIGIN="${2:-}"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done
(( DRY_RUN + SMOKE + SHOW_STATUS <= 1 )) || { printf 'choose one of --status, --dry-run or --smoke\n' >&2; exit 2; }

[[ "$DISTRO" =~ ^[A-Za-z0-9._-]+$ && "$WSL_USER" =~ ^[A-Za-z0-9._-]+$ ]] || {
  printf 'invalid distro or WSL user\n' >&2; exit 2;
}
[[ -z "$TASK_ID" || "$TASK_ID" =~ ^[0-9a-f]{16}$ ]] || { printf 'invalid task id\n' >&2; exit 2; }
[[ -z "$TARGET_DEVICE" || "$TARGET_DEVICE" =~ ^[A-Za-z0-9_.:-]{1,128}$ ]] || { printf 'invalid target device\n' >&2; exit 2; }
[[ "$VHDX" =~ ^[A-Za-z]:\\.+\.vhdx$ ]] || { printf 'invalid Windows VHDX path\n' >&2; exit 2; }
[[ "$WEB_ORIGIN" == https://* ]] || { printf 'web origin must use HTTPS\n' >&2; exit 2; }
windows_runtime_detect_paths || { printf 'Windows runtime paths unavailable\n' >&2; exit 1; }
[[ -f "$WINDOWS_RUNTIME_STATE_WSL/state/agent-attention/attention.json" ]] || {
  printf 'live attention state unavailable\n' >&2; exit 1;
}
ATTENTION="$WINDOWS_RUNTIME_STATE_WSL/state/agent-attention/attention.json"
STATE_WIN="$WINDOWS_RUNTIME_STATE_WIN\\state\\disk-reclaim"
STATE_WSL="$WINDOWS_RUNTIME_STATE_WSL/state/disk-reclaim"
WORKER_WIN="$STATE_WIN\\worker.ps1"
STATUS_WIN="$STATE_WIN\\status.json"
STATUS_WSL="$STATE_WSL/status.json"
SIGNAL_WIN="$STATE_WIN\\start.signal"
SIGNAL_WSL="$STATE_WSL/start.signal"
if (( SMOKE )); then
  STATUS_WIN="$STATE_WIN\\smoke-status.json"
  STATUS_WSL="$STATE_WSL/smoke-status.json"
  SIGNAL_WIN="$STATE_WIN\\smoke-start.signal"
  SIGNAL_WSL="$STATE_WSL/smoke-start.signal"
fi
if (( SHOW_STATUS )); then
  [[ -f "$STATUS_WSL" ]] || { printf 'no reclaim status at %s\n' "$STATUS_WIN" >&2; exit 1; }
  jq '{task_id,target_device,phase,stage,failed_stage,error,measure_error,started_at,updated_at,duration_seconds,distro,vhdx,windows_cwd,active_attention,snapshot_windows,
    before_free_bytes,after_free_bytes,reclaimed_bytes,before_vhdx_bytes,
    after_vhdx_bytes,vhdx_reduced_bytes,compact_exit,verify_exit,
    compact_output,verify_output,keepalive_state,restart_attempt_exit,restart_error}' "$STATUS_WSL"
  exit 0
fi
if [[ -f "$STATUS_WSL" ]] && jq -e '.phase | IN("queued","preparing","preflight","trimming","compacting","restarting","verifying")' "$STATUS_WSL" >/dev/null 2>&1; then
  queued_for_self=0
  if [[ -n "$TASK_ID" ]] && jq -e --arg id "$TASK_ID" '.phase == "queued" and .task_id == $id' "$STATUS_WSL" >/dev/null 2>&1; then
    queued_for_self=1
  fi
  if (( ! queued_for_self )); then
    printf 'an earlier reclaim job is still in progress; inspect %s\n' "$STATUS_WIN" >&2
    exit 22
  fi
fi

stage=preflight
active_count=0
started_at="$(date -Is)"
if (( ! DRY_RUN )); then
  mkdir -p "$STATE_WSL"
  if [[ -f "$STATUS_WSL" ]]; then
    mv "$STATUS_WSL" "$STATE_WSL/status.$(date +%Y%m%dT%H%M%S).json"
  fi
fi
write_prepare_status() {
  local phase="$1" message="${2:-}"
  (( DRY_RUN == 0 )) || return 0
  local temp="${STATUS_WSL}.tmp.$$"
  jq -n --arg phase "$phase" --arg stage "$stage" --arg error "$message" \
    --arg task "$TASK_ID" --arg device "$TARGET_DEVICE" \
    --arg distro "$DISTRO" --arg vhdx "$VHDX" \
    --argjson active "$active_count" --arg started "$started_at" --arg time "$(date -Is)" '
    {task_id:$task,target_device:$device,phase:$phase,stage:$stage,started_at:$started,updated_at:$time,distro:$distro,vhdx:$vhdx,
      active_attention:$active} | if $error != "" then .error=$error else . end
  ' > "$temp"
  mv -f "$temp" "$STATUS_WSL"
}
if (( ! DRY_RUN )); then
  write_prepare_status preparing
  trap 'rc=$?; trap - ERR; write_prepare_status failed "exit code $rc"; exit "$rc"' ERR
fi

# Exact D-drive mapping is checked in Windows before any WSL stop.
printf 'distro=%s\nvhdx=%s\nwindows_user=%s\nwsl_user=%s\nkeepalive=%s\nweb=%s\nstatus=%s\n' \
  "$DISTRO" "$VHDX" "$(windows_run_powershell_command_utf8 '[Security.Principal.WindowsIdentity]::GetCurrent().Name' | tr -d '\r')" \
  "$WSL_USER" "$KEEPALIVE" "$WEB_ORIGIN" "$STATUS_WIN"

active="$(jq -r '.entries // {} | to_entries[] | select(.value.status == "running" or .value.status == "waiting") | [.key,.value.status,.value.tmux_session,.value.tmux_pane] | @tsv' "$ATTENTION")"
if [[ -n "$active" ]]; then
  active_count="$(wc -l <<< "$active" | tr -d ' ')"
fi
if [[ -n "$active" ]]; then
  printf 'active agent turns:\n%s\n' "$active"
  if (( ! FORCE_STOP && ! SMOKE )); then
    write_prepare_status blocked 'active agent turns; --force-stop required'
    printf 'refusing to stop WSL; rerun with --force-stop after reviewing the active turns\n' >&2
    exit 20
  fi
fi

if (( DRY_RUN )); then
  printf 'dry-run: no files deleted and WSL not stopped\n'
  exit 0
fi

stage=service_preflight
if ! systemctl --user is-enabled --quiet wezdeck-tmux-restore.service; then
  write_prepare_status failed 'wezdeck-tmux-restore.service is not enabled'
  exit 1
fi
if ! systemctl --user is-enabled --quiet wezdeck-tmux-save.timer; then
  write_prepare_status failed 'wezdeck-tmux-save.timer is not enabled'
  exit 1
fi
[[ -f "$REPO_ROOT/scripts/dev/wsl-reclaim-worker.ps1" ]] || exit 1
[[ -f "$REPO_ROOT/scripts/dev/wsl-reclaim-verify.sh" ]] || exit 1
VERIFY_SCRIPT="$MAIN_ROOT/scripts/dev/wsl-reclaim-verify.sh"
if (( SMOKE )); then
  VERIFY_SCRIPT="$REPO_ROOT/scripts/dev/wsl-reclaim-verify.sh"
fi
[[ -f "$VERIFY_SCRIPT" ]] || {
  printf 'main checkout lacks the post-restart verifier; deliver this change first\n' >&2
  exit 1
}
stage=windows_preflight
mkdir -p "$STATE_WSL"
cp "$REPO_ROOT/scripts/dev/wsl-reclaim-worker.ps1" "$STATE_WSL/worker.ps1"
worker_path="$(windows_powershell_quote "$WORKER_WIN")"
status_path="$(windows_powershell_quote "$STATUS_WIN")"
distro_arg="$(windows_powershell_quote "$DISTRO")"
vhdx_arg="$(windows_powershell_quote "$VHDX")"
keepalive_arg="$(windows_powershell_quote "$KEEPALIVE")"
user_arg="$(windows_powershell_quote "$WSL_USER")"
verify_arg="$(windows_powershell_quote "$VERIFY_SCRIPT")"
origin_arg="$(windows_powershell_quote "$WEB_ORIGIN")"
signal_arg="$(windows_powershell_quote "$SIGNAL_WIN")"
worker_call="& $worker_path -Distro $distro_arg -Vhdx $vhdx_arg -KeepaliveTask $keepalive_arg -WslUser $user_arg -VerifyScript $verify_arg -WebOrigin $origin_arg -StatusPath $status_path -StartSignalPath $signal_arg"
if [[ -n "$TASK_ID" ]]; then
  worker_call+=" -TaskId $(windows_powershell_quote "$TASK_ID") -TargetDevice $(windows_powershell_quote "$TARGET_DEVICE")"
fi
if (( NONINTERACTIVE )); then
  worker_call+=' -TrimGuest'
fi
if ! preflight_output="$(windows_run_powershell_command_utf8 "$worker_call -PreflightOnly" 2>&1)"; then
  write_prepare_status failed "Windows preflight failed: ${preflight_output:0:500}"
  printf '%s\n' "$preflight_output" >&2
  exit 1
fi
printf '%s\n' "$preflight_output"

stage=cache_cleanup
if (( ! SMOKE )) && [[ "${WEZTERM_WSL_RECLAIM_SKIP_GO_CACHE:-0}" != 1 ]] && command -v go >/dev/null 2>&1; then
  go clean -cache
fi
stage=tmux_snapshot
"$REPO_ROOT/scripts/runtime/tmux-session-persist.sh" save
stage=fstrim
if (( ! SMOKE && ! NONINTERACTIVE )); then
  if ! trim_output="$(sudo fstrim -av 2>&1)"; then
    write_prepare_status failed "fstrim failed: ${trim_output:0:500}"
    printf '%s\n' "$trim_output" >&2
    exit 1
  fi
  printf '%s\n' "$trim_output"
fi

rm -f "$SIGNAL_WSL"
stage=worker_launch
snapshot_windows="$(jq '[.sessions[].windows[]] | length' "$WSL_RUNTIME_STATE_DIR/tmux-sessions.json")"
worker_call+=" -ActiveAttention $active_count -SnapshotWindows $snapshot_windows"

# The child is a Windows process and writes only to NTFS after WSL stops.
# Encode the entire invocation: Start-Process flattens argument arrays and
# would otherwise split paths or task names containing spaces.
worker_encoded="$(printf '%s' "$worker_call" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\r\n')"
if (( SMOKE )); then
  worker_encoded="$(printf '%s -Simulate' "$worker_call" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\r\n')"
fi
launcher="\$p = Start-Process -FilePath (Join-Path \$env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -ArgumentList '-NoProfile -NonInteractive -EncodedCommand $worker_encoded' -WindowStyle Hidden -PassThru; Write-Output ('worker_pid=' + \$p.Id)"
windows_run_powershell_command_utf8 "$launcher"
stage=worker_receipt
for _ in {1..20}; do
  if [[ -s "$STATUS_WSL" ]] && jq -e '.phase == "preflight" or .phase == "compacting" or .phase == "failed"' "$STATUS_WSL" >/dev/null 2>&1; then
    phase="$(jq -r .phase "$STATUS_WSL")"
    [[ "$phase" != failed ]] || { jq -r .error "$STATUS_WSL" >&2; exit 1; }
    printf 'start\n' > "$SIGNAL_WSL"
    trap - ERR
    if (( ! SMOKE )); then
      printf 'queued; status will be written to %s after WSL restarts\n' "$STATUS_WIN"
      exit 0
    fi
    for _ in {1..120}; do
      phase="$(jq -r .phase "$STATUS_WSL")"
      if [[ "$phase" == complete ]]; then
        jq '{phase,active_attention,snapshot_windows,before_free_bytes,after_free_bytes,
          reclaimed_bytes,vhdx_reduced_bytes,verify_output,verify_exit}' "$STATUS_WSL"
        exit 0
      fi
      if [[ "$phase" == failed ]]; then
        jq '{phase,failed_stage,error,verify_exit,verify_output,before_free_bytes,
          after_free_bytes,reclaimed_bytes,vhdx_reduced_bytes}' "$STATUS_WSL" >&2
        exit 1
      fi
      sleep 0.25
    done
    printf 'smoke worker did not finish; inspect %s\n' "$STATUS_WIN" >&2
    exit 1
  fi
  sleep 0.25
done
printf 'Windows worker did not publish a startup receipt; inspect %s\n' "$STATUS_WIN" >&2
exit 1
