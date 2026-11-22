#!/usr/bin/env bash
# Ship a committed wezdeck round: push, relay and web in parallel. Versions
# are source fingerprints (scripts/dev/source-fingerprint.sh): a part whose
# running version already equals its fingerprint is skipped, so a web-only
# round never restarts the relay (and drops phone links). A deploy that
# succeeds is done — the version check belongs before the tests
# (web/tests/version.setup.ts), not after the deploy.
#
#   scripts/dev/wezdeck-release.sh [--only push|relay|web]... [--force]
#
# Jobs (concurrent; logs under ~/.local/state/wezdeck/release/<stamp>/):
#   push   git push origin HEAD:master when HEAD is ahead
#   relay  build.sh, then restart wezdeck-relay unless the running process
#          already logged `event=connected version=<fingerprint>`
#   web    skipped when https://wezdeck.yuns.love/build.json already serves
#          the web fingerprint; else vite build with it as the build id +
#          wrangler deploy
# --force redeploys relay and web even when they look current.
# Refuses to run with uncommitted tracked changes (ship what is committed).
# Each run appends one summary row to ~/.local/state/wezdeck/release.log.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SITE="${WEZDECK_SITE:-https://wezdeck.yuns.love}"
UNIT=wezdeck-relay
STATE="$HOME/.local/state/wezdeck"
RUN="$STATE/release/$(date +%Y%m%d-%H%M%S)"
only=()
force=0
while (($#)); do
  case "$1" in
    --only) only+=("$2"); shift 2 ;;
    --force) force=1; shift ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
wanted() { ((${#only[@]} == 0)) || [[ " ${only[*]} " == *" $1 "* ]]; }

cd "$REPO" || exit 1
if ! git diff --quiet HEAD; then
  echo "release: uncommitted tracked changes — commit first (nothing shipped)" >&2
  exit 1
fi
[[ "$(git branch --show-current)" == master ]] || { echo "release: not on master" >&2; exit 1; }
mkdir -p "$RUN"
head="$(git rev-parse --short HEAD)"

# each job prints its last line as the result; exit 0 = verified or skipped
job_push() {
  local ahead
  ahead="$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 1)"
  if [[ "$ahead" == 0 ]]; then echo "skip: origin already at $head"; return 0; fi
  git push -q origin HEAD:master || return 1
  [[ "$(git rev-parse --short '@{u}')" == "$head" ]] || { echo "push: origin is not at $head"; return 1; }
  echo "ok: origin at $head"
}

relay_running_version() {
  local pid
  pid="$(systemctl --user show -p MainPID --value "$UNIT")"
  [[ -n "$pid" && "$pid" != 0 ]] || return 0
  journalctl --user -u "$UNIT" _PID="$pid" -o cat --no-pager 2>/dev/null |
    grep -o 'event=connected .*version=[^ ]*' | tail -1 | sed 's/.*version=//'
}

job_relay() {
  PATH="$HOME/.local/go/bin:$PATH" native/wezdeck-wsl/build.sh || return 1
  local want running
  want="$(cat native/wezdeck-wsl/bin/.version)"
  running="$(relay_running_version)"
  if [[ "$running" == "$want" && $force == 0 ]]; then
    echo "skip: relay already runs $want"
    return 0
  fi
  systemctl --user restart "$UNIT" || return 1
  systemctl --user is-active -q "$UNIT" || { echo "relay: $UNIT not active after restart"; return 1; }
  echo "ok: restarted relay with $want (was ${running:-?})"
}

deployed_build() {
  curl -fsS -m 10 -H 'cache-control: no-cache' "$SITE/build.json?t=$(date +%s%N)" 2>/dev/null |
    sed -n 's/.*"buildId":"\([^"]*\)".*/\1/p'
}

job_web() {
  local deployed want
  want="$(scripts/dev/source-fingerprint.sh web)"
  deployed="$(deployed_build)"
  if [[ $force == 0 && "$deployed" == "$want" ]]; then
    echo "skip: $SITE already serves $want"
    return 0
  fi
  (cd web && WEZDECK_BUILD_ID="$want" corepack pnpm exec vite build &&
    corepack pnpm exec wrangler deploy) || return 1
  echo "ok: deployed web $want (was ${deployed:-?})"
}

declare -A pids starts
for name in push relay web; do
  wanted "$name" || continue
  starts[$name]=$SECONDS
  ("job_$name" >"$RUN/$name.log" 2>&1) &
  pids[$name]=$!
done

failed=0
summary=()
for name in push relay web; do
  [[ -n "${pids[$name]:-}" ]] || continue
  if wait "${pids[$name]}"; then status=ok; else status=FAIL; failed=1; fi
  secs=$((SECONDS - starts[$name]))
  result="$(tail -1 "$RUN/$name.log")"
  printf '%-5s %-4s %3ss  %s\n' "$name" "$status" "$secs" "$result"
  [[ $status == FAIL ]] && sed 's/^/      /' "$RUN/$name.log" | tail -15
  summary+=("$name=$status/${secs}s")
done
printf '%s head=%s %s logs=%s\n' "$(date -Iseconds)" "$head" "${summary[*]}" "$RUN" >>"$STATE/release.log"
exit $failed
