#!/usr/bin/env bash
# Zero-disruption, coalesced release pipeline for WezDeck:
#
#   Stage 1 (land.lock, ~2-5 s):   merge --land COMMIT onto primary master,
#                                  verify i18n, push origin/master, enqueue SHA.
#   Stage 2 (deploy.lock, single): short coalesce debounce (default 5 s), build,
#                                  MANDATORY L0 core smoke gate (abort before
#                                  deploy on failure), deploy changed relay/web,
#                                  live canary probe (auto wrangler rollback on
#                                  failure), non-disruptive --notify-update. If
#                                  more commits landed during the run, coalesce
#                                  all of them into ONE next batch automatically.
#   Stage 3 (detached, no lock):   async affected regression suite in an isolated
#                                  worktree; newer deploys cancel stale runs.
#
#   scripts/dev/wezdeck-release.sh [status | rollback]
#   scripts/dev/wezdeck-release.sh [--land COMMIT | --commit MSGFILE]
#                                  [--only push|relay|web]... [--force]
#                                  [--now] [--no-wait] [--skip-smoke]
#                                  [--gate | --no-test]
#                                  [--force-reload | --no-reload]
# A successful waited --land release recycles its unchanged source workstation.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SITE="${WEZDECK_SITE:-https://wezdeck.yuns.love}"
UNIT=wezdeck-relay
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/wezdeck"

# shellcheck source=scripts/dev/release-queue-lib.sh
source "$REPO/scripts/dev/release-queue-lib.sh"

only=()
force=0
now_flag=0
wait_deploy=1
skip_smoke=0
test_mode=async # async | gate | off
notify_mode=soft # soft (--notify-update) | force (--reload) | off
commit_msg=''
land_commit=''
subcmd=''
release_args=()

if [[ "${1:-}" == status || "${1:-}" == rollback ]]; then
  subcmd="$1"
  shift
fi

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
    --force) force=1; now_flag=1; release_args+=("$1"); shift ;;
    --now) now_flag=1; release_args+=("$1"); shift ;;
    --no-wait) wait_deploy=0; release_args+=("$1"); shift ;;
    --skip-smoke) skip_smoke=1; release_args+=("$1"); shift ;;
    --no-test) test_mode=off; release_args+=("$1"); shift ;;
    --gate) test_mode=gate; release_args+=("$1"); shift ;;
    --no-reload) notify_mode=off; release_args+=("$1"); shift ;;
    --force-reload) notify_mode=force; release_args+=("$1"); shift ;;
    -h | --help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
