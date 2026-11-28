#!/usr/bin/env bash
# Shared state, coalescing queue, live canary and rollback helpers for
# scripts/dev/wezdeck-release.sh.

release_state_file() {
  echo "${STATE}/release/state.json"
}

release_state_update() {
  local mode="$1"
  shift
  local file
  file="$(release_state_file)"
  mkdir -p "$(dirname "$file")"
  (
    flock -x 9
    python3 - "$file" "$mode" "$@" <<'PY'
import json, os, sys, tempfile, time

path, mode, *args = sys.argv[1:]
try:
    with open(path, "r", encoding="utf-8") as f:
        st = json.load(f)
    if not isinstance(st, dict):
        st = {}
except Exception:
    st = {}

now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
st.setdefault("pending_commits", [])

def parse_kv(items):
    out = {}
    for item in items:
        if "=" in item:
            k, v = item.split("=", 1)
            out[k] = v
    return out

if mode == "enqueue":
    sha, short, subject = args[0], args[1], args[2]
    st["desired_sha"] = sha
    st["desired_at"] = now
    if st.get("failed_sha") and st.get("failed_sha") != sha:
        st["failed_sha"] = ""
        st["last_error"] = ""
    pending = [c for c in st.get("pending_commits", []) if c.get("sha") != sha]
    pending.append({"sha": sha, "short": short, "subject": subject, "at": now})
    st["pending_commits"] = pending[-30:]
elif mode == "phase":
    kv = parse_kv(args)
    st["phase"] = kv.get("phase", st.get("phase", "idle"))
    st["updated_at"] = now
    for k in ("deploying_sha", "deploying_short", "batch_count", "batch_summary", "run_dir", "coordinator_pid"):
        if k in kv:
            st[k] = int(kv[k]) if k in ("batch_count", "coordinator_pid") and kv[k].isdigit() else kv[k]
elif mode == "deployed":
    kv = parse_kv(args)
    sha = kv.get("sha", "")
    st["phase"] = "idle"
    st["deployed_sha"] = sha
    st["last_good_sha"] = sha
    st["deployed_at"] = now
    st["deploying_sha"] = ""
    st["deploying_short"] = ""
    st["failed_sha"] = ""
    st["last_error"] = ""
    if kv.get("web_fp"):
        st["deployed_web_fp"] = kv["web_fp"]
    if kv.get("relay_fp"):
        st["deployed_relay_fp"] = kv["relay_fp"]
    if kv.get("relay_do_fp"):
        st["deployed_relay_do_fp"] = kv["relay_do_fp"]
    if kv.get("run_dir"):
        st["last_run_dir"] = kv["run_dir"]
    # Keep only commits that arrived after this deployed SHA (handled via desired_sha check)
    if st.get("desired_sha") == sha:
        st["pending_commits"] = []
    else:
        st["pending_commits"] = [c for c in st.get("pending_commits", []) if c.get("sha") != sha]
elif mode == "failed":
    kv = parse_kv(args)
    st["phase"] = kv.get("phase", "failed")
    st["failed_sha"] = kv.get("sha", "")
    st["last_error"] = kv.get("error", "")
    st["failed_at"] = now
    st["deploying_sha"] = ""
    if kv.get("run_dir"):
        st["last_run_dir"] = kv["run_dir"]
elif mode == "verified":
    kv = parse_kv(args)
    sha = kv.get("sha", "")
    current = st.get("verifying_sha") or st.get("verified_sha")
    if not current or current == sha:
        st["verified_sha"] = sha
        st["verify_status"] = kv.get("status", "")
        st["verified_at"] = now
        st["verify_log"] = kv.get("log", "")
        st["verifying_sha"] = ""
        st["verify_unit"] = ""
elif mode == "verifying":
    kv = parse_kv(args)
    st["verifying_sha"] = kv.get("sha", "")
    st["verify_unit"] = kv.get("unit", "")
    st["verify_log"] = kv.get("log", "")
    st["verify_started_at"] = now
elif mode == "verify_lost":
    kv = parse_kv(args)
    sha = kv.get("sha", "")
    if st.get("verifying_sha") == sha:
        st["verified_sha"] = sha
        st["verify_status"] = "FAIL"
        st["verified_at"] = now
        st["verify_log"] = kv.get("log", "")
        st["verifying_sha"] = ""
        st["verify_unit"] = ""

st["updated_at"] = now
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".state-", suffix=".tmp")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
PY
  ) 9>>"$file.lock"
}

