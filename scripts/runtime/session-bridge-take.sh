#!/usr/bin/env bash
# Ctrl+K w chord entry: hand focused (or explicit) tmux pane to session-bridge take.
# Invoked from tmux chord with optional: target pane_id
#   bash session-bridge-take.sh 'sess:0.1' '%12'
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
SB="$repo_root/openclaw/scripts/session-bridge.sh"

if [[ ! -x "$SB" && ! -f "$SB" ]]; then
  # toast-ish via tmux display if available
  if command -v tmux >/dev/null 2>&1; then
    tmux display-message "session-bridge-take: missing $SB" 2>/dev/null || true
  fi
  printf 'session-bridge-take: missing %s\n' "$SB" >&2
  exit 2
fi

target="${1:-}"
pane_id="${2:-}"

# Prefer explicit target from chord format vars; else --focus
args=(take --confirm-notify)
if [[ -n "$target" && "$target" != "" ]]; then
  args+=(--target "$target")
else
  args+=(--focus)
fi
if [[ -n "${pane_id:-}" ]]; then
  args+=(--pane-id "$pane_id")
fi

# Surface a short status line in tmux chrome
if command -v tmux >/dev/null 2>&1; then
  tmux display-message "Claw take: handing off…" 2>/dev/null || true
fi

out=""
ec=0
out="$(bash "$SB" "${args[@]}" 2>&1)" || ec=$?

if [[ $ec -eq 0 ]]; then
  summary="$(printf '%s\n' "$out" | python3 -c 'import sys,json
try:
 d=json.load(sys.stdin); j=d.get("job") or {}
 print(f"{j.get("target","?")} ({j.get("kind","?")}) status={j.get("last_status","?")}")
except Exception:
 print(sys.stdin.read()[:80] if False else "ok")' 2>/dev/null || printf '%s' "ok")"
  if command -v tmux >/dev/null 2>&1; then
    tmux display-message "Claw take: ${summary}" 2>/dev/null || true
  fi
  printf '%s\n' "$out"
  exit 0
fi

# Surface refusal reason (e.g. non-agent shell) in tmux chrome
err_msg="$(printf '%s\n' "$out" | python3 -c 'import sys,json
raw=sys.stdin.read()
try:
 d=json.loads(raw); print(d.get("error") or raw[:100])
except Exception:
 print(raw.strip().splitlines()[-1][:120] if raw.strip() else "failed")' 2>/dev/null || printf 'failed')"
if command -v tmux >/dev/null 2>&1; then
  tmux display-message "Claw take: ${err_msg:0:100}" 2>/dev/null || true
fi
printf '%s\n' "$out" >&2
exit "$ec"
