#!/usr/bin/env bash
# Panic freezes poke write path (exit 75).
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
{"aliases":{"dex":"agent:main:feishu:direct:ou_test"},"defaults":{"panic_path":""}}
JSON
# force panic path via env
export SB_PANIC_PATH="$TMP/state/session-bridge.panic"

"$SB" --json panic on >/dev/null
set +e
out_dry="$("$SB" --json poke --id dex -m 'should fail' --dry-run 2>&1)"
ec_dry=$?
out_real="$("$SB" --json poke --id dex -m 'should fail' 2>&1)"
ec_real=$?
set -e
if [[ $ec_dry -ne 75 ]]; then
  echo "FAIL: dry-run poke under panic expected 75, got $ec_dry" >&2
  echo "$out_dry" >&2
  exit 1
fi
if [[ $ec_real -ne 75 ]]; then
  echo "FAIL: poke under panic expected 75, got $ec_real" >&2
  echo "$out_real" >&2
  exit 1
fi
"$SB" --json panic off >/dev/null
echo "PASS: panic blocks poke (exit 75)"
