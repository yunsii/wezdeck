#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FMT="$ROOT/scripts/session-bridge/format-need-human.py"
out=$(printf '%s\n' '────────────────
 ☐ 交付路线
q line here?
❯ 1. Opt A
     detail a
  2. Opt B
     detail b
Enter to select · Esc to cancel' | python3 "$FMT" 's:1.1' 'claude-tui')
echo "$out" | grep -q '【交付路线】' || { echo fail title; exit 1; }
echo "$out" | grep -q '▶ 1. Opt A' || { echo fail sel; exit 1; }
echo "$out" | grep -q 'detail a' || { echo fail detail; exit 1; }
echo "$out" | grep -q '▸ 2. Opt B' || { echo fail o2; exit 1; }
echo "$out" | grep -q '🔔 需要确认' || { echo fail head; exit 1; }
# must not be a raw truncated dump starting mid-option
echo "$out" | grep -qv '需要确认 ·' || true
echo "PASS: format-need-human"
