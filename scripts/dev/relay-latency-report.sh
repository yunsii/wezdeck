#!/usr/bin/env bash
# Summarise Host Relay and local WSL bridge RPC latency from relay.log.
#
# Reads `event=rpc` (websocket/webrtc) and `event=bridge_rpc` (local) rows,
# plus threshold-gated `event=rpc_slow` / `event=bridge_rpc_slow` phase rows.
#
# Examples:
#   scripts/dev/relay-latency-report.sh                    # last 24h by action (p50/p95/max)
#   scripts/dev/relay-latency-report.sh --hours 6          # last 6h
#   scripts/dev/relay-latency-report.sh --days 7 --trend   # daily latency trend
#   scripts/dev/relay-latency-report.sh --via local        # local bridge only
#   scripts/dev/relay-latency-report.sh --action sessions  # single action
#   scripts/dev/relay-latency-report.sh --slow             # recent slow rows + phase breakdown
#   scripts/dev/relay-latency-report.sh --watch            # live tail of slow RPC rows
#   scripts/dev/relay-latency-report.sh --watch --all      # live tail of all RPC rows
#
# See docs/remote-access.md and docs/performance.md.
set -euo pipefail

default_log_file() {
  if [[ -n "${WEZDECK_RELAY_LOG_DIR:-}" ]]; then
    printf '%s/relay.log' "$WEZDECK_RELAY_LOG_DIR"
    return
  fi
  if [[ -n "${WEZDECK_WSL_SOCKET:-}" ]]; then
    printf '%s/logs/relay.log' "$(dirname "$WEZDECK_WSL_SOCKET")"
    return
  fi
  printf '%s/.local/state/wezterm-runtime/logs/relay.log' "$HOME"
}

log_file="$(default_log_file)"
hours=24
all_time=0
via_filter=''
action_filter=''
threshold_ms=500
sort_by='p95'
mode='summary' # summary | trend | slow | watch
slow_limit=40
watch_all=0

while (( $# )); do
  case "$1" in
    --hours)      hours="${2:?missing hours}"; all_time=0; shift 2 ;;
    --days)       hours="$(( ${2:?missing days} * 24 ))"; all_time=0; shift 2 ;;
    --all)        all_time=1; watch_all=1; shift ;;
    --via)        via_filter="${2:?missing via}"; shift 2 ;;
    --action)     action_filter="${2:?missing action}"; shift 2 ;;
    --threshold)  threshold_ms="${2:?missing threshold}"; shift 2 ;;
    --sort)       sort_by="${2:?missing sort key}"; shift 2 ;;
    --trend)      mode='trend'; shift ;;
    --slow)       mode='slow'; shift ;;
    --limit)      slow_limit="${2:?missing limit}"; shift 2 ;;
    --watch)      mode='watch'; shift ;;
    --log)        log_file="${2:?missing log path}"; shift 2 ;;
    -h|--help)    sed -n '2,18p' "$0"; exit 0 ;;
    *) printf 'relay-latency-report: unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

case "$sort_by" in
  p95|p50|max|count) ;;
  *) printf 'relay-latency-report: --sort must be p95|p50|max|count\n' >&2; exit 2 ;;
esac

if [[ ! -f "$log_file" ]]; then
  printf 'relay-latency-report: log file not found: %s\n' "$log_file" >&2
  exit 1
fi