release_state_get() {
  local key="$1"
  local file
  file="$(release_state_file)"
  [[ -f "$file" ]] || return 0
  python3 - "$file" "$key" <<'PY'
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        st = json.load(f)
    v = st.get(sys.argv[2], "")
    print("" if v is None else v)
except Exception:
    pass
PY
}

release_print_status() {
  local file
  file="$(release_state_file)"
  local live_web live_relay
  live_web="$(deployed_build 2>/dev/null || true)"
  live_relay="$(relay_running_version 2>/dev/null || true)"
  python3 - "$file" "$live_web" "$live_relay" <<'PY'
import json, sys
path, live_web, live_relay = sys.argv[1:4]
try:
    with open(path, "r", encoding="utf-8") as f:
        st = json.load(f)
except Exception:
    st = {}
print(f"phase:          {st.get('phase', 'idle')}")
print(f"desired_sha:    {(st.get('desired_sha') or '-')[:12]}")
print(f"deploying_sha:  {(st.get('deploying_sha') or '-')[:12]}")
print(f"deployed_sha:   {(st.get('deployed_sha') or '-')[:12]} ({st.get('deployed_at') or '-'})")
print(f"live_web:       {live_web or '-'}")
print(f"live_relay:     {live_relay or '-'}")
if st.get("failed_sha"):
    print(f"failed_sha:     {st['failed_sha'][:12]} ({st.get('last_error') or 'failed'})")
if st.get("verify_status"):
    print(f"last_verify:    {st['verify_status']} @ {(st.get('verified_sha') or '-')[:12]} ({st.get('verified_at') or '-'})")
if st.get("verifying_sha"):
    print(f"verifying:      {st['verifying_sha'][:12]} ({st.get('verify_started_at') or '-'})")
    print(f"verify_log:     {st.get('verify_log') or '-'}")
pending = st.get("pending_commits") or []
if pending:
    print(f"pending ({len(pending)}):")
    for c in pending:
        print(f"  - {c.get('short', c.get('sha', '')[:8])} {c.get('subject', '')}")
PY
}

release_reconcile_verify() {
  local sha unit log started now active
  sha="$(release_state_get verifying_sha)"
  unit="$(release_state_get verify_unit)"
  [[ -n "$sha" && -n "$unit" ]] || return 0
  if active="$(systemctl --user show "$unit" -p ActiveState --value 2>/dev/null)"; then
    case "$active" in
      inactive|failed) ;;
      *) return 0 ;;
    esac
  else
    systemctl --user show-environment >/dev/null 2>&1 || return 0
  fi
  started="$(date -d "$(release_state_get verify_started_at)" +%s 2>/dev/null || echo 0)"
  now="$(date +%s)"
  ((now - started >= 15)) || return 0
  log="$(release_state_get verify_log)"
  release_state_update verify_lost "sha=$sha" "log=$log"
  if [[ "$(release_state_get verified_sha)" == "$sha" && "$(release_state_get verify_status)" == FAIL ]]; then
    printf '%s event=verify_done head=%s status=FAIL reason=service_exited log=%s\n' \
      "$(date -Iseconds)" "${sha:0:8}" "$log" >>"$STATE/release.log"
  fi
}

