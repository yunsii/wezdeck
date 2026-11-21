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

# Behavioral: per-backend argv profiles (read vs write, observe, resume/fork).
argv_of() { local -a _HOST_AGENT_GROK_ARGV=() _HOST_AGENT_ARGV=()
  [ "$1" = grok ] && _host_agent_grok_argv "$2" "$prompt" "" "" "$3" "$4" "$5"
  _host_agent_cli_argv "$1" "$2" "" "" "" "$3" "$4" "$5"; printf '%s\n' "${_HOST_AGENT_ARGV[@]}"; }
has() { grep -qxF -- "$2" <<<"$1"; }
a_cw="$(argv_of claude write 0 '' 0)"; a_cr="$(argv_of claude read 0 '' 0)"
a_cwo="$(argv_of claude write 1 sess-1 1)"
a_xw="$(argv_of codex write 0 '' 0)"; a_xr="$(argv_of codex read 0 '' 0)"; a_xwr="$(argv_of codex write 1 th-1 0)"
a_gwo="$(argv_of grok write 1 g-1 1)"
if has "$a_cw" bypassPermissions && has "$a_cw" text && has "$a_cr" plan && has "$a_cr" json \
  && has "$a_cwo" stream-json && has "$a_cwo" --verbose && has "$a_cwo" --resume && has "$a_cwo" sess-1 && has "$a_cwo" --fork-session \
  && has "$a_xw" --full-auto && has "$a_xr" read-only && has "$a_xr" --json \
  && has "$a_xwr" resume && has "$a_xwr" th-1 && has "$a_xwr" --json && has "$a_xwr" 'sandbox_mode="workspace-write"' && ! has "$a_xwr" --full-auto \
  && has "$a_gwo" streaming-json && has "$a_gwo" --resume && has "$a_gwo" --fork-session && has "$a_gwo" --always-approve; then
  ok "argv profiles: read/write, observe stream formats, resume/fork per backend"
else
  bad "argv profiles: read/write, observe stream formats, resume/fork per backend"
  printf '%s\n---\n' "$a_cwo" "$a_xwr" "$a_gwo" >&2
fi
# read profile parameters: custom allowlist, appended system prompt, max turns
ptrace="$tmp/profile-trace.jsonl"; printf 'SYS RULES\n' >"$tmp/sys.md"
_HOST_AGENT_ALLOW=(); prof="$(
  _HOST_AGENT_ALLOW=(Read Grep 'Bash(git -C rx log:*)'); _HOST_AGENT_SYSTEM_TEXT="SYS RULES"; _HOST_AGENT_MAX_TURNS=40
  argv_of claude read 1 '' 0)"
if has "$prof" 'Bash(git -C rx log:*)' && has "$prof" --append-system-prompt && has "$prof" "SYS RULES" && has "$prof" --max-turns && has "$prof" 40 && ! has "$prof" Glob; then
  ok "claude read profile: custom allowlist replaces default, system appended, max turns"
else
  bad "claude read profile parameters"; printf '%s\n' "$prof" >&2
fi
HOST_AGENT_INVOKE_TRACE="$ptrace" host_agent_invoke_run --backend grok --mode read --cwd "$cwd" --prompt-file "$prompt" \
  --allow-tool Read --allow-tool 'Bash(git -C rx log:*)' --append-system-file "$tmp/sys.md" --capture >/dev/null
if jq -e '(.argv|index("Bash(git -C rx log:*)")!=null) and (.prompt_file|endswith(".with-system.md"))' "$ptrace" >/dev/null \
  && grep -q 'SYS RULES' "$prompt.with-system.md"; then
  ok "grok read: extra Bash allow rules + system prepended to a prompt copy"
else
  bad "grok read profile parameters"; cat "$ptrace" >&2
fi
lib="$here/lib/host-agent-invoke.sh"
if grep -q 'AGENT_ATTENTION_SKIP=1' "$lib" && grep -q -- '-u CODEX_HOME' "$lib"; then
  ok "lib keeps attention-skip + host CODEX_HOME unset"
else
  bad "lib keeps attention-skip + host CODEX_HOME unset"
fi
if host_agent_invoke_run --backend claude --mode write --cwd "$cwd" --prompt-file "$prompt" --capture --run-dir "$tmp/r" 2>/dev/null; then
  bad "--run-dir with --capture rejected"
