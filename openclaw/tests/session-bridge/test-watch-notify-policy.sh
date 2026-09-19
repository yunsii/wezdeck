#!/usr/bin/env bash
# Per-event notify identity + TTL renew defaults.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export OPENCLAW_HOME="$TMP"
export SB_CONFIG="$TMP/session-bridge.json"
mkdir -p "$TMP/state" "$TMP/logs"

cat >"$SB_CONFIG" <<'EOF'
{
  "defaults": {
    "watch": {
      "ttl_sec": 5400,
      "ttl_renew_on_activity": true,
      "notify_by_event": {
        "need_human": "owner",
        "turn_idle": "none",
        "take": "none",
        "ended": "none"
      }
    }
  },
  "feishu_targets": {
    "dex_user_id": "ou_test_owner"
  }
}
EOF

# shellcheck disable=SC1091
source "$ROOT/scripts/session-bridge/lib.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/session-bridge/host-snapshot.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/session-bridge/bot-send.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/session-bridge/say-as-me.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/session-bridge/host-write.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/session-bridge/watch.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }

[[ "$(sb_watch_notify_identity_for_event need_human)" == "owner" ]] || fail need_human-owner
[[ "$(sb_watch_notify_identity_for_event turn_idle)" == "none" ]] || fail turn_idle-none
[[ "$(sb_watch_notify_identity_for_event take)" == "none" ]] || fail take-none
[[ "$(sb_watch_notify_identity_for_event ended)" == "none" ]] || fail ended-none
[[ "$(sb_watch_ttl_renew_on_activity)" == "1" ]] || fail renew-on
[[ "$(sb_watch_owner_feishu_target)" == "ou_test_owner" ]] || fail owner-target

# Blanket notify_identity overrides per-event
cat >"$SB_CONFIG" <<'EOF'
{
  "defaults": {
    "watch": {
      "notify_identity": "user+poke",
      "notify_by_event": { "need_human": "owner" }
    }
  }
}
EOF
[[ "$(sb_watch_notify_identity_for_event need_human)" == "user+poke" ]] || fail blanket

# Explicit renew off
cat >"$SB_CONFIG" <<'EOF'
{ "defaults": { "watch": { "ttl_renew_on_activity": false } } }
EOF
[[ "$(sb_watch_ttl_renew_on_activity)" == "0" ]] || fail renew-off

# none identity succeeds without send
if ! sb_watch_notify dex "hello" 0 none "" text; then
  fail none-should-ok
fi

echo "PASS: watch notify policy"
