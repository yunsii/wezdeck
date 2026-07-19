#!/usr/bin/env bash
# provider.sh — agent-agnostic adapter for adversarial-review.
#
# Backend aliases (review matrix — not OpenClaw ACP harness ids):
#   claude       Claude Code CLI
#   codex        alias of codex-gpt (native Codex default model)
#   codex-gpt    Codex with native/default GPT profile (host ~/.codex)
#   codex-grok   Codex with --profile grok (host grok profile; not ACP CODEX_HOME)
#
# IMPORTANT: uses host CLI configs (~/.claude, ~/.codex). Must NOT set
# CODEX_HOME to OpenClaw ACP isolation (~/.openclaw/acpx/codex-home).

set -euo pipefail

_codex_bin() {
  if command -v codex >/dev/null 2>&1; then command -v codex; return 0; fi
  local c
  for c in "$HOME/.local/bin/codex" "$HOME/.codex/bin/codex"; do
    [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

_provider_canonical() {
  case "$1" in
    claude) echo claude ;;
    codex|codex-gpt|codex_gpt|gpt) echo codex-gpt ;;
    codex-grok|codex_grok|grok) echo codex-grok ;;
    *) echo "$1" ;;
  esac
}

_provider_family() {
  case "$(_provider_canonical "$1")" in
    claude) echo claude ;;
    codex-gpt|codex-grok) echo codex ;;
    *) echo "$1" ;;
  esac
}

provider_available() {
  local p
  p="$(_provider_canonical "$1")"
  case "$p" in
    claude) command -v claude >/dev/null 2>&1 ;;
    codex-gpt|codex-grok) _codex_bin >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

provider_same_family() {
  [ "$(_provider_family "$1")" = "$(_provider_family "$2")" ]
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

_codex_extract_text() {
  python3 -c '
import sys, json
last = ""
for ln in sys.stdin:
    ln = ln.strip()
    if not ln:
        continue
    try:
        ev = json.loads(ln)
    except Exception:
        continue
    for key in ("text", "delta", "content", "message"):
        v = ev.get(key)
        if isinstance(v, str) and v.strip():
            last = v
        elif isinstance(v, dict):
            c = v.get("content") or v.get("text")
            if isinstance(c, str) and c.strip():
                last = c
            elif isinstance(c, list):
                parts = []
                for item in c:\n                    if isinstance(item, dict) and isinstance(item.get("text"), str):
                        parts.append(item["text"])
                    elif isinstance(item, str):
                        parts.append(item)
                if parts:
                    last = "".join(parts)
    if ev.get("type") in ("agent_message", "message", "item.completed"):
        item = ev.get("item") or ev.get("message") or {}
        if isinstance(item, dict):
            t = item.get("text") or item.get("content")
            if isinstance(t, str) and t.strip():
                last = t
print(last)
'
}

agent_text() {
  local provider="$1" prompt_file="$2"
  local input full bin
  provider="$(_provider_canonical "$provider")"
  input="$(cat)"
  full="$(cat "$prompt_file")"$'\n\n=== INPUT ===\n'"$input"

  case "$provider" in
    claude)
      printf '%s' "$full" \
        | claude -p --output-format json \
            --permission-mode plan \
            --allowed-tools Read Grep Glob 2>/dev/null \
        | jq -r '.result // .text // empty'
      ;;
    codex-gpt)
      bin="$(_codex_bin)" || { echo "__PROVIDER_UNAVAILABLE__"; return 3; }
      printf '%s' "$full" \
        | env -u CODEX_HOME "$bin" exec --json --sandbox read-only - 2>/dev/null \
        | _codex_extract_text
      ;;
    codex-grok)
      bin="$(_codex_bin)" || { echo "__PROVIDER_UNAVAILABLE__"; return 3; }
      printf '%s' "$full" \
        | env -u CODEX_HOME "$bin" exec --json --sandbox read-only \
            -p grok -m grok-4.5 - 2>/dev/null \
        | _codex_extract_text
      ;;
    *)
      echo "__PROVIDER_UNAVAILABLE__"; return 3 ;;
  esac
}

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
    input="$input"$'\n\n(Your previous output was not valid JSON. Output JSON ONLY, nothing else.)'
  done
  return 4
}

_selfcheck() {
  local providers=("$@")
  [ "${#providers[@]}" -eq 0 ] && providers=(claude codex-gpt codex-grok)
  local tmp; tmp="$(mktemp)"
  printf 'Output ONLY this exact JSON array and nothing else: [{"ok":true}]\n' > "$tmp"
  local p rc=0 got canon
  for p in "${providers[@]}"; do
    canon="$(_provider_canonical "$p")"
    printf '%-12s ' "$p($canon):"
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
    *) echo "usage: provider.sh selfcheck [claude|codex|codex-gpt|codex-grok ...]" >&2; exit 1 ;;
  esac
fi
