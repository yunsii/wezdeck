#!/usr/bin/env bash
# Check a change on the person's own devices: the web consoles they have open
# — phones over the relay and the host's own browser (local mode) alike —
# through `wezdeck-wsl diag`. First wait until every answering page runs the
# deployed build (`current`), then run read-only steps there and print what
# each page shows. Born from a day of fixes verified on samples and emulated
# phones while the person's page still showed the bug (2026-11-25).
#
#   scripts/dev/device-check.sh [--wait-current SECONDS] [--reason TEXT]
#                               [--steps JSON | --steps-file FILE] [--json]
#
# --wait-current  keep asking (every ~10 s) until all answering pages are
#                 current, at most this long (default 40; 0 = ask once)
# --steps         diag steps to run once they are current, e.g.
#                 '[{"do":"query","selector":"[data-session]","attrs":["data-session"]}]'
# --json          print the raw diag answer instead of the summary
#
# Exit 0 = at least one page answered and all are current (steps ran);
# 1 = no page answered, or one stayed on an older build (do not ask the
# person to retest yet); 2 = usage. Logs one `category=device_check` row.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bin="$repo/native/wezdeck-wsl/bin/wezdeck-wsl"
wait_current=40
reason='device check'
steps='[]'
raw=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait-current) wait_current=$2; shift 2 ;;
    --reason) reason=$2; shift 2 ;;
    --steps) steps=$2; shift 2 ;;
    --steps-file) steps="$(cat "$2")"; shift 2 ;;
    --json) raw=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "device-check: unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ -x "$bin" ]] || { echo "device-check: $bin not built" >&2; exit 2; }
python3 -c 'import json,sys; assert isinstance(json.loads(sys.argv[1]), list)' "$steps" 2>/dev/null \
  || { echo "device-check: --steps must be a JSON array" >&2; exit 2; }

ask() { "$bin" diag --wait 10 --reason "$1" --steps "$2"; }

# 1) every answering page on the deployed build
deadline=$((SECONDS + wait_current))
state=''
while :; do
  out="$(ask "$reason (version)" '[]')"
  state="$(python3 -c '
import json, sys
d = json.loads(sys.argv[1])
rs = d.get("results") or []
stale = [r["client"] for r in rs if r.get("current") is False]
print(len(rs), len(stale), " ".join(stale))
' "$out")"
  read -r answered stale_n stale_ids <<<"$state"
  if [[ "$answered" -gt 0 && "$stale_n" -eq 0 ]] || ((SECONDS >= deadline)); then
    break
  fi
  if [[ "$answered" -eq 0 ]]; then
    echo "device-check: no page answered yet (open the console, keep it in front)…" >&2
  else
    echo "device-check: $stale_n page(s) still on an older build ($stale_ids), waiting…" >&2
  fi
  sleep 2
done

# 2) the steps, on the current pages
result="$out"
if [[ "$answered" -gt 0 && "$stale_n" -eq 0 && "$steps" != '[]' ]]; then
  result="$(ask "$reason" "$steps")"
fi

source "$repo/scripts/runtime/runtime-log-lib.sh"
runtime_log_info device_check "device check finished" answered="$answered" stale="$stale_n" \
  steps="$(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1])))' "$steps")" || true

if ((raw)); then
  printf '%s\n' "$result"
else
  python3 - "$result" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
rs = d.get("results") or []
if not rs:
    print("no page answered" + (f" — {d['hint']}" if d.get("hint") else ""))
for r in rs:
    cur = {True: "current", False: "OLD BUILD", None: "build ?"}[r.get("current")]
    print(f"{r['client']}  {cur}  build={r.get('build','?')}  page={r.get('page','?')}")
    for s in r.get("steps") or []:
        what = s.get("selector") or s.get("to") or s.get("text") or ""
        if s.get("do") == "query":
            print(f"  query {what}: {s.get('count', 0)}")
            for item in (s.get("items") or [])[:5]:
                attrs = {k: v for k, v in (item.get("attrs") or {}).items() if v is not None}
                text = (item.get("text") or "")[:50]
                print(f"    rect={item.get('rect')} {json.dumps(attrs, ensure_ascii=False) if attrs else ''} {text!r}")
        else:
            status = s.get("skipped") or s.get("error") or ("ok" if s.get("ok") else "")
            print(f"  {s.get('do')} {what}: {status}")
if d.get("unanswered"):
    print(f"unanswered: {d['unanswered']} (locked or in the background)")
PY
fi

[[ "$answered" -gt 0 && "$stale_n" -eq 0 ]] || exit 1
