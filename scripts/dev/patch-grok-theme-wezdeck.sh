#!/usr/bin/env bash
# Patch Grok Build's built-in GrokDay `bg_base` so the TUI cream matches
# this repo's WezDeck pane background (#eae9e1) instead of stock #eeeeee.
#
# Why a binary patch: Grok 0.2.x has no public custom-theme API (theme
# tables are compiled in; pager.toml only restyles layout/blocks). The
# light theme stores bg_base once as a ratatui Rgb tag:
#   0x11 0xee 0xee 0xee  →  0x11 0xea 0xe9 0xe1
# A single occurrence keeps this safe; the script aborts if the count
# is not exactly 1 (or already patched).
#
# Re-run after every `grok` self-update / reinstall.
#
# Usage:
#   scripts/dev/patch-grok-theme-wezdeck.sh
#   GROK_BIN=~/.grok/bin/grok scripts/dev/patch-grok-theme-wezdeck.sh
#   WEZDECK_GROK_BG=f1f0e9 scripts/dev/patch-grok-theme-wezdeck.sh  # alternate cream
set -euo pipefail

GROK_BIN="${GROK_BIN:-$HOME/.grok/bin/grok}"
# Default: tmux opaque inactive/window cream (matches user-visible pane).
# Active-pane / wezterm colorscheme base is #f1f0e9 — override via env if preferred.
TARGET_HEX="${WEZDECK_GROK_BG:-eae9e1}"
STOCK_HEX="eeeeee"

if [[ ! -f "$GROK_BIN" ]]; then
  printf 'patch-grok-theme-wezdeck: missing binary: %s\n' "$GROK_BIN" >&2
  exit 1
fi
if [[ ! "$TARGET_HEX" =~ ^[0-9a-fA-F]{6}$ ]]; then
  printf 'patch-grok-theme-wezdeck: WEZDECK_GROK_BG must be 6 hex digits, got %q\n' "$TARGET_HEX" >&2
  exit 1
fi
TARGET_HEX="${TARGET_HEX,,}"

python3 - "$GROK_BIN" "$STOCK_HEX" "$TARGET_HEX" <<'PY'
import os, shutil, sys
from pathlib import Path

path = Path(sys.argv[1])
stock = sys.argv[2]
target = sys.argv[3]

def rgb_tag(hex6: str) -> bytes:
    return bytes([0x11, int(hex6[0:2], 16), int(hex6[2:4], 16), int(hex6[4:6], 16)])

stock_b = rgb_tag(stock)
target_b = rgb_tag(target)

data = bytearray(path.read_bytes())
n_stock = data.count(stock_b)
n_target = data.count(target_b)

if n_stock == 0 and n_target >= 1:
    print(f'already patched: {path} has Rgb #{target} (no stock #{stock})')
    sys.exit(0)
if n_stock != 1:
    print(
        f'abort: expected exactly 1× Rgb #{stock}, found {n_stock} in {path}. '
        f'Grok version may have changed — inspect before re-patching.',
        file=sys.stderr,
    )
    sys.exit(2)

bak = path.with_name(path.name + '.bak-theme')
if not bak.exists():
    shutil.copy2(path, bak)
    print(f'backup: {bak}')

data = data.replace(stock_b, target_b, 1)
tmp = path.with_name(path.name + '.tmp-theme')
tmp.write_bytes(data)
os.chmod(tmp, path.stat().st_mode)
tmp.replace(path)

verify = path.read_bytes()
assert verify.count(stock_b) == 0, 'stock color still present'
assert verify.count(target_b) >= 1, 'target color missing after write'
print(f'patched: {path}')
print(f'  GrokDay bg_base  #{stock}  →  #{target}')
print('  restart grok (or open a new session) to see the cream background.')
PY
