#!/usr/bin/env bash
# Reconstruct agent-attention status transitions for a time window.
#
# Joins the WSL transition journal with wezterm.log (tick / state reloaded /
# render_status). Use when the right-status counter looks wrong and you need
# "what was on disk at rev N" without hand-grepping two log files.
#
# Usage:
#   scripts/dev/attention-forensics.sh --around 09:28
#   scripts/dev/attention-forensics.sh --day 2026-10-10 --around 09:28
#   scripts/dev/attention-forensics.sh --session f0ea224f --around 09:28
#   scripts/dev/attention-forensics.sh --rev 1842
#   scripts/dev/attention-forensics.sh --paths
#
# See docs/diagnostics.md / docs/agent-attention.md (observability).

set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/wsl-runtime-paths-lib.sh"
# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/windows-runtime-paths-lib.sh"

DAY=""
AROUND=""
SESSION=""
REV=""
WINDOW_MIN=15
SHOW_PATHS=0
LIMIT=40

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --day) DAY="$2"; shift 2 ;;
    --around) AROUND="$2"; shift 2 ;;
    --session) SESSION="$2"; shift 2 ;;
    --rev) REV="$2"; shift 2 ;;
    --window-min) WINDOW_MIN="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --paths) SHOW_PATHS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

JOURNAL="${WEZTERM_ATTENTION_JOURNAL_FILE:-$WSL_ATTENTION_JOURNAL_FILE}"
SNAP_DIR="${WEZTERM_ATTENTION_SNAPSHOTS_DIR:-$WSL_ATTENTION_SNAPSHOTS_DIR}"
WEZLOG=""
if windows_runtime_detect_paths 2>/dev/null; then
  WEZLOG="$WINDOWS_RUNTIME_STATE_WSL/logs/wezterm.log"
fi

if [[ "$SHOW_PATHS" -eq 1 ]]; then
  printf 'journal=%s\n' "$JOURNAL"
  printf 'snapshots=%s\n' "$SNAP_DIR"
  printf 'wezterm_log=%s\n' "${WEZLOG:-}"
  printf 'attention_json=%s\n' "${WINDOWS_RUNTIME_STATE_WSL:-}/state/agent-attention/attention.json"
  exit 0
fi

if [[ ! -f "$JOURNAL" ]]; then
  echo "no journal yet: $JOURNAL" >&2
  echo "Transitions appear after the next attention_state_write (send a prompt)." >&2
  exit 1
fi

if [[ -z "$DAY" ]]; then
  DAY="$(date +%Y-%m-%d)"
fi

# Build HH:MM window filter in Python for robust parsing.
export FORENSICS_JOURNAL="$JOURNAL"
export FORENSICS_WEZLOG="${WEZLOG:-}"
export FORENSICS_SNAP_DIR="${SNAP_DIR:-}"
export FORENSICS_DAY="$DAY"
export FORENSICS_AROUND="$AROUND"
export FORENSICS_SESSION="$SESSION"
export FORENSICS_REV="$REV"
export FORENSICS_WINDOW_MIN="$WINDOW_MIN"
export FORENSICS_LIMIT="$LIMIT"

python3 - <<'PY'
import json, os, re, sys
from datetime import datetime, timedelta, timezone

journal = os.environ["FORENSICS_JOURNAL"]
wezlog = os.environ.get("FORENSICS_WEZLOG") or ""
snap_dir = os.environ.get("FORENSICS_SNAP_DIR") or ""
day = os.environ["FORENSICS_DAY"]
around = os.environ.get("FORENSICS_AROUND") or ""
session = os.environ.get("FORENSICS_SESSION") or ""
rev_filter = os.environ.get("FORENSICS_REV") or ""
window_min = int(os.environ.get("FORENSICS_WINDOW_MIN") or "15")
limit = int(os.environ.get("FORENSICS_LIMIT") or "40")

def parse_day(d):
    return datetime.strptime(d, "%Y-%m-%d").date()

day_d = parse_day(day)
center = None
if around:
    # Accept HH:MM or HH:MM:SS
    parts = around.strip().split(":")
    if len(parts) < 2:
        print(f"bad --around {around!r}; want HH:MM", file=sys.stderr)
        sys.exit(2)
    h, m = int(parts[0]), int(parts[1])
    s = int(parts[2]) if len(parts) > 2 else 0
    center = datetime(day_d.year, day_d.month, day_d.day, h, m, s)
    lo = center - timedelta(minutes=window_min)
    hi = center + timedelta(minutes=window_min)