if [[ "$mode" == "watch" ]]; then
  if (( watch_all )); then
    printf 'watching %s for rpc / bridge_rpc rows…\n' "$log_file"
  else
    printf 'watching %s for slow RPC rows (rpc_slow / bridge_rpc_slow / ms>=%s)…\n' "$log_file" "$threshold_ms"
  fi
  tail -n0 -F "$log_file" 2>/dev/null | while IFS= read -r line; do
    [[ "$line" == *'category=relay '* ]] || continue
    if (( watch_all )); then
      [[ "$line" == *'event=rpc '* || "$line" == *'event=bridge_rpc '* || "$line" == *'event=rpc_slow '* || "$line" == *'event=bridge_rpc_slow '* ]] || continue
    else
      if [[ "$line" != *'event=rpc_slow '* && "$line" != *'event=bridge_rpc_slow '* ]]; then
        continue
      fi
    fi
    if [[ -n "$via_filter" && "$line" != *"via=${via_filter} "* ]]; then
      continue
    fi
    if [[ -n "$action_filter" && "$line" != *"action=\"${action_filter}\""* ]]; then
      continue
    fi
    printf '%s\n' "$line"
  done
  exit 0
fi

python3 - "$log_file" "$mode" "$hours" "$all_time" "$via_filter" "$action_filter" "$threshold_ms" "$sort_by" "$slow_limit" <<'PY'
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

log_file, mode, hours_s, all_time_s, via_filter, action_filter, thresh_s, sort_by, slow_limit_s = sys.argv[1:]
hours = int(hours_s)
all_time = all_time_s == "1"
threshold_ms = int(thresh_s)
slow_limit = int(slow_limit_s)

now = datetime.now(timezone.utc)
cutoff = None if all_time else (now - timedelta(hours=hours))

LINE_RE = re.compile(
    r'^(\S+)\s+category=relay\s+event=(rpc|bridge_rpc|rpc_slow|bridge_rpc_slow)\s+'
    r'via=(\S+)\s+action="([^"]+)"\s+ok=(true|false)\s+ms=(\d+)(.*)$'
)
PHASE_RE = re.compile(r'\b([a-z_]+_ms=\d+)')


def parse_ts(raw: str):
    try:
        # Python 3.11+ handles RFC3339Nano, trim >6 fractional digits for 3.10 compat
        if '.' in raw:
            head, rest = raw.split('.', 1)
            tz_idx = max(rest.find('Z'), rest.find('+'), rest.find('-'))
            if tz_idx > 6:
                rest = rest[:6] + rest[tz_idx:]
            raw = f"{head}.{rest}"
        if raw.endswith('Z'):
            raw = raw[:-1] + '+00:00'
        dt = datetime.fromisoformat(raw)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def pct(vals, p):
    if not vals:
        return 0
    s = sorted(vals)
    idx = min(len(s) - 1, int((len(s) - 1) * p))
    return s[idx]


rpc_rows = []
slow_rows = []

with open(log_file, 'r', encoding='utf-8', errors='replace') as fh:
    for line in fh:
        if 'category=relay ' not in line:
            continue
        m = LINE_RE.match(line)
        if not m:
            continue
        ts_raw, event, via, action, ok_s, ms_s, tail = m.groups()
        if via_filter and via != via_filter:
            continue
        if action_filter and action != action_filter:
            continue
        dt = parse_ts(ts_raw)
        if dt is None:
            continue
        if cutoff is not None and dt < cutoff:
            continue
        ms = int(ms_s)
        ok = ok_s == 'true'
        if event in ('rpc', 'bridge_rpc'):
            rpc_rows.append((dt, ts_raw, via, action, ok, ms))
            if mode == 'slow' and ms >= threshold_ms:
                slow_rows.append((dt, ts_raw, event, via, action, ok, ms, ''))
        else:
            phases = ' '.join(PHASE_RE.findall(tail))
            slow_rows.append((dt, ts_raw, event, via, action, ok, ms, phases))

window_label = "all time" if all_time else f"last {hours}h"
print(f"source={log_file}")
print(f"window={window_label} threshold_ms={threshold_ms}"
      + (f" via={via_filter}" if via_filter else "")
      + (f" action={action_filter}" if action_filter else ""))
print()

