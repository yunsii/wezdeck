#!/usr/bin/env bash
# Offline unit checks for host-agent-invoke (no real LLM).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$here/lib/host-agent-invoke.sh"

pass=0
fail=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }

echo "host-agent-invoke test (MOCK)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/host-agent-invoke-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

prompt="$tmp/prompt.md"
cwd="$tmp/cwd"
trace="$tmp/trace.jsonl"
log="$tmp/out.log"
mkdir -p "$cwd"
printf '%s\n' "Say hello." >"$prompt"

export HOST_AGENT_INVOKE_MOCK=1
export HOST_AGENT_INVOKE_TRACE="$trace"

if host_agent_invoke_run --backend claude --mode write --cwd "$cwd" --prompt-file "$prompt" --log "$log"; then
  ok "mock write/claude exits 0"
else
  bad "mock write/claude exits 0"
fi

if host_agent_invoke_run --backend codex --mode read --cwd "$cwd" --prompt-file "$prompt" --log "$log"; then
  ok "mock read/codex exits 0"
else
  bad "mock read/codex exits 0"
fi

if host_agent_invoke_run --backend grok --mode write --cwd "$cwd" --prompt-file "$prompt" --log "$log"; then
  ok "mock write/grok exits 0"
else
  bad "mock write/grok exits 0"
fi

if jq -e -s '
  (map(select(.backend=="claude" and .mode=="write" and .mock==true)) | length == 1)
  and (map(select(.backend=="codex" and .mode=="read" and .mock==true)) | length == 1)
  and (map(select(.backend=="grok" and .mode=="write" and .mock==true)) | length == 1)
' <"$trace" >/dev/null; then
  ok "trace records backend+mode+mock for all three"
else
  bad "trace records backend+mode+mock for all three"
  cat "$trace" >&2
fi

if host_agent_invoke_run --backend nope --mode write --cwd "$cwd" --prompt-file "$prompt" --log "$log" 2>/dev/null; then
  bad "unknown backend rejected"
else
  ok "unknown backend rejected"
fi

if host_agent_invoke_run --backend claude --mode weird --cwd "$cwd" --prompt-file "$prompt" --log "$log" 2>/dev/null; then
  bad "unknown mode rejected"
else
  ok "unknown mode rejected"
fi

cap="$(host_agent_invoke_run --backend claude --mode read --cwd "$cwd" --prompt-file "$prompt" --capture)"
if [[ "$cap" == '{"result":""}' ]]; then
  ok "mock --capture returns stable claude JSON shape"
else
  bad "mock --capture returns stable claude JSON shape"
  printf 'got=%s\n' "$cap" >&2
fi

# Structural: read vs write branches exist in the shipped lib (review vs ticket profiles).
lib="$here/lib/host-agent-invoke.sh"
if grep -q 'permission-mode bypassPermissions' "$lib" \
  && grep -q 'permission-mode plan' "$lib" \
  && grep -q 'sandbox read-only' "$lib" \
  && grep -q 'full-auto' "$lib" \
  && grep -q 'AGENT_ATTENTION_SKIP=1' "$lib" \
  && grep -q 'env -u CODEX_HOME' "$lib" \
  && grep -q -- '--capture' "$lib"; then
  ok "lib encodes distinct read/write flags + attention-skip + host CODEX_HOME unset + capture"
else
  bad "lib encodes distinct read/write flags + attention-skip + host CODEX_HOME unset + capture"
fi

# Review providers must call shared invoke (not private env|claude case).
prov="$here/../adversarial-review/lib/providers"
if grep -q 'host_agent_invoke_run' "$prov/claude.sh" \
  && grep -q 'host_agent_invoke_run' "$prov/codex.sh" \
  && grep -q 'host_agent_invoke_run' "$prov/grok.sh" \
  && ! grep -qE 'AGENT_ATTENTION_SKIP=1 \\\s*$' "$prov/claude.sh"; then
  ok "review providers delegate CLI launch to host-agent-invoke"
else
  bad "review providers delegate CLI launch to host-agent-invoke"
fi

echo "---"
printf 'pass=%d fail=%d\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