else:
    lo = datetime(day_d.year, day_d.month, day_d.day, 0, 0, 0)
    hi = lo + timedelta(days=1)

def ms_to_dt(ms):
    try:
        return datetime.fromtimestamp(int(ms) / 1000.0)
    except Exception:
        return None

rows = []
with open(journal, "r", encoding="utf-8", errors="replace") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        ts = o.get("ts_ms")
        dt = ms_to_dt(ts) if ts is not None else None
        if dt is None or dt < lo or dt >= hi:
            continue
        if session and session not in str(o.get("session_id") or ""):
            continue
        if rev_filter and str(o.get("rev")) != str(rev_filter):
            continue
        rows.append((dt, o))

rows.sort(key=lambda x: x[0])
rows = rows[-limit:]

# Index wezterm.log for state reloaded / render_status near the window.
reloaded = []
renders = []
kv_re = re.compile(r'(\w+)="([^"]*)"')
if wezlog and os.path.isfile(wezlog):
    # Scan a tail chunk to keep runtime bounded.
    try:
        with open(wezlog, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 8_000_000))
            chunk = f.read().decode("utf-8", errors="replace")
    except OSError:
        chunk = ""
    for line in chunk.splitlines():
        if 'category="attention"' not in line:
            continue
        if 'message="state reloaded"' not in line and 'message="render_status"' not in line:
            continue
        m = re.search(r'ts="([^"]+)"', line)
        if not m:
            continue
        try:
            dt = datetime.strptime(m.group(1)[:19], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        if dt.date() != day_d:
            continue
        if center and (dt < lo or dt > hi):
            continue
        fields = dict(kv_re.findall(line))
        if 'message="state reloaded"' in line:
            reloaded.append((dt, fields))
        else:
            renders.append((dt, fields))

def nearest(ts_list, dt, key_pref=None):
    best = None
    best_d = None
    for t, fields in ts_list:
        d = abs((t - dt).total_seconds())
        if best_d is None or d < best_d:
            best_d = d
            best = (t, fields, d)
    if best and best[2] <= 5.0:
        return best
    return None

print(f"# attention forensics day={day} around={around or '-'} session={session or '-'} rev={rev_filter or '-'}")
print(f"# journal={journal}")
print(f"# window={lo.strftime('%H:%M:%S')}..{hi.strftime('%H:%M:%S')} rows={len(rows)}")
print()
hdr = f"{'time':8} {'rev':>5} {'op':12} {'prev':8} {'status':8} {'r/w/d':7} {'digest':8} {'session':10} {'detail':12} {'ui':24}"
print(hdr)
print("-" * len(hdr))

for dt, o in rows:
    counts = o.get("counts") or {}
    cwd = f"{counts.get('running', 0)}/{counts.get('waiting', 0)}/{counts.get('done', 0)}"
    sid = (o.get("session_id") or "-")[:10]
    prev = (o.get("prev_status") or "-")[:8]
    st = (o.get("status") or "-")[:8]
    detail = (o.get("op_detail") or o.get("raw_event") or "-")[:12]
    ui = "-"
    nr = nearest(reloaded, dt)
    if nr:
        _, fields, d = nr
        ui = f"reload r={fields.get('disk_running','?')}@{d:.1f}s"
    else:
        ng = nearest(renders, dt)
        if ng:
            _, fields, d = ng
            ui = f"render r={fields.get('running','?')}@{d:.1f}s"
    snap = ""
    if snap_dir:
        cand = os.path.join(snap_dir, f"{o.get('rev')}-{o.get('digest')}.json")
        if os.path.isfile(cand):
            snap = " snap"
    print(
        f"{dt.strftime('%H:%M:%S'):8} {str(o.get('rev')):>5} {(o.get('op') or '-'):12} "
        f"{prev:8} {st:8} {cwd:7} {(o.get('digest') or '-'):8} {sid:10} {detail:12} {ui}{snap}"
    )

if rows:
    print()
    last = rows[-1][1]
    roster = last.get("roster") or []
    print(f"# last roster (rev={last.get('rev')} digest={last.get('digest')}):")
    for item in roster:
        print(f"  - {item}")
    if snap_dir:
        cand = os.path.join(snap_dir, f"{last.get('rev')}-{last.get('digest')}.json")
        if os.path.isfile(cand):
            print(f"# snapshot: {cand}")
PY
