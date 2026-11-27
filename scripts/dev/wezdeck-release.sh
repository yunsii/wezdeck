#!/usr/bin/env bash
# Ship a committed wezdeck round: push first, then deploy relay and web. Versions
# are source fingerprints (scripts/dev/source-fingerprint.sh): a part whose
# running version already equals its fingerprint is skipped, so a web-only
# round never restarts the relay (and drops web console links). A deploy that
# succeeds is done — the version check belongs before the tests
# (web/tests/version.setup.ts), not after the deploy.
#
# After the reload, scripts/dev/device-check.sh confirms the person's pages
# (phones and the host's own browser) run the new build before any retest.
#
#   scripts/dev/wezdeck-release.sh [--land COMMIT | --commit MSGFILE] [--only push|relay|web]... [--force] [--gate | --no-test] [--no-reload]
#
# --land COMMIT integrates a committed worktree tip on the primary master.
# A repository-wide lock covers integration, push, deployment and the linked
# source worktree's final recycle after a fully successful release.
#
# --commit MSGFILE commits the staged changes first, after fixing what the
# pre-commit gate only reports: prettier on the staged web files and the
# i18n catalogs (`lingui extract`: line refs move with the code). Both used
# to fail a commit and cost a round trip. Lint / type errors still fail it.
# Everything to ship must be staged (no unstaged tracked edits): the web is
# built from the working tree, so it would ship code the commit lacks.
#
# Tests: scripts/dev/web-affected-tests.sh --base <upstream before the push>
# --run — the go / unit / cdp tests the unpushed commits can break, cdp on
# the local test stack. They run alongside push / relay / web (a failure is
# fixed next round, not a reason to hold the deploy): the release still ships,
# reports ✗ test last and exits 3. --gate runs them first and ships nothing
# on a failure (the old order: ~40–100 s before anything moves); --no-test
# skips them.
#
# Shared builds first (build): the relay binary (build.sh) and web/dist
# (vite, build id = web source fingerprint), each skipped when current. The
# test stack, the relay job and the web job all reuse them — run in parallel,
# each would otherwise build into the same output at once.
#
# After a web deploy, every web console seen in the last 3 min is moved onto the new
# build: `wezdeck-wsl diag --reload` (the page answers, then reloads; a draft
# survives). Retried while no web console is known yet — a relay restarted in the
# same release forgets them until they reconnect. --no-reload skips it.
#
# Jobs (deployments run after the push; logs under ~/.local/state/wezdeck/release/<stamp>/):
#   push   git push origin HEAD:master when HEAD is ahead
#   relay  build.sh, then restart wezdeck-relay unless the running process
#          already logged `event=connected version=<fingerprint>`
#   web    skipped when https://wezdeck.yuns.love/build.json already serves
#          the web fingerprint; else vite build with it as the build id
#          (skipped when web/dist already carries it — the test gate's stack
#          just built it) + wrangler deploy
# --force redeploys relay and web even when they look current.
# WEZDECK_RELEASE_LOCK_WAIT bounds lock contention in seconds (default 300).
# Refuses to run with uncommitted tracked changes (ship what is committed).
# Each run appends one summary row to ~/.local/state/wezdeck/release.log.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SITE="${WEZDECK_SITE:-https://wezdeck.yuns.love}"
UNIT=wezdeck-relay
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/wezdeck"
only=()
force=0
test_mode=parallel # parallel | gate | off
reload_clients=1
commit_msg=''
land_commit=''
release_args=()
while (($#)); do
  case "$1" in
    --commit|--land|--only)
      [[ $# -ge 2 && -n "$2" ]] || { echo "release: $1 requires a value" >&2; exit 2; }
      case "$1" in
        --commit) commit_msg="$2"; release_args+=("$1" "$2") ;;
        --land)
          land_commit="$(git -C "$REPO" rev-parse --verify --end-of-options "$2^{commit}")" || exit 2
          release_args+=("$1" "$land_commit")
          ;;
        --only)
          case "$2" in push|relay|web) ;; *) echo "release: invalid job $2" >&2; exit 2 ;; esac
          only+=("$2"); release_args+=("$1" "$2")
          ;;
      esac
      shift 2
      ;;
    --force) force=1; release_args+=("$1"); shift ;;
    --no-test) test_mode=off; release_args+=("$1"); shift ;;
    --gate) test_mode=gate; release_args+=("$1"); shift ;;
    --no-reload) reload_clients=0; release_args+=("$1"); shift ;;
    -h | --help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