if mode == 'slow':
    # Prefer explicit rpc_slow/bridge_rpc_slow when present for the same timestamp+action
    dedup = {}
    for row in slow_rows:
        dt, ts_raw, event, via, action, ok, ms, phases = row
        key = (ts_raw[:19], via, action, ms)
        if key not in dedup or event.endswith('_slow'):
            dedup[key] = row
    ordered = sorted(dedup.values(), key=lambda r: r[0])[-slow_limit:]
    if not ordered:
        print(f"(no slow RPC rows >= {threshold_ms} ms)")
        sys.exit(0)
    print(f"{'timestamp':<25} {'via':<9} {'ms':>6}  {'ok':<5} {'action':<24} phases")
    print(f"{'-'*25} {'-'*9} {'-'*6}  {'-'*5} {'-'*24} {'-'*24}")
    for _, ts_raw, _, via, action, ok, ms, phases in ordered:
        print(f"{ts_raw[:25]:<25} {via:<9} {ms:>6}  {str(ok).lower():<5} {action:<24} {phases}")
    sys.exit(0)

if not rpc_rows:
    print("(no matching RPC rows)")
    sys.exit(0)

if mode == 'trend':
    by_day = defaultdict(list)
    for dt, _, _, _, ok, ms in rpc_rows:
        day = dt.astimezone().strftime('%Y-%m-%d')
        by_day[day].append((ms, ok))
    print(f"{'day':<10} {'n':>6} {'p50':>7} {'p95':>7} {'max':>7} {'slow':>6} {'err':>5}  (ms)")
    print(f"{'-'*10} {'-'*6} {'-'*7} {'-'*7} {'-'*7} {'-'*6} {'-'*5}")
    for day in sorted(by_day):
        items = by_day[day]
        vals = [x[0] for x in items]
        slow_n = sum(1 for v in vals if v >= threshold_ms)
        err_n = sum(1 for _, ok in items if not ok)
        print(f"{day:<10} {len(vals):>6} {pct(vals, 0.50):>7} {pct(vals, 0.95):>7} {max(vals):>7} {slow_n:>6} {err_n:>5}")
    sys.exit(0)

# Summary mode: by action + by via
by_action = defaultdict(list)
by_via = defaultdict(list)
for _, _, via, action, ok, ms in rpc_rows:
    by_action[action].append((ms, ok))
    by_via[via].append((ms, ok))

rows_out = []
for action, items in by_action.items():
    vals = [x[0] for x in items]
    p50 = pct(vals, 0.50)
    p95 = pct(vals, 0.95)
    mx = max(vals)
    slow_n = sum(1 for v in vals if v >= threshold_ms)
    err_n = sum(1 for _, ok in items if not ok)
    rows_out.append((action, len(vals), p50, p95, mx, slow_n, err_n))

key_index = {'count': 1, 'p50': 2, 'p95': 3, 'max': 4}[sort_by]
rows_out.sort(key=lambda r: (r[key_index], r[1]), reverse=True)

print(f"{'action':<28} {'n':>6} {'p50':>7} {'p95':>7} {'max':>7} {'slow':>6} {'err':>5}  (ms)")
print(f"{'-'*28} {'-'*6} {'-'*7} {'-'*7} {'-'*7} {'-'*6} {'-'*5}")
for action, n, p50, p95, mx, slow_n, err_n in rows_out:
    print(f"{action:<28} {n:>6} {p50:>7} {p95:>7} {mx:>7} {slow_n:>6} {err_n:>5}")

print("\nby transport (via):")
print(f"  {'via':<12} {'n':>6} {'p50':>7} {'p95':>7} {'max':>7} {'slow':>6} {'err':>5}  (ms)")
for via in sorted(by_via):
    items = by_via[via]
    vals = [x[0] for x in items]
    slow_n = sum(1 for v in vals if v >= threshold_ms)
    err_n = sum(1 for _, ok in items if not ok)
    print(f"  {via:<12} {len(vals):>6} {pct(vals, 0.50):>7} {pct(vals, 0.95):>7} {max(vals):>7} {slow_n:>6} {err_n:>5}")
PY
