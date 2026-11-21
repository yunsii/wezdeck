#!/usr/bin/env bash
# Plugin test entry. Needs WEZDECK_REPO (WezTerm mock + badge SDK live in core).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${WEZDECK_REPO:?set WEZDECK_REPO to the WezDeck checkout}"
lua5.4 tests/test_badge.lua
bash -n bin/install.sh bin/oppo-remote-quality.sh
python3 -m py_compile bin/oppo-remote-quality.py
# Validate plugin.json with the core compiler (contrib source, enabled).
out="$(mktemp -d)"; cfg="$(mktemp)"
trap 'rm -rf "$out" "$cfg"' EXIT
printf '{"enabled":["oppo-remote"]}' >"$cfg"
WEZDECK_PLUGIN_DIR=/nonexistent python3 "$WEZDECK_REPO/scripts/runtime/plugins_compile.py" --repo "$WEZDECK_REPO" \
  --local-config "$cfg" --out-dir "$out" --quiet
grep -q '"plugins/.external/oppo-remote"' "$out/registry.generated.lua"
echo "oppo-remote plugin tests passed"
