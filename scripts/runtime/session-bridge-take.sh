#!/usr/bin/env bash
# Ctrl+K w chord entry: hand focused (or explicit) tmux pane to session-bridge take.
# Invoked from tmux chord with optional: target pane_id
#   bash session-bridge-take.sh 'sess:0.1' '%12'
#
# tmux run-shell surfaces stdout as a status banner — never dump raw JSON there.
# Success/failure goes through display-message only; JSON only on stderr if SB_TAKE_DEBUG=1.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
SB="$repo_root/openclaw/scripts/session-bridge.sh"

toast() {
  local msg="${1:-}"
  # Keep under typical status width; avoid multiline JSON leaks.
  msg="${msg//$'\n'/ }"
  if ((${#msg} > 120)); then
    msg="${msg:0:117}..."
  fi
  if command -v tmux >/dev/null 2>&1; then
    tmux display-message "Claw take: ${msg}" 2>/dev/null || true
  fi
}

if [[ ! -x "$SB" && ! -f "$SB" ]]; then
  toast "missing $SB"
  printf 'session-bridge-take: missing %s\n' "$SB" >&2
  exit 0
fi

target="${1:-}"
pane_id="${2:-}"

args=(take --confirm-notify)
if [[ -n "$target" && "$target" != "" ]]; then
  args+=(--target "$target")
else
  args+=(--focus)
fi
if [[ -n "${pane_id:-}" ]]; then
  args+=(--pane-id "$pane_id")
fi

toast "handing off…"

out=""
ec=0
out="$(bash "$SB" "${args[@]}" 2>&1)" || ec=$?

if [[ "${SB_TAKE_DEBUG:-0}" == "1" ]]; then
  printf '%s\n' "$out" >&2
fi

if [[ $ec -eq 0 ]]; then
  # Prefer server ack_message (already human Chinese); else compact summary.
  summary="$(printf '%s\n' "$out" | python3 -c '
import sys, json
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    print("ok")
    raise SystemExit(0)
ack = (d.get("ack_message") or "").strip()
if ack:
    print(ack)
    raise SystemExit(0)
j = d.get("job") or {}
print(f"{j.get(\"target\", \"?\")} ({j.get(\"kind\", \"?\")}) status={j.get(\"last_status\", \"?\")}")
' 2>/dev/null || printf 'ok')"
  toast "$summary"
  exit 0
fi

err_msg="$(printf '%s\n' "$out" | python3 -c '
import sys, json
raw = sys.stdin.read()
try:
    d = json.loads(raw)
    print((d.get("error") or raw[:100]).strip())
except Exception:
    lines = [ln for ln in raw.strip().splitlines() if ln.strip()]
    print(lines[-1][:120] if lines else "failed")
' 2>/dev/null || printf 'failed')"
toast "$err_msg"

# Always exit 0 from the chord wrapper so tmux does not append "… returned N".
exit 0
