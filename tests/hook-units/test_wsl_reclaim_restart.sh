#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/dev/wsl-reclaim-restart.sh"
TEST_ROOT="$(mktemp -d /tmp/wezdeck-wsl-reclaim.XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/windows/state/agent-attention"
printf '#!/usr/bin/env bash\nprintf "WindowsUser\\n"\n' > "$TEST_ROOT/bin/powershell.exe"
chmod +x "$TEST_ROOT/bin/powershell.exe"
export PATH="$TEST_ROOT/bin:$PATH"
export WINDOWS_RUNTIME_STATE_WSL="$TEST_ROOT/windows"
export WINDOWS_RUNTIME_STATE_WIN='C:\Test\wezterm-runtime'
export WINDOWS_LOCALAPPDATA_WSL="$TEST_ROOT/windows"
export WINDOWS_USERPROFILE_WSL="$TEST_ROOT/windows"
attention="$TEST_ROOT/windows/state/agent-attention/attention.json"
printf '%s\n' '{"entries":{"active":{"status":"running","tmux_session":"work","tmux_pane":"%1"}}}' > "$attention"

set +e
output="$(bash "$SCRIPT" --dry-run 2>&1)"
rc=$?
set -e
[[ "$rc" == 20 && "$output" == *'refusing to stop WSL'* ]] || {
  printf 'active-session gate failed: rc=%s\n%s\n' "$rc" "$output" >&2
  exit 1
}
set +e
output="$(bash "$SCRIPT" 2>&1)"
rc=$?
set -e
[[ "$rc" == 20 && "$output" == *'refusing to stop WSL'* ]]
jq -e '.phase == "blocked" and .stage == "preflight" and .active_attention == 1' \
  "$TEST_ROOT/windows/state/disk-reclaim/status.json" >/dev/null
[[ "$(bash "$SCRIPT" --status | jq -r '.phase')" == blocked ]]
output="$(bash "$SCRIPT" --dry-run --force-stop)"
[[ "$output" == *'dry-run: no files deleted and WSL not stopped'* ]]

printf '%s\n' '{"entries":{}}' > "$attention"
printf '#!/usr/bin/env bash\nexit 1\n' > "$TEST_ROOT/bin/systemctl"
chmod +x "$TEST_ROOT/bin/systemctl"
set +e
output="$(bash "$SCRIPT" 2>&1)"
rc=$?
set -e
[[ "$rc" == 1 && "$output" == *'distro=Ubuntu-24.04'* ]]
jq -e '.phase == "failed" and .stage == "service_preflight"
  and .error == "wezdeck-tmux-restore.service is not enabled"' \
  "$TEST_ROOT/windows/state/disk-reclaim/status.json" >/dev/null

printf '%s\n' '{"phase":"compacting"}' > "$TEST_ROOT/windows/state/disk-reclaim-status.json"
mkdir -p "$TEST_ROOT/windows/state/disk-reclaim"
mv "$TEST_ROOT/windows/state/disk-reclaim-status.json" "$TEST_ROOT/windows/state/disk-reclaim/status.json"
set +e
output="$(bash "$SCRIPT" --dry-run --force-stop 2>&1)"
rc=$?
set -e
[[ "$rc" == 22 && "$output" == *'earlier reclaim job is still in progress'* ]] || {
  printf 'concurrent-job gate failed: rc=%s\n%s\n' "$rc" "$output" >&2
  exit 1
}
printf '%s\n' '{"phase":"queued","task_id":"aaaaaaaaaaaaaaaa"}' > "$TEST_ROOT/windows/state/disk-reclaim/status.json"
set +e
output="$(bash "$SCRIPT" --dry-run --force-stop --task-id bbbbbbbbbbbbbbbb --target-device test-browser 2>&1)"
rc=$?
set -e
[[ "$rc" == 22 && "$output" == *'earlier reclaim job is still in progress'* ]]
output="$(bash "$SCRIPT" --dry-run --force-stop --task-id aaaaaaaaaaaaaaaa --target-device test-browser)"
[[ "$output" == *'dry-run: no files deleted and WSL not stopped'* ]]
printf 'PASS wsl-reclaim-restart\n'
