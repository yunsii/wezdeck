#!/usr/bin/env bash
# Unit tests for scripts/runtime/grok-focus-filter.py::_strip_focus.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FILTER_PY="$ROOT/scripts/runtime/grok-focus-filter.py"

python3 - "$FILTER_PY" <<'PY'
import importlib.util
import sys
from pathlib import Path

path = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("grok_focus_filter", path)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)
strip = mod._strip_focus


def run(chunks, enabled=True):
    pending = bytearray()
    delivered = bytearray()
    for chunk in chunks:
        pending.extend(chunk)
        delivered.extend(strip(pending, enabled))
    return bytes(delivered), bytes(pending)


def assert_eq(label, got, want):
    if got != want:
        raise SystemExit(f"FAIL {label}: got={got!r} want={want!r}")


# Bare Esc must pass immediately (regression: /settings needed 3 Esc presses).
d, p = run([b"\x1b"])
assert_eq("lone Esc delivered", d, b"\x1b")
assert_eq("lone Esc pending empty", p, b"")

d, p = run([b"\x1b", b"\x1b", b"\x1b"])
assert_eq("three Esc all delivered", d, b"\x1b\x1b\x1b")
assert_eq("three Esc pending empty", p, b"")

# Esc then / must not stick (regression: slash needed two presses after modal).
d, p = run([b"\x1b", b"/"])
assert_eq("Esc then slash", d, b"\x1b/")
assert_eq("Esc then slash pending", p, b"")

# Full FocusIn / FocusOut stripped in one chunk.
d, p = run([b"\x1b[I"])
assert_eq("FocusIn stripped", d, b"")
assert_eq("FocusIn pending", p, b"")
d, p = run([b"\x1b[O"])
assert_eq("FocusOut stripped", d, b"")

# Incomplete ESC [ held; completed as FocusIn on next chunk.
d, p = run([b"\x1b["])
assert_eq("incomplete CSI hold delivered", d, b"")
assert_eq("incomplete CSI hold pending", p, b"\x1b[")
d2, p2 = run([b"\x1b[", b"I"])
assert_eq("split FocusIn stripped", d2, b"")
assert_eq("split FocusIn pending", p2, b"")

# Incomplete ESC [ then non-focus final byte → forward whole CSI.
d, p = run([b"\x1b[", b"A"])
assert_eq("arrow CSI intact", d, b"\x1b[A")
assert_eq("arrow CSI pending", p, b"")

# Pathological split FocusIn starting with lone Esc: Esc was already forwarded,
# so the trailing "[I" is ordinary input (accepted tradeoff vs holding every Esc).
d, p = run([b"\x1b", b"[I"])
assert_eq("pathological FocusIn leak stream", d, b"\x1b[I")
assert_eq("pathological FocusIn pending", p, b"")

# Filter off: pass through everything.
d, p = run([b"\x1b[Ihello"], enabled=False)
assert_eq("disabled pass-through", d, b"\x1b[Ihello")

# Mixed: text + FocusIn + Esc + slash.
d, p = run([b"ab", b"\x1b[I", b"\x1b", b"/cd"])
assert_eq("mixed stream", d, b"ab\x1b/cd")
assert_eq("mixed pending", p, b"")

print("ok")
PY
