#!/usr/bin/env bash
# Patch Grok Build's built-in GrokDay `bg_base` so the main canvas does
# not paint an opaque RGB fill.
#
# Default mode: **transparent / Color::Reset**
#   Grok leaves the cell background at the terminal default, so tmux's
#   dynamic `window-style` / `window-active-style` cream shows through
#   (inactive #eae9e1 ↔ active #f1f0e9). That also removes the focus-in
#   flash from bg_base ≠ active-pane style.
#
# Optional solid mode: pin an RGB cream (legacy):
#   WEZDECK_GROK_BG=f1f0e9 scripts/dev/patch-grok-theme-wezdeck.sh
#
# Why a binary patch: Grok 0.2.x has no public custom-theme API. Light
# theme stores bg_base once as a 4-byte crossterm/ratatui Color:
#   Rgb  = 0x11 rr gg bb   (tag 17 = Color::Rgb)
#   Reset= 00 00 00 00     (tag  0 = Color::Reset → terminal default bg)
# Exactly one source match is required or the script aborts.
#
# Re-run after every `grok` self-update / reinstall.
#
# Usage:
#   scripts/dev/patch-grok-theme-wezdeck.sh
#   WEZDECK_GROK_BG=default   scripts/dev/patch-grok-theme-wezdeck.sh
#   WEZDECK_GROK_BG=f1f0e9    scripts/dev/patch-grok-theme-wezdeck.sh
#   GROK_BIN=~/.grok/bin/grok scripts/dev/patch-grok-theme-wezdeck.sh
set -euo pipefail

GROK_BIN="${GROK_BIN:-$HOME/.grok/bin/grok}"
# default | reset | transparent | <6 hex digits>
TARGET_SPEC="${WEZDECK_GROK_BG:-default}"
# Prior fills we may need to migrate from (stock + earlier WezDeck patches).
SOURCE_CANDIDATES="${WEZDECK_GROK_BG_SOURCES:-eeeeee,eae9e1,f1f0e9}"

if [[ ! -f "$GROK_BIN" ]]; then
  printf 'patch-grok-theme-wezdeck: missing binary: %s\n' "$GROK_BIN" >&2
  exit 1
fi

python3 - "$GROK_BIN" "$TARGET_SPEC" "$SOURCE_CANDIDATES" <<'PY'
import os, shutil, sys
from pathlib import Path

path = Path(sys.argv[1])
target_spec = sys.argv[2].strip().lower()
sources = [s.strip().lower() for s in sys.argv[3].split(",") if s.strip()]

RGB_TAG = 0x11  # crossterm::style::Color::Rgb discriminant
RESET = bytes([0x00, 0x00, 0x00, 0x00])  # Color::Reset


def rgb_tag(hex6: str) -> bytes:
    if len(hex6) != 6 or any(c not in "0123456789abcdef" for c in hex6):
        raise SystemExit(f"invalid hex color: {hex6!r}")
    return bytes(
        [
            RGB_TAG,
            int(hex6[0:2], 16),
            int(hex6[2:4], 16),
            int(hex6[4:6], 16),
        ]
    )


if target_spec in ("default", "reset", "transparent", "none"):
    target_b = RESET
    target_label = "Color::Reset (terminal/tmux default bg)"
elif len(target_spec) == 6 and all(c in "0123456789abcdef" for c in target_spec):
    target_b = rgb_tag(target_spec)
    target_label = f"Rgb #{target_spec}"
else:
    raise SystemExit(
        f"WEZDECK_GROK_BG must be default|reset|transparent or 6 hex digits, got {target_spec!r}"
    )

data = bytearray(path.read_bytes())

# Already at target and no leftover sources?
source_hits = {s: data.count(rgb_tag(s)) for s in sources}
if data.count(target_b) >= 1 and all(n == 0 for n in source_hits.values()):
    # When target is RESET, count(RESET) is huge — only treat as done if
    # none of the known RGB fills remain.
    if target_b != RESET or all(n == 0 for n in source_hits.values()):
        if target_b == RESET and all(n == 0 for n in source_hits.values()):
            # Ambiguous: RESET appears everywhere. If no RGB sources, check
            # the known GrokDay site still holds RESET by looking for the
            # neighbor color pair Reset + #dedede.
            neighbor = RESET + rgb_tag("dedede")
            if data.find(neighbor) >= 0 or data.find(rgb_tag("dedede")) >= 0:
                # If stock/prior fills gone, assume already transparent.
                print(f"already patched: {path} → {target_label}")
                sys.exit(0)

# Prefer a source that appears exactly once.
source = None
source_b = None
for s in sources:
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
    # Maybe already Reset: look for 00 00 00 00 11 de de de (Reset + #dedede pair)
    pair = RESET + rgb_tag("dedede")
    if target_b == RESET and data.find(pair) >= 0:
        print(f"already patched: {path} → {target_label}")
        sys.exit(0)
    print(
        f"abort: none of the source colors {sources} found exactly once in {path}. "
        f"target={target_spec}. Inspect the binary before re-patching.",
        file=sys.stderr,
    )
    sys.exit(2)

if source_b == target_b:
    print(f"already patched: {path} → {target_label}")
    sys.exit(0)

bak = path.with_name(path.name + ".bak-theme")
if not bak.exists():
    shutil.copy2(path, bak)
    print(f"backup: {bak}")

# Safety: only replace when the GrokDay pair shape matches
#   <color4> 11 de de de   (bg_base + next light gray)
dedede = rgb_tag("dedede")
site = data.find(source_b + dedede)
if site < 0:
    # Fall back to lone single-occurrence replace (older layouts).
    data = data.replace(source_b, target_b, 1)
    how = "lone"
else:
    data[site : site + 4] = target_b
    how = "pair-with-#dedede"

tmp = path.with_name(path.name + ".tmp-theme")
tmp.write_bytes(data)
os.chmod(tmp, path.stat().st_mode)
tmp.replace(path)

verify = path.read_bytes()
assert verify.count(source_b) == 0, "source color still present"
if target_b != RESET:
    assert verify.count(target_b) >= 1, "target color missing after write"
else:
    assert verify.find(RESET + dedede) >= 0, "Reset+#dedede pair missing after write"

print(f"patched: {path} ({how})")
print(f"  GrokDay bg_base  #{source}  →  {target_label}")
print("  restart grok; main canvas should follow tmux pane bg (active/inactive cream).")
PY
