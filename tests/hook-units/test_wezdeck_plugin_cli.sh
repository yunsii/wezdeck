#!/usr/bin/env bash
# wezdeck-plugin.sh CLI + machine (external) plugin end-to-end:
# list → disable → enable → run → doctor → Lua plugin_host renders its badge.
# Isolated: local config, registry output and external dir all live in a tmpdir.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export WEZDECK_PLUGIN_DIR="$tmp/ext" WEZDECK_PLUGIN_LOCAL_CONFIG="$tmp/local/plugins.json"
export WEZDECK_PLUGIN_OUT_DIR="$tmp/rt/plugins" WEZDECK_RUNTIME_STATE_DIR="$tmp/state"
cli() { python3 "$repo_root/scripts/runtime/wezdeck_plugin.py" --repo "$repo_root" "$@"; }

pass=0 fail=0
ok() { pass=$((pass + 1)); printf '  PASS  %s\n' "$1"; }
no() { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; }
expect() { if eval "$2"; then ok "$1"; else no "$1"; fi; }

mkdir -p "$tmp/ext/hello/lua" "$tmp/ext/hello/bin" "$tmp/state/state/hello"
cat >"$tmp/ext/hello/plugin.json" <<'J'
{ "id": "hello", "kind": "demo", "requires": { "host": [] },
  "badge": { "module": "lua/badge.lua", "order": 90,
             "config": { "word": "hi", "state_file": "${runtime_state_dir}/state/hello/status.json",
                         "heartbeat_timeout_ms": 60000 } },
  "cli": { "greet": "bin/greet.sh" } }
J
cat >"$tmp/ext/hello/lua/badge.lua" <<'L'
local badge = require 'wezdeck.badge'
local M = { cfg = {} }
function M.configure(c) M.cfg = c end
function M.render_status_segment(_)
  local st = badge.parse_json(badge.read_file(M.cfg.state_file) or '')
  return ' Hello·' .. M.cfg.word .. '·' .. tostring(st and st.n or '?') .. ' '
end
return M
L
printf '#!/bin/sh\necho "greet:$*"\n' >"$tmp/ext/hello/bin/greet.sh"; chmod +x "$tmp/ext/hello/bin/greet.sh"
printf '{"n":7,"heartbeat_at_ms":%s}\n' "$(date +%s%3N)" >"$tmp/state/state/hello/status.json"

out="$(cli list)"
expect "list shows the external plugin enabled" '[[ "$out" == *"hello"*"external"*"on"*"badge@90"*"cli:greet"* ]]'
expect "list shows built-ins" '[[ "$out" == *"disk-guard"* && "$out" == *"agent-grok"* ]]'

cli disable hello >/dev/null
expect "disable writes local config" 'grep -q "\"hello\"" "$tmp/local/plugins.json"'
expect "disabled plugin leaves the badge registry" '! grep -q "\"hello\"" "$tmp/rt/plugins/registry.generated.lua"'
expect "disabled external plugin is not shipped" '[[ ! -e "$tmp/rt/plugins/.external/hello" ]]'

cli enable hello >/dev/null
expect "enable removes it from disabled" '! grep -q "\"hello\"" "$tmp/local/plugins.json"'
expect "enabled plugin is back in the registry" 'grep -q "plugins/.external/hello" "$tmp/rt/plugins/registry.generated.lua"'
expect "external plugin copied for sync" '[[ -f "$tmp/rt/plugins/.external/hello/lua/badge.lua" ]]'

expect "run execs the declared cli" '[[ "$(cli run hello greet a b)" == "greet:a b" ]]'
expect "run rejects an undeclared cli" '! cli run hello nope 2>/dev/null'

doc="$(cli doctor hello)"
expect "doctor: fresh status, executable cli" '[[ "$doc" == ok*hello*"status fresh"* ]]'
printf '{"n":7,"heartbeat_at_ms":1}\n' >"$tmp/state/state/hello/status.json"
expect "doctor warns on stale status" '[[ "$(cli doctor hello)" == WARN*stale* ]]'
printf '{"n":7,"heartbeat_at_ms":%s}\n' "$(date +%s%3N)" >"$tmp/state/state/hello/status.json"

seg="$(cd "$repo_root" && lua5.4 -e "
package.path = './tests/lua-units/?.lua;' .. package.path
local mock = require 'wezterm_mock'
package.preload['wezterm'] = function() return mock end
local h = dofile('./wezterm-x/lua/plugin_host.lua').new {
  runtime_dir = '$tmp/rt', runtime_state_dir = '$tmp/state', runtime_mode = 'hybrid-wsl', path_sep = '/',
  sdk_path = './wezterm-x/lua/badge_common.lua', logger = { warn = function() end } }
for _, s in ipairs(h.render_segments({})) do if s:find('Hello', 1, true) then io.write(s) end end
")"
expect "plugin_host renders the external badge from its status file" '[[ "$seg" == " Hello·hi·7 " ]]'

expect "list shows contrib oppo-remote off by default" '[[ "$(cli list)" == *"oppo-remote"*"contrib"*"off"* ]]'
cli enable oppo-remote >/dev/null
expect "enable contrib writes it to local enabled" 'python3 -c "import json,sys; sys.exit(0 if \"oppo-remote\" in json.load(open(\"$tmp/local/plugins.json\")).get(\"enabled\", []) else 1)"'
expect "enabled contrib plugin is shipped" '[[ -f "$tmp/rt/plugins/.external/oppo-remote/lua/badge.lua" ]]'
cli disable oppo-remote >/dev/null
expect "disable contrib leaves the registry" '! grep -q "oppo-remote" "$tmp/rt/plugins/registry.generated.lua"'

expect "unknown id is rejected" '! cli disable no-such-plugin 2>/dev/null'
mkdir -p "$tmp/ext/broken"; printf '{"id":"broken","requires":{"host":[]},"badge":{"module":"lua/missing.lua","order":91}}' >"$tmp/ext/broken/plugin.json"
expect "invalid external plugin fails the compile" '! cli enable hello 2>/dev/null'
expect "doctor reports the compile failure" '[[ "$(cli doctor 2>/dev/null || true)" == *"FAIL  compile"*"badge.module"* ]]'

printf 'wezdeck_plugin_cli: %d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