wanted() { ((${#only[@]} == 0)) || [[ " ${only[*]} " == *" $1 "* ]]; }

cd "$REPO" || exit 1
mkdir -p "$STATE/release" || exit 1

relay_running_version() {
  local pid
  pid="$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null || true)"
  [[ -n "$pid" && "$pid" != 0 ]] || return 0
  journalctl --user -u "$UNIT" _PID="$pid" -o cat --no-pager 2>/dev/null |
    grep -o 'event=connected .*version=[^ ]*' | tail -1 | sed 's/.*version=//'
}

deployed_build() {
  curl -fsS -m 10 -H 'cache-control: no-cache' "$SITE/build.json?t=$(date +%s%N)" 2>/dev/null |
    sed -n 's/.*"buildId":"\([^"]*\)".*/\1/p'
}

if [[ "$subcmd" == status ]]; then
  release_print_status
  exit 0
fi

if [[ "$subcmd" == rollback ]]; then
  echo "release: rolling back web worker and host relay..."
  rc=0
  release_rollback_web || rc=$?
  release_rollback_relay || rc=$?
  exit "$rc"
fi

# Always integrate and deploy from the primary checkout.
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
LAND_LOCK="$common_dir/wezdeck-land.lock"
DEPLOY_LOCK="$common_dir/wezdeck-deploy.lock"

T0=$SECONDS
clock() { printf '%02d:%02d' $(((SECONDS - T0) / 60)) $(((SECONDS - T0) % 60)); }
say() { printf '[%s] %s %-6s %s\n' "$(clock)" "$1" "$2" "$3"; }
phase() { echo "::phase:: $*"; }

checkout_clean() {
  local status
  status="$(git status --porcelain --untracked-files=normal)" && [[ -z "$status" ]]
}

check_master_ready() {
  [[ "$(git branch --show-current)" == master ]] || { echo 'release: use --land COMMIT or run on master' >&2; return 1; }
  local marker
  for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply sequencer; do
    if [[ -e "$(git rev-parse --git-path "$marker")" ]]; then
      echo "release: finish the Git operation on master first ($marker)" >&2
      return 1
    fi
  done
  checkout_clean || { echo 'release: master checkout must be clean before integration' >&2; return 1; }
}

recycle_landed_source() {
  local source="${WEZDECK_RELEASE_LAND_SOURCE:-}" recycle_out
  [[ -n "$land_commit" && -n "$source" && "$source" != "$REPO" ]] || return 0
  ((wait_deploy)) || return 0
  if [[ ! -d "$source" ]] ||
     [[ "$(git -C "$source" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" != "$common_dir" ]] ||
     [[ "$(git -C "$source" rev-parse HEAD 2>/dev/null)" != "$land_commit" ]] ||
     [[ -n "$(git -C "$source" status --porcelain --untracked-files=normal 2>/dev/null)" ]]; then
    say '!' recycle 'source worktree changed or is dirty; release succeeded, recycle skipped'
    return 4
  fi
  say '▶' recycle 'align delivered workstation to origin/HEAD'
  if ! recycle_out="$(scripts/runtime/worktree/worktree-task recycle \
      --cwd "$source" -y --require-delivered --no-clean-files --keep-temp-branches 2>&1)"; then
    say '✗' recycle "release succeeded, recycle failed: $(tail -1 <<<"$recycle_out")"
    return 4
  fi
  say '✓' recycle "$(tail -1 <<<"$recycle_out")"
}

autofix_staged() {
  local staged=() rel=() f
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

fetch_master() {
  git fetch -q origin refs/heads/master:refs/remotes/origin/master
}

merge_release_input() {
  local input="$1"
  if git merge --no-edit "$input" >/dev/null; then return 0; fi
  if git rev-parse --verify -q MERGE_HEAD >/dev/null; then
    git merge --abort || return 1
  fi
  echo "release: merge failed for $input. Resolve against origin/master in the task worktree." >&2
  return 1
}

# --- Stage 1: Fast Land Lock (~2-5 s) ----------------------------------------
landed_sha=''
land_stage() {
  exec 8>>"$LAND_LOCK" || exit 1
  flock -w 60 8 || { echo "release: timed out waiting for land.lock" >&2; exit 75; }

  if [[ -n "$commit_msg" ]]; then
    [[ -f "$commit_msg" ]] || { echo "release: no message file $commit_msg" >&2; exit 2; }
    git diff --quiet || { echo "release: unstaged tracked changes — stage everything to ship" >&2; exit 1; }
    git diff --cached --quiet && { echo "release: nothing staged to commit" >&2; exit 1; }
    autofix_staged || { echo "release: auto-fix failed" >&2; exit 1; }
    local before
    before="$(git rev-parse HEAD)"
    git commit -q -F "$commit_msg" || true
    [[ "$(git rev-parse HEAD)" != "$before" ]] || { echo "release: commit refused by pre-commit gate" >&2; exit 1; }
    say '✓' commit "$(git log -1 --format='%h %s')"
  fi

  check_master_ready || exit 1
  fetch_master || exit 1
  local remote_head attempt
  for attempt in 1 2; do
    remote_head="$(git rev-parse refs/remotes/origin/master)" || exit 1
    if wanted push; then
      merge_release_input "$remote_head" || exit 1
      if [[ -n "$land_commit" ]]; then
        merge_release_input "$land_commit" || exit 1
      fi
    else
      git merge --ff-only "$remote_head" >/dev/null || exit 1
    fi
    if ! (cd web && corepack pnpm run -s i18n:check >/dev/null); then
      echo "release: i18n catalogs are missing or out of sync on $(git rev-parse --short HEAD)" >&2
      exit 1
    fi
    landed_sha="$(git rev-parse HEAD)" || exit 1
    if wanted push && [[ "$remote_head" != "$landed_sha" ]]; then
      if git push -q origin "$landed_sha:refs/heads/master"; then
        break
      fi
      if ((attempt == 1)); then
        say '↻' land 'origin/master moved, retrying integration'
        fetch_master || exit 1
        continue
      fi
      echo "release: git push origin master failed" >&2
      exit 1
    fi
    break
  done

  local short subject
  short="$(git rev-parse --short "$landed_sha")"
  subject="$(git log -1 --format='%s' "$landed_sha")"
  release_state_update enqueue "$landed_sha" "$short" "$subject"
  printf '%s event=land_enqueued head=%s subject=%q\n' "$(date -Iseconds)" "$short" "$subject" >>"$STATE/release.log"
  say '✓' land "origin/master at $short ($subject)"

  flock -u 8
  exec 8>&-
}

land_stage

# Push-only mode stops right after Stage 1.
if ! wanted relay && ! wanted web; then
  say '■' done "pushed $(git rev-parse --short "$landed_sha") in $((SECONDS - T0))s"
  exit 0
fi

# --- Helpers for Stage 2 Coordinator -----------------------------------------
progress_lines() {
  sed -n "$(($2 + 1)),\$p" "$1" 2>/dev/null | sed -nE \
    -e 's/^::phase:: (.*)$/\1/p' \
    -e 's/.*✓ built in ([0-9.]+[a-z]+).*/built in \1/p' \
    -e 's/.*Found ([0-9]+) new or modified static assets.*/uploading \1 changed assets/p' \
    -e 's/.*Uploaded ([0-9]+) of ([0-9]+) assets.*/uploaded \1\/\2 assets/p' \
    -e 's/.*No updated asset files to upload.*/no asset changes to upload/p' \
    -e 's/.*Uploaded .* \(([0-9.]+ sec)\).*/worker uploaded (\1)/p' \
    -e 's/.*Deployed .* triggers \(([0-9.]+ sec)\).*/deployed (\1)/p' \
    -e 's/.*Test Files +(.*)$/tests: \1/p'
}

declare -A pids starts rcs durs seen quiet
jobs_all=()
reset_jobs() { pids=(); starts=(); rcs=(); durs=(); seen=(); quiet=(); jobs_all=(); }
start_job() {
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
        ((rc == 0)) || sed 's/^/      /' "$RUN/$name.log" | tail -25
      fi
    done
    pending=0
    for name in "$@"; do [[ -z "${rcs[$name]:-}" ]] && pending=1; done
    ((pending)) && sleep 1
  done
}

job_build() {
  if wanted relay; then
    phase "relay binary (skipped when current)"
    PATH="$HOME/.local/go/bin:$PATH" native/wezdeck-wsl/build.sh || return 1
  fi
  if wanted web; then
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

job_smoke() {
  local args=()
  ((relay_changed)) && args+=(--go)
  ((web_changed)) && args+=(--web)
  scripts/dev/release-smoke-gate.sh "${args[@]}"
}

job_gate_full() {
  scripts/dev/web-affected-tests.sh --base "$batch_base" --run
}

job_relay() {
  local want running installed expected seen i
  want="$(cat native/wezdeck-wsl/bin/.version)"
  running="$(relay_running_version)"
  expected="$REPO/native/wezdeck-wsl/bin/wezdeck-wsl relay"
  installed="$(systemctl --user cat "$UNIT" 2>/dev/null | sed -n 's/^ExecStart=//p' | tail -1)"
  if [[ "$running" == "$want" && "$installed" == "$expected" && $force == 0 ]]; then
    echo "skip: relay already runs $want"
    return 0
  fi
  # Keep a backup of the previously deployed binary for emergency rollback.
  if [[ -x "$REPO/native/wezdeck-wsl/bin/wezdeck-wsl" && "$running" != "$want" ]]; then
    cp -f "$REPO/native/wezdeck-wsl/bin/wezdeck-wsl" "$STATE/release/wezdeck-wsl.last-known" 2>/dev/null || true
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

job_web() {
  local deployed want built reused=''
  want="$(scripts/dev/source-fingerprint.sh web)"
  deployed="$(deployed_build)"
  if [[ $force == 0 && "$deployed" == "$want" ]]; then
    echo "skip: $SITE already serves $want"
    return 0
  fi
  built="$(sed -n 's/.*"buildId":"\([^"]*\)".*/\1/p' web/dist/client/build.json 2>/dev/null)"
  if [[ "$built" == "$want" ]]; then
    reused=' (reused dist)'
  else
    phase "vite build $want"
    (cd web && WEZDECK_BUILD_ID="$want" corepack pnpm exec vite build) || return 1
  fi
  phase "wrangler deploy (upload assets, then the worker)"
  (cd web && corepack pnpm exec wrangler deploy) || return 1
  phase "live canary probe ($SITE)"
  if ! release_live_canary "$SITE" "$want"; then
    phase "canary failed — rolling back Cloudflare worker"
    release_rollback_web || true
    echo "FAIL: live canary failed for $want (rolled back)"
    return 1
  fi
  echo "ok: deployed web $want$reused (was ${deployed:-?})"
}

notify_clients() {
  local head="$1" count="$2"
  [[ $notify_mode == off ]] && return 0
  grep -q '^ok: deployed' "$RUN/web.log" 2>/dev/null || return 0
  local reason="发布网页 $head"
  ((count > 1)) && reason="合并发布 ${count} 项更新 ($head)"
  local flag='--notify-update' label='notify connected web consoles (non-disruptive)'
  if [[ $notify_mode == force ]]; then
    flag='--reload'
    label='force-reload connected web consoles onto new build'
  fi
  local t0=$SECONDS clients=0 tries=1 i out
  grep -q '^ok: running relay' "$RUN/relay.log" 2>/dev/null && tries=3
  say '▶' pages "$label"
  for ((i = 1; i <= tries; i++)); do
    out="$(native/wezdeck-wsl/bin/wezdeck-wsl diag "$flag" --wait 8 \
      --reason "$reason" 2>&1 | tee -a "$RUN/clients.log")"
    clients="$(sed -n 's/.*"clients":\([0-9]*\).*/\1/p' <<<"$out")"
    [[ "${clients:-0}" -gt 0 ]] && break
    ((i < tries)) && { say '…' pages 'no console yet, waiting for reconnects'; sleep 3; }
  done
  if [[ $notify_mode == force ]]; then
    say '✓' pages "$( ((${clients:-0} > 0)) && echo "reloaded ${clients} console(s) onto $head" || echo 'skip: no web console connected') ($((SECONDS - t0))s)"
    if ((${clients:-0} > 0)); then
      scripts/dev/device-check.sh --wait-current 30 --reason "核对设备 $head" >/dev/null 2>&1 || true
    fi
  else
    say '✓' pages "$( ((${clients:-0} > 0)) && echo "notified ${clients} console(s) of $head (no forced reload)" || echo 'skip: no web console connected') ($((SECONDS - t0))s)"
  fi
}

# Waiter path when another coordinator already holds deploy.lock.
wait_for_coalesced_deploy() {
  local target="$1" short last_phase='' cur_phase deployed failed_sha
  short="$(git rev-parse --short "$target")"
  if ((wait_deploy == 0)); then
    say '✓' queue "landed $short, queued for coalesced release (--no-wait)"
    return 0
  fi
  say '…' queue "another release is running; waiting for $short to ship in a coalesced batch"
  local deadline=$((SECONDS + ${WEZDECK_RELEASE_WAIT_TIMEOUT:-600}))
  while ((SECONDS < deadline)); do
    deployed="$(release_state_get deployed_sha)"
    if [[ -n "$deployed" ]] && git merge-base --is-ancestor "$target" "$deployed" 2>/dev/null; then
      say '■' done "$short shipped in coalesced batch $(git rev-parse --short "$deployed") ($((SECONDS - T0))s)"
      return 0
    fi
    cur_phase="$(release_state_get phase)"
    if [[ "$cur_phase" != "$last_phase" && -n "$cur_phase" ]]; then
      say '·' queue "coordinator phase=$cur_phase deploying=$(release_state_get deploying_short)"
      last_phase="$cur_phase"
    fi
    failed_sha="$(release_state_get failed_sha)"
    if [[ -n "$failed_sha" ]] && git merge-base --is-ancestor "$target" "$failed_sha" 2>/dev/null; then
      say '✗' done "coalesced batch $(git rev-parse --short "$failed_sha") failed: $(release_state_get last_error) (log $(release_state_get last_run_dir))"
      return 1
    fi
    # If the previous coordinator finished before seeing our push, take over now.
    if flock -n 9; then
      return 2
    fi
    sleep 2
  done
  say '✗' done "timed out waiting for coalesced release of $short"
  return 75
}

# --- Stage 2: Singleton Coalescing Release Coordinator -----------------------
exec 9>>"$DEPLOY_LOCK" || exit 1
if ! flock -n 9; then
  wait_rc=0
  wait_for_coalesced_deploy "$landed_sha" || wait_rc=$?
  if ((wait_rc != 2)); then
    if ((wait_rc == 0)); then recycle_landed_source || wait_rc=$?; fi
    exit "$wait_rc"
  fi
  # wait_rc == 2: we acquired fd 9 and took over as coordinator.
fi

run_coordinator_loop() {
  local coalesce_s="${WEZDECK_RELEASE_COALESCE_S:-5}"
  local max_coalesce_s="${WEZDECK_RELEASE_COALESCE_MAX_S:-15}"
  local batch_num=0

  while :; do
    batch_num=$((batch_num + 1))

    # 1. Short debounce window before building so rapid back-to-back lands merge.
    if ((batch_num == 1 && now_flag == 0 && coalesce_s > 0)); then
      local w_start=$SECONDS last_desired cur_desired
      last_desired="$(release_state_get desired_sha)"
      release_state_update phase "phase=coalescing" "coordinator_pid=$$"
      say '…' queue "coalescing window (${coalesce_s}s; pass --now to skip)"
      while ((SECONDS - w_start < max_coalesce_s)); do
        sleep 1
        cur_desired="$(release_state_get desired_sha)"
        if [[ "$cur_desired" != "$last_desired" ]]; then
          last_desired="$cur_desired"
          say '·' queue "coalesced newer commit ${cur_desired:0:8} into this batch"
          ((SECONDS - w_start + 3 < max_coalesce_s)) && continue
        fi
        ((SECONDS - w_start >= coalesce_s)) && break
      done
    fi

    # 2. Snapshot origin/master cleanly under brief land.lock.
    exec 8>>"$LAND_LOCK" || return 1
    flock -w 60 8 || return 75
    fetch_master || { flock -u 8; exec 8>&-; return 1; }
    git merge --ff-only refs/remotes/origin/master >/dev/null || { flock -u 8; exec 8>&-; return 1; }
    local target_sha head prev_deployed batch_count
    target_sha="$(git rev-parse HEAD)"
    head="$(git rev-parse --short "$target_sha")"
    prev_deployed="$(release_state_get deployed_sha)"
    flock -u 8
    exec 8>&-

    if [[ -n "$prev_deployed" && "$prev_deployed" == "$target_sha" && $force == 0 ]]; then
      release_state_update phase "phase=idle"
      say '■' done "already deployed at $head"
      return 0
    fi

    batch_base="${prev_deployed:-$target_sha~1}"
    if [[ -n "$prev_deployed" ]] && git cat-file -e "$prev_deployed^{commit}" 2>/dev/null; then
      batch_count="$(git rev-list --count "$prev_deployed..$target_sha" 2>/dev/null || echo 1)"
    else
      batch_count=1
    fi
    ((batch_count < 1)) && batch_count=1

    RUN="$(mktemp -d "$STATE/release/$(date +%Y%m%d-%H%M%S).XXXXXX")" || return 1
    reset_jobs
    release_state_update phase "phase=building" "deploying_sha=$target_sha" "deploying_short=$head" \
      "batch_count=$batch_count" "run_dir=$RUN" "coordinator_pid=$$"
    printf '%s event=batch_started batch=%d head=%s commits=%d logs=%s\n' \
      "$(date -Iseconds)" "$batch_num" "$head" "$batch_count" "$RUN" >>"$STATE/release.log"
    say '▶' batch "batch #$batch_num at $head (${batch_count} commit(s))"

    # Snapshot previous relay binary before building over it.
    if [[ -x "$REPO/native/wezdeck-wsl/bin/wezdeck-wsl" ]]; then
      cp -f "$REPO/native/wezdeck-wsl/bin/wezdeck-wsl" "$STATE/release/wezdeck-wsl.prev" 2>/dev/null || true
    fi

    # 3. Build changed artifacts.
    start_job build 'shared builds (relay binary, web/dist) when stale' job_build
    watch_until build
    if ((rcs[build] != 0)); then
      release_state_update failed "sha=$target_sha" "phase=build_failed" "error=build failed" "run_dir=$RUN"
      say '✗' done "batch $head build failed (log $RUN/build.log)"
      return 1
    fi

    local web_fp relay_fp live_web live_relay
    web_fp="$(scripts/dev/source-fingerprint.sh web)"
    relay_fp="$(cat native/wezdeck-wsl/bin/.version 2>/dev/null || scripts/dev/source-fingerprint.sh native/wezdeck-wsl)"
    live_web="$(deployed_build || true)"
    live_relay="$(relay_running_version || true)"
    web_changed=0; relay_changed=0
    if wanted web && [[ "$live_web" != "$web_fp" || $force == 1 ]]; then web_changed=1; fi
    if wanted relay && [[ "$live_relay" != "$relay_fp" || $force == 1 ]]; then relay_changed=1; fi

    # 4. Mandatory L0 pre-deploy core availability smoke gate.
    if ((skip_smoke == 0 && (web_changed || relay_changed))); then
      release_state_update phase "phase=smoke_gate" "deploying_sha=$target_sha" "deploying_short=$head" "run_dir=$RUN"
      start_job smoke 'L0 core availability smoke gate (pre-deploy)' job_smoke
      watch_until smoke
      if ((rcs[smoke] != 0)); then
        release_state_update failed "sha=$target_sha" "phase=gate_failed" "error=L0 core smoke gate failed" "run_dir=$RUN"
        printf '%s event=gate_failed head=%s commits=%d logs=%s\n' "$(date -Iseconds)" "$head" "$batch_count" "$RUN" >>"$STATE/release.log"
        say '✗' done "L0 smoke gate FAILED for $head — production untouched (log $RUN/smoke.log)"
        return 1
      fi
    fi

    # Optional --gate: full affected regression before deploy.
    if [[ $test_mode == gate ]]; then
      release_state_update phase "phase=full_gate" "deploying_sha=$target_sha" "deploying_short=$head" "run_dir=$RUN"
      start_job test 'full affected regression (--gate)' job_gate_full
      watch_until test
      if ((rcs[test] != 0)); then
        release_state_update failed "sha=$target_sha" "phase=gate_failed" "error=full regression gate failed" "run_dir=$RUN"
        say '✗' done "full test gate FAILED for $head — production untouched (log $RUN/test.log)"
        return 1
      fi
    fi

    # 5. Deploy changed services (web includes live canary + auto rollback).
    release_state_update phase "phase=deploying" "deploying_sha=$target_sha" "deploying_short=$head" "run_dir=$RUN"
    local running=() name
    for name in relay web; do
      wanted "$name" || continue
      start_job "$name" "$(case $name in relay) echo 'restart host relay if changed' ;; web) echo 'deploy web + live canary if changed' ;; esac)" "job_$name"
      running+=("$name")
    done
    ((${#running[@]})) && watch_until "${running[@]}"

    local failed=0 summary=()
    for name in relay web; do
      [[ -n "${pids[$name]:-}" ]] || continue
      if ((rcs[$name] == 0)); then summary+=("$name=ok/${durs[$name]}s"); else summary+=("$name=FAIL/${durs[$name]}s"); failed=1; fi
    done
    if ((failed)); then
      release_state_update failed "sha=$target_sha" "phase=deploy_failed" "error=deploy failed (${summary[*]})" "run_dir=$RUN"
      printf '%s event=batch_failed head=%s %s logs=%s\n' "$(date -Iseconds)" "$head" "${summary[*]}" "$RUN" >>"$STATE/release.log"
      say '✗' done "deploy failed for $head (logs $RUN)"
      return 1
    fi

    # 6. Non-disruptive client update notification.
    notify_clients "$head" "$batch_count"

    # 7. Record deployed SHA & kick off Stage 3 async regression OUTSIDE locks.
    release_state_update deployed "sha=$target_sha" "web_fp=$web_fp" "relay_fp=$relay_fp" "run_dir=$RUN"
    printf '%s event=batch_deployed batch=%d head=%s commits=%d %s logs=%s\n' \
      "$(date -Iseconds)" "$batch_num" "$head" "$batch_count" "${summary[*]}" "$RUN" >>"$STATE/release.log"
    say '✓' batch "batch #$batch_num deployed $head (${batch_count} commit(s), ${summary[*]})"

    if [[ $test_mode == async ]]; then
      nohup bash "$REPO/scripts/dev/release-async-verify.sh" "$batch_base" "$target_sha" >/dev/null 2>&1 &
      disown 2>/dev/null || true
      say '·' verify "async regression started for $head (detached; never blocks next release)"
    fi

    # 8. In-flight coalescing: did more commits land while we shipped this batch?
    fetch_master || true
    local newest_remote
    newest_remote="$(git rev-parse refs/remotes/origin/master 2>/dev/null || echo "$target_sha")"
    if [[ "$newest_remote" != "$target_sha" ]]; then
      say '↻' queue "new commits landed during batch #$batch_num (now ${newest_remote:0:8}) — coalescing into next batch"
      force=0
      continue
    fi
    break
  done
  say '■' done "release $(git rev-parse --short HEAD) complete in $((SECONDS - T0))s"
}

run_coordinator_loop
rc=$?
flock -u 9
exec 9>&-
if ((rc == 0)); then recycle_landed_source || rc=$?; fi
exit "$rc"
