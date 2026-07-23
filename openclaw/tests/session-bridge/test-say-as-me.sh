#!/usr/bin/env bash
# say-as-me dry-run + panic gate
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SB="$ROOT/scripts/session-bridge.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export OPENCLAW_HOME="$TMP"
export SB_CONFIG="$TMP/session-bridge.json"
export SB_PANIC_PATH="$TMP/state/session-bridge.panic"
mkdir -p "$TMP/state" "$TMP/logs"
# fake lark-cli on PATH
mkdir -p "$TMP/bin"
cat >"$TMP/bin/lark-cli" <<'EOF'
#!/bin/sh
echo '{"ok":true,"fake":true}'
EOF
chmod +x "$TMP/bin/lark-cli"
export PATH="$TMP/bin:$PATH"

cat >"$SB_CONFIG" <<'JSON'
{
  "aliases": {"dex": "agent:main:feishu:direct:ou_test"},
  "feishu_targets": {
    "dex_user_id": "ou_test_user",
    "dex_chat_id": "oc_test_dex_p2p",
    "dex_bot_open_id": "ou_test_bot"
  }
}
JSON

out="$("$SB" --json say-as-me --to dex -m 'hello')"
echo "$out" | jq -e '.ok == true and .dry_run == true and .identity == "user"' >/dev/null
echo "$out" | jq -e '.to == "oc_test_dex_p2p"' >/dev/null
# owner-only map must refuse (not "talk to Dex")
cat >"$SB_CONFIG" <<'JSON'
{
  "aliases": {"dex": "agent:main:feishu:direct:ou_test"},
  "feishu_targets": {"dex_user_id": "ou_test_user"}
}
JSON
set +e
bad="$("$SB" --json say-as-me --to dex -m 'hello' 2>&1)"
bad_ec=$?
set -e
[[ $bad_ec -ne 0 ]] || { echo "FAIL: owner-only should refuse: $bad"; exit 1; }
# restore full map for panic check
cat >"$SB_CONFIG" <<'JSON'
{
  "aliases": {"dex": "agent:main:feishu:direct:ou_test"},
  "feishu_targets": {
    "dex_user_id": "ou_test_user",
    "dex_chat_id": "oc_test_dex_p2p"
  }
}
JSON

"$SB" --json panic on >/dev/null
set +e
out2="$("$SB" --json say-as-me --to dex -m 'x' --confirm 2>&1)"
ec=$?
set -e
[[ $ec -eq 75 ]] || { echo "FAIL panic: $ec $out2"; exit 1; }
"$SB" --json panic off >/dev/null

echo "PASS: say-as-me dry-run + panic"
