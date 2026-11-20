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

# Grok read must be really read-only (plan + allowlist + no web); write unchanged.
gtrace="$tmp/grok-trace.jsonl"
HOST_AGENT_INVOKE_TRACE="$gtrace" host_agent_invoke_run --backend grok --mode read \
  --cwd "$cwd" --prompt-file "$prompt" --model m1 --effort high --capture >/dev/null
HOST_AGENT_INVOKE_TRACE="$gtrace" host_agent_invoke_run --backend grok --mode write \
  --cwd "$cwd" --prompt-file "$prompt" --log "$log"
if jq -e -s '
  (.[0] | .mode=="read" and (.argv | index("--always-approve") == null)
    and (.argv | index("--disable-web-search") != null)
    and (.argv as $a | ($a | index("--permission-mode")) as $i | $i != null and $a[$i+1]=="plan")
    and (.argv as $a | ($a | index("--output-format")) as $i | $i != null and $a[$i+1]=="json")
    and ([.argv | indices("--allow")[]] | length >= 5)
    and (.argv | index("Bash(git log:*)") != null)
    and (.argv | index("Bash(git show:*)") != null)
    and (.argv as $a | ($a | index("-m")) as $i | $a[$i+1]=="m1")
    and (.argv as $a | ($a | index("--reasoning-effort")) as $i | $a[$i+1]=="high"))
' <"$gtrace" >/dev/null; then
  ok "grok read argv: plan + --allow list + --disable-web-search, no --always-approve"
else
  bad "grok read argv: plan + --allow list + --disable-web-search, no --always-approve"
  cat "$gtrace" >&2
fi
if jq -e -s '
  (.[1] | .mode=="write" and (.argv | index("--always-approve") != null)
    and (.argv | index("--permission-mode") == null)
    and (.argv | index("--allow") == null))
' <"$gtrace" >/dev/null; then
  ok "grok write argv keeps --always-approve, no plan/allow"
else
  bad "grok write argv keeps --always-approve, no plan/allow"
  cat "$gtrace" >&2
fi
# Allowlist must stay side-effect free: no shell/editors/writers.
if printf '%s\n' "${HOST_AGENT_GROK_READ_ALLOW[@]}" \
  | grep -qE '^Bash\((rm|mv|cp|tee|sed|awk|python|sh|bash|find|git (commit|push|checkout|reset|apply|add|stash))[ :]'; then
  bad "grok read allowlist has no mutating commands"
else
  ok "grok read allowlist has no mutating commands"
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
prov="$here/../../../skills/adversarial-review/lib/providers"
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
