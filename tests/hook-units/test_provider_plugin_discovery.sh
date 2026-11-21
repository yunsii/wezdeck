#!/usr/bin/env bash
# adversarial-review provider.sh discovers review providers from enabled
# `kind: agent` plugins in the WezDeck plugin registry.
# Docs: docs/plugin-architecture.md#agent-providers
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
lib="$repo_root/skills/adversarial-review/lib/provider.sh"
prov="$repo_root/skills/adversarial-review/lib/providers"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass=0 fail=0
check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass=$((pass + 1)); printf '  PASS  %s\n' "$name"
  else
    fail=$((fail + 1)); printf '  FAIL  %s\n    expected=[%s]\n    actual=[%s]\n' "$name" "$expected" "$actual"
  fi
}
providers_with() {
  WEZDECK_PLUGIN_REGISTRY="$1" bash "$lib" providers 2>/dev/null | tr '\n' ' ' | sed 's/ $//'
}
registry() {  # registry <file> <json plugins array>
  printf '{"version":1,"plugins":%s}\n' "$2" >"$1"
}
agent() {  # agent <id> <enabled> <provider file>
  printf '{"id":"%s","kind":"agent","enabled":%s,"agent_files":{"review_provider":"%s"}}' "$1" "$2" "$3"
}

registry "$tmp/grok-off.json" "[$(agent agent-claude true "$prov/claude.sh"),$(agent agent-codex true "$prov/codex.sh"),$(agent agent-grok false "$prov/grok.sh")]"
check "disabled agent plugin drops its provider" "claude codex" "$(providers_with "$tmp/grok-off.json")"

registry "$tmp/no-agents.json" '[{"id":"disk-guard","kind":"guard","enabled":true}]'
check "registry without agent plugins falls back to all built-ins" "claude codex grok" "$(providers_with "$tmp/no-agents.json")"

check "missing registry falls back to all built-ins" "claude codex grok" "$(providers_with "$tmp/absent.json")"

cat >"$tmp/myai.sh" <<'EOF'
myai__available() { return 0; }
myai__family() { printf 'myai'; }
myai__model() { printf 'm1'; }
myai__invoke() { printf 'hi'; }
EOF
registry "$tmp/external.json" "[$(agent agent-claude true "$prov/claude.sh"),$(agent my-ai true "$tmp/myai.sh")]"
check "external agent plugin provider is loaded" "claude myai" "$(providers_with "$tmp/external.json")"

registry "$tmp/all-off.json" "[$(agent agent-claude false "$prov/claude.sh"),$(agent agent-grok false "$prov/grok.sh")]"
check "all agent plugins disabled → no providers" "" "$(providers_with "$tmp/all-off.json")"

printf '{broken' >"$tmp/broken.json"
check "unreadable registry falls back to all built-ins" "claude codex grok" "$(providers_with "$tmp/broken.json")"

printf 'provider_plugin_discovery: %d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
