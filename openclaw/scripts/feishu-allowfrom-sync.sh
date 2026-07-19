#!/usr/bin/env bash
# Merge Feishu open_ids from gateway logs into channels.feishu.allowFrom.
# Why: open_id is per-app; the same human is different ou_* under Dex/Bob/Scout.
set -euo pipefail

LOG="${OPENCLAW_LOG:-/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log}"
CFG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"

if [[ ! -f "$CFG" ]]; then
  echo "missing config: $CFG" >&2
  exit 1
fi
if [[ ! -f "$LOG" ]]; then
  echo "missing log: $LOG" >&2
  exit 1
fi

# Prefer IDs that were explicitly blocked; also pick up "received message from"
mapfile -t CANDIDATES < <(
  {
    grep -oE 'blocked unauthorized sender ou_[a-f0-9]+' "$LOG" || true
    grep -oE 'received message from ou_[a-f0-9]+' "$LOG" || true
  } | grep -oE 'ou_[a-f0-9]+' | sort -u
)

if [[ ${#CANDIDATES[@]} -eq 0 ]]; then
  echo "no open_ids found in $LOG"
  exit 0
fi

echo "candidates from log:"
printf '  %s\n' "${CANDIDATES[@]}"

python3 - "$CFG" "${CANDIDATES[@]}" <<'PY'
import json
import sys
from pathlib import Path

cfg_path = Path(sys.argv[1])
extra = sys.argv[2:]
d = json.loads(cfg_path.read_text())
fe = d.setdefault("channels", {}).setdefault("feishu", {})
allow = list(fe.get("allowFrom") or [])
added = []
for x in extra:
    if x and x not in allow:
        allow.append(x)
        added.append(x)
fe["allowFrom"] = allow
if added:
    cfg_path.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
    print("added:", ", ".join(added))
else:
    print("no new open_ids")
print("allowFrom:", allow)
print("dmPolicy:", fe.get("dmPolicy"))
PY