# Read the HostRelay client token, preferring the on-disk env file over
# inherited shell variables so long-lived agent shells never probe with a
# pre-rotation token. Strips optional `export `, quotes, and CR.
release_read_relay_token() {
  local env_file="${WEZDECK_REMOTE_ENV:-$HOME/.config/shell-env.d/wezdeck-remote.env}"
  local raw=''
  if [[ -f "$env_file" ]]; then
    raw="$(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?WEZDECK_RELAY_CLIENT_TOKEN=//p' "$env_file" | tail -1)"
    raw="${raw%$'\r'}"
    raw="${raw#"${raw%%[![:space:]]*}"}"
    raw="${raw%"${raw##*[![:space:]]}"}"
    if [[ "$raw" == \"*\" && "$raw" == *\" ]]; then
      raw="${raw:1:${#raw}-2}"
    elif [[ "$raw" == \'*\' && "$raw" == *\' ]]; then
      raw="${raw:1:${#raw}-2}"
    fi
  fi
  if [[ -z "$raw" ]]; then
    raw="${WEZDECK_RELAY_CLIENT_TOKEN:-${RELAY_CLIENT_TOKEN:-}}"
  fi
  printf '%s' "$raw"
}

# Post-deploy live canary: confirms the public Cloudflare site actually serves
# the new buildId, HTML shell, entry JS bundle, and HostRelay /relay/health gate.
# Bounded retries absorb Cloudflare edge/asset propagation delays (5-15 s) while
# exiting immediately on first healthy response so fast deploys add no overhead.
release_live_canary() {
  local site="$1" want="$2" i served html script asset_code relay_code relay_token
  local build_attempts="${WEZDECK_CANARY_BUILD_ATTEMPTS:-20}"
  local asset_attempts="${WEZDECK_CANARY_ASSET_ATTEMPTS:-6}"
  local relay_attempts="${WEZDECK_CANARY_RELAY_ATTEMPTS:-5}"
  local sleep_s="${WEZDECK_CANARY_SLEEP_S:-1}"

  served=''
  for ((i = 1; i <= build_attempts; i++)); do
    served="$(curl -fsS -m 8 -H 'cache-control: no-cache' "$site/build.json?t=$(date +%s%N)" 2>/dev/null |
      sed -nE 's/.*"buildId"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p')"
    [[ "$served" == "$want" ]] && break
    ((i < build_attempts)) && sleep "$sleep_s"
  done
  if [[ "$served" != "$want" ]]; then
    echo "canary: $site/build.json returned '${served:-empty}', expected '$want' after ${build_attempts} attempt(s)" >&2
    return 1
  fi

  script=''
  asset_code='000'
  for ((i = 1; i <= asset_attempts; i++)); do
    html="$(curl -fsS --compressed -m 10 -H 'cache-control: no-cache' "$site/zh/console/sessions?t=$(date +%s%N)" 2>/dev/null | tr -d '\0')" || html=''
    script="$(grep -ao '/assets/[^"]*\.js' <<<"$html" | head -1)"
    if [[ -n "$script" ]]; then
      asset_code="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -H 'cache-control: no-cache' "$site$script" 2>/dev/null || echo 000)"
      [[ "$asset_code" == 200 ]] && break
    else
      asset_code='no-script'
    fi
    ((i < asset_attempts)) && sleep "$sleep_s"
  done
  if [[ -z "$script" || "$asset_code" != 200 ]]; then
    echo "canary: entry JS '${script:-missing}' returned HTTP $asset_code on $site after ${asset_attempts} attempt(s)" >&2
    return 1
  fi

  # /relay/health is authenticated before DO lookup: 200 with a valid client
  # token, 401 without one (never 404/5xx).
  relay_token="$(release_read_relay_token)"
  relay_code='000'
  for ((i = 1; i <= relay_attempts; i++)); do
    if [[ -n "$relay_token" ]]; then
      relay_code="$(curl -sS -m 8 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $relay_token" "$site/relay/health" 2>/dev/null || echo 000)"
      [[ "$relay_code" == 200 ]] && break
    else
      relay_code="$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "$site/relay/health" 2>/dev/null || echo 000)"
      [[ "$relay_code" == 401 || "$relay_code" == 200 ]] && break
    fi
    ((i < relay_attempts)) && sleep "$sleep_s"
  done
  if [[ -n "$relay_token" ]]; then
    if [[ "$relay_code" != 200 ]]; then
      echo "canary: $site/relay/health returned HTTP $relay_code (expected 200) after ${relay_attempts} attempt(s)" >&2
      return 1
    fi
  else
    if [[ "$relay_code" != 401 && "$relay_code" != 200 ]]; then
      echo "canary: $site/relay/health returned HTTP $relay_code (expected 401/200) after ${relay_attempts} attempt(s)" >&2
      return 1
    fi
  fi
  echo "ok: live canary healthy ($want, entry $script, relay HTTP $relay_code)"
}

release_rollback_web() {
  (cd "$REPO/web" && corepack pnpm exec wrangler rollback --yes)
}

release_rollback_relay() {
  local prev="$STATE/release/wezdeck-wsl.prev"
  local cur="$REPO/native/wezdeck-wsl/bin/wezdeck-wsl"
  [[ -x "$prev" ]] || { echo "rollback: no previous relay binary at $prev" >&2; return 1; }
  cp -f "$prev" "$cur"
  systemctl --user restart "$UNIT"
  systemctl --user is-active -q "$UNIT"
}
