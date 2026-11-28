#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
export XDG_STATE_HOME="$tmp/state"
export PATH="$tmp/bin:$PATH"

cat >"$tmp/bin/systemd-run" <<'STUB'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    --setenv=WEZDECK_VERIFY_ACK=*) ack="${arg#--setenv=WEZDECK_VERIFY_ACK=}" ;;
  esac
done
case "$LAUNCH_MODE" in
  started) printf '123\n' >"$ack" ;;
  rejected) exit 1 ;;
  exited) exit 0 ;;
esac
STUB
cat >"$tmp/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
[[ "${SYSTEMCTL_UNAVAILABLE:-}" == 1 ]] && exit 1
[[ "$*" == *' show '* ]] && { echo inactive; exit 0; }
exit 0
STUB
chmod +x "$tmp/bin/systemd-run" "$tmp/bin/systemctl"

target=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
LAUNCH_MODE=started bash "$repo/scripts/dev/release-verify-launch.sh" '' "$target" >"$tmp/started.out"
[[ "$(cat "$tmp/started.out")" == *'verify launch: started'* ]]
state_file="$XDG_STATE_HOME/wezdeck/release/state.json"
[[ "$(jq -r '.verifying_sha' "$state_file")" == "$target" ]]
jq '.verify_started_at="2020-01-01T00:00:00+0000"' "$state_file" >"$tmp/old-state.json"
mv "$tmp/old-state.json" "$state_file"
STATE="$XDG_STATE_HOME/wezdeck"
source "$repo/scripts/dev/release-queue-lib.sh"
SYSTEMCTL_UNAVAILABLE=1 release_reconcile_verify
[[ "$(jq -r '.verifying_sha' "$state_file")" == "$target" ]]
release_reconcile_verify
[[ "$(jq -r '.verified_sha + ":" + .verify_status' "$state_file")" == "$target:FAIL" ]]

target=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
if LAUNCH_MODE=rejected bash "$repo/scripts/dev/release-verify-launch.sh" '' "$target" >"$tmp/rejected.out" 2>&1; then
  echo 'expected rejected launch to fail' >&2
  exit 1
fi
[[ "$(jq -r '.verified_sha + ":" + .verify_status' "$state_file")" == "$target:FAIL" ]]

target=cccccccccccccccccccccccccccccccccccccccc
if LAUNCH_MODE=exited bash "$repo/scripts/dev/release-verify-launch.sh" '' "$target" >"$tmp/exited.out" 2>&1; then
  echo 'expected missing startup acknowledgement to fail' >&2
  exit 1
fi
[[ "$(jq -r '.verified_sha + ":" + .verify_status' "$state_file")" == "$target:FAIL" ]]

cat >"$tmp/bin/git" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod +x "$tmp/bin/git"
target=dddddddddddddddddddddddddddddddddddddddd
if WEZDECK_VERIFY_LOG="$tmp/worker-fail.log" \
  WEZDECK_VERIFY_ACK="$tmp/worker.started" \
  bash "$repo/scripts/dev/release-async-verify.sh" '' "$target"; then
  echo 'expected worker command failure' >&2
  exit 1
fi
[[ -s "$tmp/worker.started" ]]
[[ "$(jq -r '.verified_sha + ":" + .verify_status' "$state_file")" == "$target:FAIL" ]]

exec 8>>"$XDG_STATE_HOME/wezdeck/release/verify.lock"
flock -x 8
target=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
if WEZDECK_VERIFY_LOCK_WAIT=0.1 WEZDECK_VERIFY_LOG="$tmp/worker-lock.log" \
  bash "$repo/scripts/dev/release-async-verify.sh" '' "$target" 8>&-; then
  echo 'expected occupied verify lock to fail' >&2
  exit 1
fi
flock -u 8
[[ "$(jq -r '.verified_sha + ":" + .verify_status' "$state_file")" == "$target:FAIL" ]]
[[ "$(cat "$tmp/worker-lock.log")" == *'timed out waiting'* ]]
echo 'verify launch: ok'
