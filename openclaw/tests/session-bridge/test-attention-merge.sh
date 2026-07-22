#!/usr/bin/env bash
# attention index merges into host cards when present
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/session-bridge/lib.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/session-bridge/host-snapshot.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export SB_ATTENTION_PATH="$TMP/attention.json"
cat >"$SB_ATTENTION_PATH" <<'JSON'
{
  "version": 1,
  "entries": {
    "s1": {
      "session_id": "s1",
      "tmux_session": "demo-sess",
      "tmux_pane": "%1",
      "status": "waiting",
      "reason": "permission"
    }
  }
}
JSON

idx="$(sb_attention_index_json)"
# keyed by pane_id (%1), not session name — one pane's status must not smear
# across every pane in the session
echo "$idx" | jq -e '."%1".status == "waiting"' >/dev/null
echo "$idx" | jq -e 'has("demo-sess") | not' >/dev/null
echo "PASS: attention index (per-pane key)"
