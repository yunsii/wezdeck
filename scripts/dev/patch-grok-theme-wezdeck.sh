#!/usr/bin/env bash
# Patch Grok Build's built-in GrokDay `bg_base` so the TUI cream matches
# WezDeck's *active* pane / WezTerm colorscheme background (#f1f0e9).
#
# Why not #eae9e1 (inactive pane cream)?
#   tmux opaque preset uses window-style=#eae9e1 and
#   window-active-style=#f1f0e9. Grok enables focus tracking and often
#   full-repaints on focus-in. If bg_base is the inactive cream, the
#   first paint frame after focus exposes the lighter active style —
#   perceived as a one-frame flash every time you focus the Grok pane.
#   Aligning bg_base to #f1f0e9 makes clear+repaint the same color as
#   the focused pane style.
#
# Why a binary patch: Grok 0.2.x has no public custom-theme API (theme
# tables are compiled in; pager.toml only restyles layout/blocks). The
# light theme stores bg_base once as a ratatui Rgb tag:
#   0x11 rr gg bb
# A single occurrence of the stock (or previously-patched) tag keeps
# this safe; the script aborts if the count is not exactly 1.
#
# Re-run after every `grok` self-update / reinstall.
#
# Usage:
#   scripts/dev/patch-grok-theme-wezdeck.sh
#   GROK_BIN=~/.grok/bin/grok scripts/dev/patch-grok-theme-wezdeck.sh
#   WEZDECK_GROK_BG=eae9e1 scripts/dev/patch-grok-theme-wezdeck.sh  # inactive cream
set -euo pipefail

GROK_BIN="${GROK_BIN:-$HOME/.grok/bin/grok}"
# Default: wezterm palette.background / tmux window-active-style cream.
TARGET_HEX="${WEZDECK_GROK_BG:-f1f0e9}"
# Colors we may need to migrate *from* (stock + prior WezDeck patches).
SOURCE_CANDIDATES="${WEZDECK_GROK_BG_SOURCES:-eeeeee,eae9e1}"

if [[ ! -f "$GROK_BIN" ]]; then
  printf 'patch-grok-theme-wezdeck: missing binary: %s\n' "$GROK_BIN" >&2
  exit 1
fi
if [[ ! "$TARGET_HEX" =~ ^[0-9a-fA-F]{6}$ ]]; then
  printf 'patch-grok-theme-wezdeck: WEZDECK_GROK_BG must be 6 hex digits, got %q\n' "$TARGET_HEX" >&2
  exit 1
fi
TARGET_HEX="${TARGET_HEX,,}"

python3 - "$GROK_BIN" "$TARGET_HEX" "$SOURCE_CANDIDATES" <<'PY'
import os, shutil, sys
from pathlib import Path

path = Path(sys.argv[1])
target = sys.argv[2].lower()
sources = [s.strip().lower() for s in sys.argv[3].split(",") if s.strip()]


def rgb_tag(hex6: str) -> bytes:
    return bytes([0x11, int(hex6[0:2], 16), int(hex6[2:4], 16), int(hex6[4:6], 16)])


target_b = rgb_tag(target)
data = bytearray(path.read_bytes())

if data.count(target_b) >= 1 and all(data.count(rgb_tag(s)) == 0 for s in sources if s != target):
    print(f"already patched: {path} has Rgb #{target}")
    sys.exit(0)

# Prefer a source that appears exactly once.
source = None
source_b = None
for s in sources:
    if s == target:
        continue
    b = rgb_tag(s)
    n = data.count(b)
    if n == 1:
        source, source_b = s, b
        break
    if n > 1:
        print(
            f"abort: Rgb #{s} appears {n} times in {path} (want exactly 1). "
            f"Grok version may have changed — inspect before re-patching.",
            file=sys.stderr,
        )
        sys.exit(2)

if source_b is None:
    print(
        f"abort: none of the source colors {sources} found exactly once in {path}. "
        f"target=#{target}. Inspect the binary before re-patching.",
        file=sys.stderr,
    )
    sys.exit(2)

bak = path.with_name(path.name + ".bak-theme")
if not bak.exists():
    shutil.copy2(path, bak)
    print(f"backup: {bak}")

data = data.replace(source_b, target_b, 1)
tmp = path.with_name(path.name + ".tmp-theme")
tmp.write_bytes(data)
os.chmod(tmp, path.stat().st_mode)
tmp.replace(path)

verify = path.read_bytes()
assert verify.count(source_b) == 0, "source color still present"
assert verify.count(target_b) >= 1, "target color missing after write"
print(f"patched: {path}")
print(f"  GrokDay bg_base  #{source}  →  #{target}")
print("  restart grok (or open a new session) so focus-in repaint matches the active pane.")
PY
