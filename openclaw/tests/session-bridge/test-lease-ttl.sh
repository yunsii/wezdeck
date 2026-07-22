#!/usr/bin/env bash
# Lease mint/status/revoke + host-send-keys gate without real tmux write.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SB="$ROOT/scripts/session-bridge.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export OPENCLAW_HOME="$TMP"
export SB_CONFIG="$TMP/session-bridge.json"
export SB_PANIC_PATH="$TMP/state/session-bridge.panic"
mkdir -p "$TMP/state" "$TMP/logs"
cat >"$SB_CONFIG" <<'JSON'
{
  "aliases": {"dex": "agent:main:feishu:direct:ou_test"},
  "host_allowlist": {"send_keys_panes": ["wd:*", "demo"]},
  "defaults": {"lease_ttl_sec": 120, "capture_lines": 20}
}
JSON

# no lease → deny
set +e
out="$("$SB" --json host-send-keys --target demo:0.0 --text 'hi' --dry-run 2>&1)"
ec=$?
set -e
if [[ $ec -eq 0 ]]; then
  echo "FAIL: expected deny without lease" >&2
  echo "$out" >&2
  exit 1
fi
echo "$out" | jq -e '.ok == false' >/dev/null

# mint lease
mint="$("$SB" --json lease mint --target demo:0.0 --ttl 60 --max-sends 2)"
echo "$mint" | jq -e '.ok == true and .lease.id != null' >/dev/null
lid="$(echo "$mint" | jq -r '.lease.id')"

# dry-run send ok
send="$("$SB" --json host-send-keys --target demo:0.0 --text 'hi' --dry-run --lease "$lid")"
echo "$send" | jq -e '.ok == true and .dry_run == true and .lease_id == "'"$lid"'"' >/dev/null

# not on allowlist
set +e
out2="$("$SB" --json host-send-keys --target other:0.0 --text 'x' --dry-run 2>&1)"
ec2=$?
set -e
[[ $ec2 -ne 0 ]] || { echo "FAIL: allowlist"; exit 1; }

# revoke
"$SB" --json lease revoke "$lid" | jq -e '.ok == true' >/dev/null
set +e
out3="$("$SB" --json host-send-keys --target demo:0.0 --text 'hi' --dry-run 2>&1)"
ec3=$?
set -e
[[ $ec3 -ne 0 ]] || { echo "FAIL: revoked lease still works"; exit 1; }

# bot-send dry-run
bot="$("$SB" --json bot-send --to dex -m 'ping')"
echo "$bot" | jq -e '.ok == true and .dry_run == true and .identity == "bot"' >/dev/null

# panic blocks lease mint
"$SB" --json panic on >/dev/null
set +e
out4="$("$SB" --json lease mint --target demo:0.0 2>&1)"
ec4=$?
set -e
[[ $ec4 -eq 75 ]] || { echo "FAIL: panic should block lease mint ($ec4)"; echo "$out4"; exit 1; }
"$SB" --json panic off >/dev/null

echo "PASS: lease + host-send-keys gate + bot-send dry-run"
