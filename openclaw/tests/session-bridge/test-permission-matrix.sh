#!/usr/bin/env bash
# P1 permission matrix: unknown cmds fail; poke dry-run ok; host-send not present.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SB="$ROOT/scripts/session-bridge.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export OPENCLAW_HOME="$TMP"
export SB_PANIC_PATH="$TMP/state/session-bridge.panic"
mkdir -p "$TMP/state" "$TMP/logs"
printf '%s\n' '{"aliases":{"dex":"agent:main:feishu:direct:ou_test"}}' >"$TMP/session-bridge.json"
export SB_CONFIG="$TMP/session-bridge.json"

# host-send-keys without lease must fail (P2 gate)
set +e
out_hsk="$("$SB" --json host-send-keys --target x:0.0 --text hi --dry-run 2>&1)"
ec=$?
set -e
if [[ $ec -eq 0 ]]; then
  echo "FAIL: host-send-keys without lease/allowlist must fail" >&2
  echo "$out_hsk" >&2
  exit 1
fi

out="$("$SB" --json poke --id dex -m 'hi' --dry-run)"
echo "$out" | jq -e '.ok == true and .dry_run == true and .identity == "agent-poke"' >/dev/null

out2="$("$SB" --json panic status)"
echo "$out2" | jq -e '.panic == false' >/dev/null

echo "PASS: permission matrix (P1/P2 surface)"
