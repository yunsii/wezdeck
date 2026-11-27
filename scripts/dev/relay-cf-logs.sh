#!/usr/bin/env bash
# Query Cloudflare Workers Observability logs for WezDeck Relay DO & Web Worker.
#
# Uses CLOUDFLARE_API_TOKEN (loaded via managed shell-env.d if unset) and
# resolves CLOUDFLARE_ACCOUNT_ID automatically when omitted.
#
# Examples:
#   scripts/dev/relay-cf-logs.sh                           # last 60m HostRelay DO events
#   scripts/dev/relay-cf-logs.sh --minutes 180 --summary   # event & close-code counts
#   scripts/dev/relay-cf-logs.sh --event host_closed       # filter by structured event
#   scripts/dev/relay-cf-logs.sh --service all --hours 2   # DO + web Worker combined
#   scripts/dev/relay-cf-logs.sh --json                    # raw normalized JSON lines
#
# See docs/remote-access.md.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/runtime-env-lib.sh"
runtime_env_load_managed 2>/dev/null || true

minutes=60
service='do' # do | web | all
event_filter=''
limit=100
mode='list' # list | summary | json
account_id="${CLOUDFLARE_ACCOUNT_ID:-}"
all_telemetry=0

while (( $# )); do
  case "$1" in
    --minutes)  minutes="${2:?missing minutes}"; shift 2 ;;
    --hours)    minutes="$(( ${2:?missing hours} * 60 ))"; shift 2 ;;
    --service)  service="${2:?missing service}"; shift 2 ;;
    --event)    event_filter="${2:?missing event}"; shift 2 ;;
    --limit)    limit="${2:?missing limit}"; shift 2 ;;
    --summary)  mode='summary'; shift ;;
    --json)     mode='json'; shift ;;
    --all-telemetry) all_telemetry=1; shift ;;
    --account)  account_id="${2:?missing account id}"; shift 2 ;;
    -h|--help)  sed -n '2,15p' "$0"; exit 0 ;;
    *) printf 'relay-cf-logs: unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

case "$service" in
  do|web|all) ;;
  *) printf 'relay-cf-logs: --service must be do|web|all\n' >&2; exit 2 ;;
esac

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  printf 'relay-cf-logs: CLOUDFLARE_API_TOKEN is empty (add it to ~/.config/shell-env.d/cloudflare.env)\n' >&2
  exit 1
fi

python3 - "$service" "$minutes" "$event_filter" "$limit" "$mode" "$account_id" "$all_telemetry" <<'PY'
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone

service_opt, minutes_s, event_filter, limit_s, mode, account_id, all_telemetry_s = sys.argv[1:]
minutes = int(minutes_s)
limit = int(limit_s)
all_telemetry = all_telemetry_s == "1"
token = os.environ["CLOUDFLARE_API_TOKEN"]
headers = {
    "Authorization": f"Bearer {token}",
    "Content-Type": "application/json",
    "User-Agent": "wezdeck-relay-cf-logs/1",
}


def cf_request(method: str, url: str, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")[:400]
        print(f"relay-cf-logs: HTTP {err.code} from {url}: {body}", file=sys.stderr)
        sys.exit(1)
    except Exception as err:
        print(f"relay-cf-logs: request failed ({url}): {err}", file=sys.stderr)
        sys.exit(1)


if not account_id:
    acct_resp = cf_request("GET", "https://api.cloudflare.com/client/v4/accounts?per_page=10")
    accounts = acct_resp.get("result") or []
    if not accounts:
        print("relay-cf-logs: could not resolve Cloudflare account id", file=sys.stderr)
        sys.exit(1)
    account_id = accounts[0]["id"]

services = {
    "do": ["wezdeck-relay-do"],
    "web": ["wezdeck"],
    "all": ["wezdeck-relay-do", "wezdeck"],
}[service_opt]

now_ms = int(time.time() * 1000)
from_ms = now_ms - minutes * 60 * 1000
query_url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/observability/telemetry/query"

rows = []
for svc in services:
    filters = [
        {"key": "$metadata.service", "operation": "eq", "type": "string", "value": svc},
    ]
    if not all_telemetry:
        filters.append({"key": "$metadata.type", "operation": "eq", "type": "string", "value": "cf-worker"})
    payload = {
        "queryId": f"wezdeck-{svc}-{now_ms}",
        "timeframe": {"from": from_ms, "to": now_ms},
        "view": "events",
        "limit": limit,
        "parameters": {"filters": filters},
    }
    resp = cf_request("POST", query_url, payload)
    events = (resp.get("result") or {}).get("events", {}).get("events") or []
    for ev in events:
        ts_ms = ev.get("timestamp") or 0
        meta = ev.get("$metadata") or {}
        src = ev.get("source")
        parsed = None
        if isinstance(src, dict):
            parsed = src
        elif isinstance(src, str):
            try:
                cand = json.loads(src)
                if isinstance(cand, dict):
                    parsed = cand
            except ValueError:
                pass
        ev_name = ""
        detail = {}
        if parsed and "event" in parsed:
            ev_name = str(parsed.get("event") or "")
            detail = {k: v for k, v in parsed.items() if k not in ("category", "event")}
        else:
            ev_name = str(meta.get("type") or meta.get("message") or "event")
            if isinstance(parsed, dict):
                detail = parsed
            elif meta.get("message"):
                detail = {"message": meta.get("message")}
        if event_filter and ev_name != event_filter:
            continue
        rows.append({
            "ts_ms": ts_ms,
            "at": datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S"),
            "service": svc,
            "event": ev_name,
            "detail": detail,
        })

rows.sort(key=lambda r: r["ts_ms"])
rows = rows[-limit:]

if mode == "json":
    for row in rows:
        print(json.dumps(row, ensure_ascii=False))
    sys.exit(0)

print(f"services={','.join(services)} window=last {minutes}m matched={len(rows)}")
if not rows:
    print("(no matching Cloudflare Worker observability events)")
    sys.exit(0)

if mode == "summary":
    counts = Counter((r["service"], r["event"]) for r in rows)
    codes = Counter(
        (r["event"], r["detail"].get("code"))
        for r in rows
        if r["event"] in ("host_closed", "client_closed") and "code" in r["detail"]
    )
    print(f"\n{'service':<18} {'event':<24} {'count':>6}")
    print(f"{'-'*18} {'-'*24} {'-'*6}")
    for (svc, ev_name), cnt in counts.most_common():
        print(f"{svc:<18} {ev_name:<24} {cnt:>6}")
    if codes:
        print("\nclose codes:")
        for (ev_name, code), cnt in codes.most_common():
            print(f"  {ev_name:<15} code={code:<6} count={cnt}")
    sys.exit(0)

print(f"\n{'time':<19} {'service':<16} {'event':<20} detail")
print(f"{'-'*19} {'-'*16} {'-'*20} {'-'*32}")
for r in rows:
    kv = " ".join(f"{k}={v}" for k, v in r["detail"].items())
    print(f"{r['at']:<19} {r['service']:<16} {r['event']:<20} {kv}")
PY
