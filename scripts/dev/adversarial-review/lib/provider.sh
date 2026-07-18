#!/usr/bin/env bash
# provider.sh — agent-agnostic adapter for adversarial-review.
#
# This is the ONLY file that knows how a specific agent CLI is invoked. Adding a
# new provider (gemini, opencode, …) means adding one branch here; run.sh and
# the prompts stay untouched.
#
# Source it to get run_agent()/agent_text()/provider_available(), or run it
# directly for a self-check:
#   provider.sh selfcheck [claude|codex ...]
#
# Contract:
#   agent_text  <provider> <prompt_file>   # stdin = business input; stdout = raw model text
#   run_agent   <provider> <prompt_file>   # same, but stdout = validated JSON (retries once on bad JSON)
# Both are READ-ONLY: the agent is confined to read-only tools/sandbox.

set -euo pipefail

# --- provider resolution -----------------------------------------------------

# OPEN QUESTION (spec §9.1): codex is not on PATH on the primary host; it is
# launched via scripts/runtime/agent-launcher.sh's codex profile. We probe PATH
# and a couple of common install spots; if not found, the provider reports
# unavailable and run.sh degrades gracefully (skips the cross-model gate).
_codex_bin() {
  if command -v codex >/dev/null 2>&1; then command -v codex; return 0; fi
  local c
  for c in "$HOME/.local/bin/codex" "$HOME/.codex/bin/codex" "$HOME/.local/share/fnm"/*/bin/codex; do
    [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

provider_available() {
  case "$1" in
    claude) command -v claude >/dev/null 2>&1 ;;
    codex)  _codex_bin >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

# --- JSON extraction ---------------------------------------------------------
# Pull the first well-formed JSON value out of arbitrary model text (handles
# ```json fences and surrounding prose). Uses raw_decode so brackets inside
# strings don't confuse it. Exit 1 if no valid JSON is present.
# NOTE: program is passed via -c (not `python3 - <<HEREDOC`), so the heredoc
# does not steal python's stdin — sys.stdin stays bound to the piped data.
_json_slice() {
  python3 -c '
import sys, re, json
s = sys.stdin.read()
s = re.sub(r"(?m)^```[a-zA-Z]*\s*$", "", s)   # strip fences
dec = json.JSONDecoder()
for i, ch in enumerate(s):
    if ch in "[{":
        try:
            obj, _ = dec.raw_decode(s[i:])
        except Exception:
            continue
        json.dump(obj, sys.stdout)
        sys.exit(0)
sys.exit(1)
'
}

# --- raw agent call ----------------------------------------------------------
# Echoes the model's final text to stdout. Reads business input from stdin.
agent_text() {
  local provider="$1" prompt_file="$2"
  local input full
  input="$(cat)"
  full="$(cat "$prompt_file")"$'\n\n=== INPUT ===\n'"$input"

  case "$provider" in
    claude)
      # -p print/headless; plan mode + read-only tools keep it from writing.
      # Prompt is piped on stdin to avoid ARG_MAX on large diffs.
      printf '%s' "$full" \
        | claude -p --output-format json \
            --permission-mode plan \
            --allowed-tools Read Grep Glob 2>/dev/null \
        | jq -r '.result // .text // empty'
      ;;
    codex)
      local bin
      bin="$(_codex_bin)" || { echo "__PROVIDER_UNAVAILABLE__"; return 3; }
      # OPEN QUESTION (spec §9.1): exec/json/read-only flags are UNVERIFIED on
      # this host. Best-effort; confirm against the installed codex before use.
      printf '%s' "$full" \
        | "$bin" exec --json - 2>/dev/null \
        | python3 -c 'import sys,json
last=""
for ln in sys.stdin:
    ln=ln.strip()
    if not ln: continue
    try: ev=json.loads(ln)
    except Exception: continue
    t=ev.get("text") or ev.get("message",{}).get("content") or ev.get("delta")
    if isinstance(t,str) and t: last=t
print(last)'
      ;;
    *)
      echo "__PROVIDER_UNAVAILABLE__"; return 3 ;;
  esac
}

# --- JSON-returning agent call (retry once on invalid JSON) ------------------
run_agent() {
  local provider="$1" prompt_file="$2"
  local input; input="$(cat)"
  local attempt text out
  local pf="$prompt_file"
  for attempt in 1 2; do
    text="$(printf '%s' "$input" | agent_text "$provider" "$pf")" || return 3
    if [ "$text" = "__PROVIDER_UNAVAILABLE__" ]; then return 3; fi
    if out="$(printf '%s' "$text" | _json_slice)"; then
      printf '%s' "$out"; return 0
    fi
    # retry with a stricter nudge appended to the input
    input="$input"$'\n\n(Your previous output was not valid JSON. Output JSON ONLY, nothing else.)'
  done
  return 4   # still bad JSON after retry
}

# --- self-check --------------------------------------------------------------
# Verifies resolution AND a live JSON round-trip for each provider.
_selfcheck() {
  local providers=("$@")
  [ "${#providers[@]}" -eq 0 ] && providers=(claude codex)
  local tmp; tmp="$(mktemp)"
  printf 'Output ONLY this exact JSON array and nothing else: [{"ok":true}]\n' > "$tmp"
  local p rc=0 got
  for p in "${providers[@]}"; do
    printf '%-9s ' "$p:"
    if ! provider_available "$p"; then echo "UNAVAILABLE (not resolved on PATH)"; rc=1; continue; fi
    if got="$(printf 'ping' | run_agent "$p" "$tmp" 2>/dev/null)" \
       && printf '%s' "$got" | jq -e '.[0].ok == true' >/dev/null 2>&1; then
      echo "OK (resolved + JSON round-trip)"
    else
      echo "resolved, but JSON round-trip FAILED (got: ${got:-<empty>})"; rc=1
    fi
  done
  rm -f "$tmp"
  return "$rc"
}

if [ "${BASH_SOURCE[0]:-}" = "${0:-}" ]; then
  case "${1:-}" in
    selfcheck) shift; _selfcheck "$@" ;;
    *) echo "usage: provider.sh selfcheck [claude|codex ...]" >&2; exit 1 ;;
  esac
fi
