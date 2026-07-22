#!/usr/bin/env bash
# Regression for the check-then-consume race (adversarial-review lease.sh):
# N concurrent sb_lease_consume on a max-sends=1 lease must succeed exactly once.
# Pre-fix (non-atomic >"$p", no lock) this let multiple readers each see
# sends_used=0 and write 1 — bypassing the send cap.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/session-bridge/lib.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/session-bridge/lease.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export OPENCLAW_HOME="$TMP"
export SB_PANIC_PATH="$TMP/state/session-bridge.panic"
mkdir -p "$TMP/state" "$TMP/logs"

mint="$(sb_lease_mint "demo:0.0" 60 1)"
lid="$(jq -r '.lease.id' <<<"$mint")"

N=20
outdir="$TMP/out"
mkdir -p "$outdir"
for i in $(seq 1 "$N"); do
  ( if sb_lease_consume "$lid" >/dev/null 2>&1; then echo ok; else echo no; fi >"$outdir/$i.rc" ) &
done
wait

succ=0
for r in "$outdir"/*.rc; do
  [[ "$(cat "$r")" == "ok" ]] && succ=$((succ + 1))
done

if [[ "$succ" -ne 1 ]]; then
  echo "FAIL: max-sends=1 lease consumed $succ times under $N concurrent consumers (expected 1)" >&2
  exit 1
fi
echo "PASS: concurrent lease consume capped at max_sends ($succ/$N succeeded)"
