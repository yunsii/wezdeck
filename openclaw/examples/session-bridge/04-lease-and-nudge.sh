#!/usr/bin/env bash
# Cookbook: mint a short lease then dry-run host-send-keys (no real keypress).
# Override target: SB_HOST_TARGET=sess:0.0 ./04-lease-and-nudge.sh
#
# Uses a temporary config that allowlists the target session name so the
# recipe is self-contained. Production: put globs in ~/.openclaw/session-bridge.json.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SB="$ROOT/scripts/session-bridge.sh"
TARGET="${SB_HOST_TARGET:-demo:0.0}"
SESS="${TARGET%%:*}"
SESS="${SESS#tmux:}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export OPENCLAW_HOME="$TMP"
export SB_CONFIG="$TMP/session-bridge.json"
export SB_PANIC_PATH="$TMP/state/session-bridge.panic"
mkdir -p "$TMP/state" "$TMP/logs"
cat >"$SB_CONFIG" <<JSON
{
  "host_allowlist": { "send_keys_panes": ["$SESS", "wd:*"] },
  "defaults": { "lease_ttl_sec": 120 }
}
JSON

echo "## mint lease (target=$TARGET)"
mint="$("$SB" --json lease mint --target "$TARGET" --ttl 120 --max-sends 3 --note 'cookbook')"
echo "$mint" | jq '{ok, id:.lease.id, target:.lease.target, expires:.lease.expires_at}'
LID="$(echo "$mint" | jq -r '.lease.id')"

echo "## dry-run nudge"
"$SB" --json host-send-keys --target "$TARGET" --text '请继续' --enter --dry-run --lease "$LID" \
  | jq '{ok, dry_run, action, lease_id, identity}'

echo "## revoke"
"$SB" --json lease revoke "$LID" | jq '{ok, revoked}'
