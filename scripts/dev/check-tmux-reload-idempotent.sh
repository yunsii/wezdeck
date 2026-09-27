#!/usr/bin/env bash
# tmux.conf is sourced into a long-lived server. Append forms (`set -a`,
# `set -as`, `set -ga`, `set-hook -ga`) stack one copy per source-file
# unless the same source first replaces or unsets that name.
#
# A name is safe when, earlier in the file, it is unset (`set -u`) or
# replaced (`set -g` / `set-option -g` / `set-hook -g`, no -a).
# Comments are ignored. Fails on the first stacked name.
set -euo pipefail

conf="${1:-}"
if [[ -z "$conf" ]]; then
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  conf="$root/tmux.conf"
fi

if [[ ! -f "$conf" ]]; then
  printf 'check-tmux-reload-idempotent: missing %s\n' "$conf" >&2
  exit 1
fi

python3 - "$conf" <<'PY'
import re
import sys

path = sys.argv[1]
text = open(path, encoding="utf-8").read().splitlines()

# Flags are only the -[A-Za-z]+ token. Names and commands may contain
# "a" or "g" (client-attached, run-shell) and must not affect the class.
cmd_re = re.compile(
    r"^(?:set-option|set-hook|set)\s+(-[A-Za-z]+)\s+(\S+)"
)

reset = set()
fails = []
for lineno, raw in enumerate(text, 1):
    line = raw.split("#", 1)[0].strip()
    if not line:
        continue
    m = cmd_re.match(line)
    if not m:
        continue
    flags, name = m.group(1), m.group(2)
    if "a" in flags:
        if name not in reset:
            fails.append((lineno, name, raw.strip()))
        continue
    # -u unsets; -g (without -a) replaces. Both make a later append idempotent.
    if "u" in flags or "g" in flags:
        reset.add(name)

if fails:
    print("check-tmux-reload-idempotent: append without a prior reset", file=sys.stderr)
    for lineno, name, raw in fails:
        print(f"  {path}:{lineno}: {name}: {raw}", file=sys.stderr)
    print(
        "source-file runs every reload; unset (-u) or replace (-g, no -a) "
        "that name earlier in tmux.conf",
        file=sys.stderr,
    )
    sys.exit(1)

print(f"check-tmux-reload-idempotent: ok ({path})")
PY
