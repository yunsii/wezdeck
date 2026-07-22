#!/usr/bin/env bash
# provider.sh — plugins + mock + JSON helpers + single-shot invoke.
#
# Plugin interface (providers/<name>.sh):
#   <name>__available / __family / __model / __invoke  [+ optional __aliases]
# Adding a backend = drop a plugin file; no core edits. This file has no
# backend names.
#
# Single-shot (hot path): agent_text / run_agent → plugin __invoke directly.
# Multi-shot / parallel: scripts/dev/agent-fanout/lib/fanout-lib.sh (sources
# this file). Do not auto-load fanout from here — dependency is one-way.
#
# IMPORTANT: plugins use host CLI configs (~/.claude, ~/.codex, ~/.grok) and must
# NOT set CODEX_HOME to OpenClaw ACP isolation.

set -euo pipefail

_PROVIDER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Non-login agent shells often miss host CLIs.
case ":${PATH:-}:" in *":${HOME}/.local/bin:"*) ;; *)
  export PATH="${HOME}/.local/bin${PATH:+:$PATH}" ;;
esac
case ":${PATH:-}:" in *":${HOME}/.grok/bin:"*) ;; *)
  export PATH="${HOME}/.grok/bin${PATH:+:$PATH}" ;;
esac

# --- load plugins & build the registry --------------------------------------
_ALL_PROVIDERS=()
declare -A _ALIAS_MAP=()
_load_providers() {
  local f name al
  for f in "$_PROVIDER_LIB_DIR/providers/"*.sh; do
    [ -e "$f" ] || continue
    # shellcheck source=/dev/null
    . "$f"
    name="$(basename "$f" .sh)"
    _ALL_PROVIDERS+=("$name")
    _ALIAS_MAP["$name"]="$name"
    if declare -F "${name}__aliases" >/dev/null 2>&1; then
      for al in $("${name}__aliases" 2>/dev/null); do _ALIAS_MAP["$al"]="$name"; done
    fi
  done
}
_load_providers

_provider_canonical() { printf '%s' "${_ALIAS_MAP[$1]:-$1}"; }

_provider_family() {
  local p; p="$(_provider_canonical "$1")"
  if declare -F "${p}__family" >/dev/null 2>&1; then "${p}__family"; else printf '%s' "$p"; fi
}
provider_same_family() { [ "$(_provider_family "$1")" = "$(_provider_family "$2")" ]; }

provider_available() {
  [ -n "${PROVIDER_MOCK:-}" ] && return 0
  local p; p="$(_provider_canonical "$1")"
  declare -F "${p}__available" >/dev/null 2>&1 && "${p}__available"
}

provider_model() {
  local p; p="$(_provider_canonical "$1")"
  declare -F "${p}__model" >/dev/null 2>&1 && "${p}__model"
}

_json_slice() {
  python3 -c '
import sys, re, json
s = sys.stdin.read()
s = re.sub(r"(?m)^```[a-zA-Z]*\s*$", "", s)
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

# Offline mock: canned, shape-correct output per prompt basename. No LLM.
_provider_mock() {
  local pf; pf="$(basename "$1")"
  local input="$2" tail_json
  tail_json="$(printf '%s' "$input" | awk '/^=== [A-Z_]+ ===$/{buf="";next}{buf=buf $0 "\n"}END{printf "%s",buf}')"
  case "$pf" in
    diverge.md)
      printf '%s' '[{"title":"Mock idea A","summary":"mock summary A","novelty":3},{"title":"Mock idea B","summary":"mock summary B","novelty":4}]' ;;
    critic.md)
      printf '%s' '[{"file":"mock.sh","line":1,"summary":"mock finding","failure_scenario":"mock input -> mock crash","severity":"low","category":"correctness","verdict":"PLAUSIBLE"}]' ;;
    challenge.md)
      printf '%s' "$tail_json" | jq -c 'map(. + {feasibility:3,risks:["mock risk"],blocking_assumptions:["mock assumption"],challenge_note:"mock note"})' 2>/dev/null || printf '[]' ;;
    refute.md)
      printf '%s' "$tail_json" | jq -c 'map(. + {refuted:false,refute_reason:null})' 2>/dev/null || printf '[]' ;;
    converge.md)
      printf '%s' "$tail_json" | jq -c '{ideas:map(. + {score:7,verdict:"maybe",judge_note:"mock judgement"}),synthesis:"mock synthesis",key_tradeoffs:["mock tradeoff A vs B"]}' 2>/dev/null || printf '%s' '{"ideas":[],"synthesis":"","key_tradeoffs":[]}' ;;
    repro.md)
      printf '%s\n' '```bash' 'exit 99' '```' ;;
    *)
      printf '%s' '[]' ;;
  esac
}

# Single-shot hot path: template + INPUT → plugin. No fanout, no temp dir.
agent_text() {
  local provider="$1" prompt_file="$2" effort="${3:-}"
  local input full
  provider="$(_provider_canonical "$provider")"
  input="$(cat)"
  if [ -n "${PROVIDER_MOCK:-}" ]; then _provider_mock "$prompt_file" "$input"; return 0; fi
  declare -F "${provider}__invoke" >/dev/null 2>&1 || { echo "__PROVIDER_UNAVAILABLE__"; return 3; }
  "${provider}__available" || { echo "__PROVIDER_UNAVAILABLE__"; return 3; }
  full="$(cat "$prompt_file")"$'\n\n=== INPUT ===\n'"$input"
  printf '%s' "$full" | "${provider}__invoke" "$effort"
}

run_agent() {
  local provider="$1" prompt_file="$2" effort="${3:-}"
  local input; input="$(cat)"
  local attempt text out
  local pf="$prompt_file"
  for attempt in 1 2; do
    text="$(printf '%s' "$input" | agent_text "$provider" "$pf" "$effort")" || return 3
    if [ "$text" = "__PROVIDER_UNAVAILABLE__" ]; then return 3; fi
    if out="$(printf '%s' "$text" | _json_slice)"; then
      printf '%s' "$out"; return 0
    fi
    input="$input"$'\n\n(Your previous output was not valid JSON. Output JSON ONLY, nothing else.)'
  done
  return 4
}

_selfcheck() {
  local providers=("$@")
  [ "${#providers[@]}" -eq 0 ] && providers=("${_ALL_PROVIDERS[@]}")
  local tmp; tmp="$(mktemp)"
  printf 'Output ONLY this exact JSON array and nothing else: [{"ok":true}]\n' > "$tmp"
  local p rc=0 got canon
  for p in "${providers[@]}"; do
    canon="$(_provider_canonical "$p")"
    printf '%-26s ' "$p($canon → $(provider_model "$p")):"
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
    providers) printf '%s\n' "${_ALL_PROVIDERS[@]}" ;;
    probe)
      _pp="$(_provider_canonical "${2:-}")"
      provider_available "$_pp" || exit 1
      declare -F "${_pp}__invoke" >/dev/null 2>&1 || exit 1
      _pout="$(printf 'Reply with exactly: ping-ok' | "${_pp}__invoke" '' 2>/dev/null)" || true
      [ -n "$_pout" ] || exit 1
      ;;
    *) echo "usage: provider.sh {selfcheck [name ...] | providers | probe <name>}" >&2; exit 1 ;;
  esac
fi