wanted() { ((${#only[@]} == 0)) || [[ " ${only[*]} " == *" $1 "* ]]; }

cd "$REPO" || exit 1

# Validate catalogs even when the caller committed before invoking release.
# The --commit path can refresh them before commit, but release must still
# reject an already-committed web build with missing translations.
if ! (cd web && corepack pnpm run -s i18n:check >/dev/null); then
  echo "release: i18n catalogs are missing or out of sync" >&2
  exit 1
fi

if [[ -n "$land_commit" ]]; then
  if [[ -n "$commit_msg" ]] || ! wanted push; then
    echo 'release: --land requires push and cannot be combined with --commit' >&2
    exit 2
  fi
  primary=''
  IFS= read -r -d '' primary < <(git worktree list --porcelain -z)
  primary="${primary#worktree }"
  [[ -n "$primary" ]] || exit 1
  if [[ "$primary" != "$REPO" ]]; then
    exec env WEZDECK_RELEASE_LAND_SOURCE="$REPO" \
      bash "$primary/scripts/dev/wezdeck-release.sh" "${release_args[@]}"
  fi
fi

common_dir="$(git rev-parse --path-format=absolute --git-common-dir)" || exit 1
exec 8>>"$common_dir/wezdeck-release.lock" || exit 1
if ! flock -n 8; then
  lock_wait="${WEZDECK_RELEASE_LOCK_WAIT:-300}"
  echo "release: another release is running, waiting up to ${lock_wait}s" >&2
  flock -w "$lock_wait" 8 || exit 75
fi
[[ "$(git branch --show-current)" == master ]] || { echo 'release: use --land COMMIT or run on master' >&2; exit 1; }
for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply sequencer; do
  if [[ -e "$(git rev-parse --git-path "$marker")" ]]; then
    echo "release: finish the Git operation on master first ($marker)" >&2
    exit 1
  fi
done

# the mechanical half of the pre-commit gate, applied instead of reported
autofix_staged() {
  local staged=() rel=()
  mapfile -t staged < <(git diff --cached --name-only --diff-filter=ACMR -- web/)
  ((${#staged[@]})) || return 0
  for f in "${staged[@]}"; do rel+=("${f#web/}"); done
  (cd web && corepack pnpm exec prettier --write --ignore-unknown --log-level warn "${rel[@]}") || return 1
  git add -- "${staged[@]}"
  if printf '%s\n' "${staged[@]}" | grep -q '^web/src/'; then
    (cd web && corepack pnpm run -s i18n:extract >/dev/null) || return 1
    git add -- web/src/locales
  fi
}

if [[ -n "$commit_msg" ]]; then
  [[ -f "$commit_msg" ]] || { echo "release: no message file $commit_msg" >&2; exit 2; }
  if ! git diff --quiet; then
    echo "release: unstaged tracked changes — stage everything to ship (nothing committed)" >&2
    git diff --name-only | sed 's/^/  /' >&2
    exit 1
  fi
  git diff --cached --quiet && { echo "release: nothing staged to commit" >&2; exit 1; }
  autofix_staged || { echo "release: auto-fix failed (nothing committed)" >&2; exit 1; }
  before="$(git rev-parse HEAD)"
  git commit -q -F "$commit_msg" || true
  if [[ "$(git rev-parse HEAD)" == "$before" ]]; then
    echo "release: commit refused by the pre-commit gate (above); nothing shipped" >&2
    exit 1
  fi
  echo "release: committed $(git log -1 --format='%h %s')"
fi

checkout_clean() {
  local status
  status="$(git status --porcelain --untracked-files=normal)" && [[ -z "$status" ]]
}
if ! checkout_clean; then
  echo 'release: master checkout must be clean before integration' >&2
  exit 1
fi
mkdir -p "$STATE/release" || exit 1
run_root="$(mktemp -d "$STATE/release/$(date +%Y%m%d-%H%M%S).XXXXXX")" || exit 1
RUN="$run_root"

# Live progress, like `coco-cli cmdb` deploy watch: one line per step change,
# `[mm:ss] glyph step  what`, and a heartbeat when a step is quiet for 10 s.
# A job marks its phases with `phase TEXT` (a `::phase::` line in its log);
# selected tool output (vite's "built in", wrangler's uploads / deploy) is
# turned into phase lines too. It used to print nothing until every job was
# done: the release was a silent ~45 s wait.
T0=$SECONDS
clock() { printf '%02d:%02d' $(((SECONDS - T0) / 60)) $(((SECONDS - T0) % 60)); }
say() { printf '[%s] %s %-5s %s\n' "$(clock)" "$1" "$2" "$3"; }
phase() { echo "::phase:: $*"; }
# the progress lines a job's log gained since `from` (line number)
progress_lines() {
  sed -n "$(($2 + 1)),\$p" "$1" 2>/dev/null | sed -nE \
    -e 's/^::phase:: (.*)$/\1/p' \
    -e 's/.*✓ built in ([0-9.]+[a-z]+).*/built in \1/p' \
    -e 's/.*Found ([0-9]+) new or modified static assets.*/uploading \1 changed assets/p' \
    -e 's/.*Uploaded ([0-9]+) of ([0-9]+) assets.*/uploaded \1\/\2 assets/p' \
    -e 's/.*No updated asset files to upload.*/no asset changes to upload/p' \
    -e 's/.*Uploaded .* \(([0-9.]+ sec)\).*/worker uploaded (\1)/p' \
    -e 's/.*Deployed .* triggers \(([0-9.]+ sec)\).*/deployed (\1)/p' \
    -e 's/^(cdp|go|unit): (.*)$/plan \1: \2/p' \
    -e 's/.*Test Files +(.*)$/tests: \1/p'
}
# Background jobs: name → pid in `pids`, log `$RUN/<name>.log`, last log
# line = its result. watch_until streams every started job's progress and
# prints each one's ✓/✗ line with its own duration the moment it exits (exit
# status / seconds into `rcs` / `durs`), returning once the named jobs are
# done; the others keep running and are picked up by a later call.
declare -A pids starts rcs durs seen quiet
jobs_all=()
start_job() { # NAME DESCRIPTION FUNCTION
  starts[$1]=$SECONDS seen[$1]=0 quiet[$1]=$SECONDS
  say '▶' "$1" "$2"
  ("$3" >"$RUN/$1.log" 2>&1) &
  pids[$1]=$!
  jobs_all+=("$1")
}
watch_until() {
  local name n line rc pending=1
  while ((pending)); do
    for name in "${jobs_all[@]}"; do
      [[ -n "${rcs[$name]:-}" ]] && continue
      n="$(wc -l <"$RUN/$name.log" 2>/dev/null || echo 0)"
      if ((n > seen[$name])); then
        while IFS= read -r line; do
          [[ -n "$line" ]] && say '·' "$name" "$line"
        done < <(progress_lines "$RUN/$name.log" "${seen[$name]}")
        seen[$name]=$n
        quiet[$name]=$SECONDS
      fi
      if kill -0 "${pids[$name]}" 2>/dev/null; then
        if ((SECONDS - quiet[$name] >= 10)); then
          say '…' "$name" "still running ($((SECONDS - starts[$name]))s)"
          quiet[$name]=$SECONDS
        fi
      else
        rc=0; wait "${pids[$name]}" || rc=$?
        rcs[$name]=$rc
        durs[$name]=$((SECONDS - starts[$name]))
        say "$( ((rc == 0)) && echo '✓' || echo '✗')" "$name" "$(tail -1 "$RUN/$name.log") (${durs[$name]}s)"
        ((rc == 0)) || sed 's/^/      /' "$RUN/$name.log" | tail -30
      fi
    done
    pending=0
    for name in "$@"; do [[ -z "${rcs[$name]:-}" ]] && pending=1; done
    ((pending)) && sleep 1
  done
  return 0
}

fetch_master() {
  git fetch -q origin refs/heads/master:refs/remotes/origin/master
}
merge_release_input() {
  local input="$1"
  if git merge --no-edit "$input"; then return 0; fi
  if git rev-parse --verify -q MERGE_HEAD >/dev/null; then
    git merge --abort || return 1
  fi
  echo "release: merge failed for $input. Resolve against origin/master in the task worktree." >&2
  return 1
}
prepare_release() {
  checkout_clean || return 1
  fetch_master || return 1
  test_base="$(git rev-parse refs/remotes/origin/master)" || return 1
  if wanted push; then
    merge_release_input "$test_base" || return 1
    if [[ -n "$land_commit" ]]; then
      merge_release_input "$land_commit" || return 1
    fi
  else
    git merge --ff-only "$test_base" || return 1
    if [[ "$(git rev-parse HEAD)" != "$test_base" ]]; then
      echo 'release: deploy-only requires the local commit to match origin/master' >&2
      return 1
    fi
  fi
  release_commit="$(git rev-parse HEAD)" || return 1
  head="$(git rev-parse --short "$release_commit")" || return 1
  checkout_clean
}

job_test() {
  scripts/dev/web-affected-tests.sh --base "$test_base" --run || {
    echo "FAIL: affected tests (log $RUN/test.log)"
    return 1
  }
  echo "ok: $(grep -m1 '^cdp:' "$RUN/test.log" | sed 's/^cdp: *//')"
}
job_build() {
  if wanted relay || [[ $test_mode != off ]]; then
    phase "relay binary (skipped when current)"
    PATH="$HOME/.local/go/bin:$PATH" native/wezdeck-wsl/build.sh || return 1
  fi
  if wanted web || [[ $test_mode != off ]]; then
    local want built
    want="$(scripts/dev/source-fingerprint.sh web)"
    built="$(sed -n 's/.*"buildId":"\([^"]*\)".*/\1/p' web/dist/client/build.json 2>/dev/null)"
    if [[ "$built" != "$want" || $force == 1 ]]; then
      phase "vite build $want"
      (cd web && WEZDECK_BUILD_ID="$want" corepack pnpm exec vite build) || return 1
    else
      phase "web/dist already at $want"
    fi
  fi
  echo "ok: builds current"
}
# Use the tested commit for the push, including when retrying deployment.
job_push() {
  local advertised
  if [[ "$(git rev-parse HEAD)" != "$release_commit" ]] || ! checkout_clean; then
    echo "release: checkout changed during build"
    return 1
  fi
  if wanted push && [[ "$test_base" != "$release_commit" ]]; then
    phase "pushing $head"
    git push -q origin "$release_commit:refs/heads/master" || return 1
  fi
  advertised="$(git ls-remote --exit-code origin refs/heads/master)" || return 1
  if [[ "${advertised%%$'\t'*}" != "$release_commit" ]]; then
    echo "release: origin/master is not at $head"
    return 1
  fi
  echo "ok: origin/master at $head"
}

for attempt in 1 2; do
  prepare_release || exit 1
  start_job build 'shared builds (relay binary, web/dist) when stale' job_build
  watch_until build
  if ((rcs[build] != 0)); then
    say '✗' done "build failed (log $RUN/build.log)"
    exit 1
  fi
  if [[ $test_mode != off ]]; then
    start_job test 'affected tests (go / unit / cdp on the local stack)' job_test
    if [[ $test_mode == gate ]]; then
      watch_until test
      if ((rcs[test] != 0)); then
        say '✗' done "tests failed (log $RUN/test.log)"
        exit 1
      fi
    fi
  fi
  start_job push 'confirm the release commit on origin/master' job_push
  watch_until push
  ((rcs[push] == 0)) && break
  [[ $test_mode == off ]] || watch_until test
  if ((attempt == 1)) && wanted push && fetch_master &&
     [[ "$(git rev-parse refs/remotes/origin/master)" != "$test_base" ]]; then
    say '↻' push 'origin/master moved, integrating and rebuilding once'
    RUN="$run_root/retry"
    mkdir -p "$RUN" || exit 1
    pids=() starts=() rcs=() durs=() seen=() quiet=() jobs_all=()
  else
    say '✗' done "push or remote verification failed (log $RUN/push.log)"
    printf '%s head=%s push=FAIL logs=%s\n' "$(date -Iseconds)" "$head" "$RUN" >>"$STATE/release.log"
    exit 1
  fi
done

relay_running_version() {
  local pid
  pid="$(systemctl --user show -p MainPID --value "$UNIT")"
  [[ -n "$pid" && "$pid" != 0 ]] || return 0
  journalctl --user -u "$UNIT" _PID="$pid" -o cat --no-pager 2>/dev/null |
    grep -o 'event=connected .*version=[^ ]*' | tail -1 | sed 's/.*version=//'
}

job_relay() {
  phase "build (skipped when current)"
  PATH="$HOME/.local/go/bin:$PATH" native/wezdeck-wsl/build.sh || return 1
  local want running installed expected seen i
  want="$(cat native/wezdeck-wsl/bin/.version)"
  running="$(relay_running_version)"
  expected="$REPO/native/wezdeck-wsl/bin/wezdeck-wsl relay"
  installed="$(systemctl --user cat "$UNIT" 2>/dev/null | sed -n 's/^ExecStart=//p' | tail -1)"
  if [[ "$running" == "$want" && "$installed" == "$expected" && $force == 0 ]]; then
    echo "skip: relay already runs $want"
    return 0
  fi
  if [[ "$installed" != "$expected" ]]; then
    phase "repairing $UNIT ExecStart before restart"
    scripts/dev/install-remote-relay.sh || return 1
  else
    phase "restarting $UNIT with $want"
    systemctl --user restart "$UNIT" || return 1
  fi
  systemctl --user is-active -q "$UNIT" || { echo "relay: $UNIT not active after restart"; return 1; }
  seen=''
  for ((i = 0; i < 30; i++)); do
    seen="$(relay_running_version || true)"
    [[ "$seen" == "$want" ]] && break
    sleep 0.5
  done
  [[ "$seen" == "$want" ]] || { echo "relay: expected $want, observed ${seen:-none} after restart" >&2; return 1; }
  echo "ok: running relay $want (was ${running:-?})"
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
  local built reused=''
  built="$(sed -n 's/.*"buildId":"\([^"]*\)".*/\1/p' web/dist/client/build.json 2>/dev/null)"
  if [[ "$built" == "$want" ]]; then
    reused=' (reused dist)'
  else
    phase "vite build $want"
    (cd web && WEZDECK_BUILD_ID="$want" corepack pnpm exec vite build) || return 1
  fi
  phase "wrangler deploy (upload assets, then the worker)"
  (cd web && corepack pnpm exec wrangler deploy) || return 1
  echo "ok: deployed web $want$reused (was ${deployed:-?})"
}

running=()
for name in relay web; do
  wanted "$name" || continue
  start_job "$name" "$(case $name in relay) echo 'restart the host relay if changed' ;; web) echo 'deploy the web console if changed' ;; esac)" "job_$name"
  running+=("$name")
done
((${#running[@]})) && watch_until "${running[@]}"

failed=0
summary=()
for name in push relay web; do
  [[ -n "${pids[$name]:-}" ]] || continue
  if ((rcs[$name] == 0)); then status=ok; else status=FAIL; failed=1; fi
  secs=${durs[$name]}
  summary+=("$name=$status/${secs}s")
done
# the web consoles onto the build just deployed (not when web was skipped)
if ((reload_clients && !failed)) && grep -q '^ok: deployed' "$RUN/web.log" 2>/dev/null; then
  t0=$SECONDS
  say '▶' pages 'reload connected web consoles onto the new build'
  clients=0
  # a console needs a moment to reconnect only after the relay restarted;
  # otherwise one ask settles it (three asks 5 s apart cost ~15 s each run)
  tries=1
  grep -q '^ok: running relay' "$RUN/relay.log" 2>/dev/null && tries=3
  for ((i = 1; i <= tries; i++)); do
    out="$(native/wezdeck-wsl/bin/wezdeck-wsl diag --reload --wait 10 \
      --reason "发布网页 $head" 2>&1 | tee -a "$RUN/clients.log")"
    clients="$(sed -n 's/.*"clients":\([0-9]*\).*/\1/p' <<<"$out")"
    [[ "${clients:-0}" -gt 0 ]] && break
    ((i < tries)) && { say '…' pages 'no console yet, waiting for reconnects'; sleep 5; }
  done
  say '✓' pages "$( ((${clients:-0} > 0)) && echo "reloaded ${clients} web console(s) onto $head" || echo 'skip: no web console connected') ($((SECONDS - t0))s)"
  summary+=("clients=${clients:-0}")
  # the person's pages on the new build? (device-check.sh: ask until every
  # answering page is current) — a retest before that sees the old code
  if ((${clients:-0} > 0)); then
    t0=$SECONDS
    if dc="$(scripts/dev/device-check.sh --wait-current 30 --reason "核对设备 $head" 2>/dev/null)"; then
      say '✓' devices "$(grep -c '  current  ' <<<"$dc") page(s) on $head ($((SECONDS - t0))s)"
      summary+=("devices=current")
    else
      say '!' devices "not every page is on $head yet: $(head -2 <<<"$dc" | tr '\n' ' ')"
      summary+=("devices=stale")
    fi
  fi
fi
# parallel tests: the deploy is out; their verdict comes last
if [[ $test_mode == parallel ]]; then
  watch_until test
  summary+=("test=$( ((rcs[test] == 0)) && echo ok || echo FAIL)/${durs[test]}s")
fi
printf '%s head=%s %s logs=%s\n' "$(date -Iseconds)" "$head" "${summary[*]}" "$RUN" >>"$STATE/release.log"
if ((failed)); then
  say '✗' done "release $head failed in $((SECONDS - T0))s"
  exit 1
fi
if [[ $test_mode == parallel ]] && ((rcs[test] != 0)); then
  say '✗' done "release $head shipped in $((SECONDS - T0))s, but tests FAILED — fix next round (log $RUN/test.log)"
  exit 3
fi
land_source="${WEZDECK_RELEASE_LAND_SOURCE:-}"
if [[ -n "$land_commit" && -n "$land_source" && "$land_source" != "$REPO" ]]; then
  if [[ ! -d "$land_source" ]] ||
     [[ "$(git -C "$land_source" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" != "$common_dir" ]] ||
     [[ "$(git -C "$land_source" rev-parse HEAD 2>/dev/null)" != "$land_commit" ]] ||
     [[ -n "$(git -C "$land_source" status --porcelain --untracked-files=normal 2>/dev/null)" ]]; then
    say '!' recycle 'source worktree changed or is dirty; release succeeded, recycle skipped'
    exit 4
  fi
  say '▶' recycle 'align the delivered workstation to origin/HEAD'
  if ! recycle_out="$(scripts/runtime/worktree/worktree-task recycle \
      --cwd "$land_source" -y --require-delivered --no-clean-files --keep-temp-branches 2>&1)"; then
    say '✗' recycle "release succeeded, recycle failed: $(tail -1 <<<"$recycle_out")"
    exit 4
  fi
  say '✓' recycle "$(tail -1 <<<"$recycle_out")"
fi
say '■' done "release $head in $((SECONDS - T0))s"
exit 0