else
  ok "--run-dir with --capture rejected"
fi

# Observability: recorded real streams → launch record + run record + events.
fx="$here/tests/fixtures"
for b in claude codex grok; do
  rd="$tmp/runs-$b"
  extra="$tmp/extra-$b.json"
  printf '{"trigger":{"source":"cli"},"session":{"reuse":"fresh","reason":"no_prior"},"ticket":"req-x","phase":"research"}' >"$extra"
  HOST_AGENT_INVOKE_MOCK_STREAM="$fx/$b.stream.jsonl" host_agent_invoke_run --backend "$b" --mode write \
    --cwd "$cwd" --prompt-file "$prompt" --log "$log" --run-dir "$rd" --run-id run-t --launch-extra "$extra"
  if jq -e '.invocation.backend=="'"$b"'" and (.prompt.sha256|length==64) and .trigger.source=="cli" and .session.reuse=="fresh" and (.invocation.argv|length>1)' "$rd/run-t.launch.json" >/dev/null \
    && jq -e '.exit==0 and .ticket=="req-x" and (.session.id|type=="string") and .tool_calls>=1 and (.tokens.output|type=="number")' "$rd/run-t.json" >/dev/null \
    && jq -e -s 'map(.kind) as $k | ($k|index("run_start")!=null) and ($k|index("session_init")!=null) and ($k|index("tool")!=null) and ($k|index("milestone")!=null) and ($k|index("run_end")!=null)' "$rd/run-t.events.jsonl" >/dev/null \
    && [ -s "$rd/run-t.stream.jsonl" ]; then
    ok "observe/$b: launch + run record + events (run_start/session_init/tool/milestone/run_end)"
  else
    bad "observe/$b: launch + run record + events"
    cat "$rd/run-t.json" "$rd/run-t.events.jsonl" >&2 2>/dev/null
  fi
done
if jq -e '.tokens.input==4 and .tokens.cache_read==51198 and .tokens.cache_write==26768 and .cache_hit_rate==0.6566 and .turns==2 and (.cache_ttl|type=="string")' "$tmp/runs-claude/run-t.json" >/dev/null; then
  ok "claude usage normalized (cache read/write, ttl, hit rate)"
else
  bad "claude usage normalized"; jq '{tokens,cache_ttl,cache_hit_rate,turns}' "$tmp/runs-claude/run-t.json" >&2
fi
if jq -e '.tokens.input==800 and .tokens.cache_read==1200 and .tokens.cache_write==null and .cache_hit_rate==0.6 and .turns==null' "$tmp/runs-codex/run-t.json" >/dev/null; then
  ok "codex usage normalized (input excludes cached, unknown stays null)"
else
  bad "codex usage normalized"; jq '{tokens,cache_hit_rate,turns}' "$tmp/runs-codex/run-t.json" >&2
fi
HOST_AGENT_INVOKE_MOCK_RC=7 HOST_AGENT_INVOKE_MOCK_STREAM="$fx/claude.stream.jsonl" host_agent_invoke_run --backend claude --mode write \
  --cwd "$cwd" --prompt-file "$prompt" --log "$log" --run-dir "$tmp/runs-rc" --run-id run-rc; got_rc=$?
if [ "$got_rc" -eq 7 ] && jq -e '.exit==7' "$tmp/runs-rc/run-rc.json" >/dev/null; then
  ok "non-zero CLI exit propagates to caller and run record"
else
  bad "non-zero CLI exit propagates (rc=$got_rc)"
fi

# Review providers must call shared invoke (not private env|claude case).
prov="$here/../../../skills/adversarial-review/lib/providers"
if grep -q 'host_agent_invoke_run' "$prov/claude.sh" \
  && grep -q 'host_agent_invoke_run' "$prov/codex.sh" \
  && grep -q 'host_agent_invoke_run' "$prov/grok.sh" \
  && ! grep -qE 'AGENT_ATTENTION_SKIP=1 \\\s*$' "$prov/claude.sh"; then
  ok "review providers ticket CLI launch to host-agent-invoke"
else
  bad "review providers ticket CLI launch to host-agent-invoke"
fi

echo "---"
printf 'pass=%d fail=%d\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
