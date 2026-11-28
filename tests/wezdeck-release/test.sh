#!/usr/bin/env bash
# Exercise land, deployment, and source recycle with real Git worktrees.
set -euo pipefail
source_repo="$(cd "$(dirname "$0")/../.." && pwd)"
fixture="$(mktemp -d)"
cleanup() {
  local rc=$?
  if ((rc != 0)); then
    for log in "$fixture/"*.log; do
      [[ -f "$log" ]] && { printf '%s\n' "$log"; tail -25 "$log"; }
    done
    for log in "$fixture/state/wezdeck/release/"*/snapshot.log; do
      [[ -f "$log" ]] && { printf '%s\n' "$log"; tail -25 "$log"; }
    done
  fi
  rm -rf "$fixture"
}
trap cleanup EXIT
export XDG_STATE_HOME="$fixture/state"
export RELEASE_TRACE="$fixture/trace"
export RELEASE_LIVE_BUILD_FILE="$fixture/live-build"
export WEZDECK_RELEASE_RECYCLE_NO_WATCH=1
primary="$fixture/primary checkout"
export RELEASE_PRIMARY="$primary"
origin="$fixture/origin.git"
git init -q --bare -b master "$origin"
git init -q -b master "$primary"
cd "$primary"
git config user.name 'Release test'
git config user.email 'test@example.invalid'
git config merge.ff only
git remote add origin "$origin"
mkdir -p scripts/dev scripts/runtime/worktree native/wezdeck-wsl/bin web/node_modules "$fixture/bin"
cp "$source_repo/scripts/dev/"{wezdeck-release,source-fingerprint,release-queue-lib,release-snapshot}.sh scripts/dev/
cp "$source_repo/scripts/dev/install-remote-relay.sh" scripts/dev/
cp "$source_repo/scripts/dev/release-recycle.py" scripts/dev/
cat >native/wezdeck-wsl/build.sh <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
version="$(scripts/dev/source-fingerprint.sh native/wezdeck-wsl)"
echo build >>"$RELEASE_TRACE.build"
mkdir -p native/wezdeck-wsl/bin
printf '#!/usr/bin/env bash\necho relay\n' >native/wezdeck-wsl/bin/wezdeck-wsl
chmod +x native/wezdeck-wsl/bin/wezdeck-wsl
printf '%s\n' "$version" >native/wezdeck-wsl/bin/.version
STUB
chmod +x native/wezdeck-wsl/build.sh
cat > scripts/runtime/worktree/worktree-task <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == recycle ]] || exit 2
printf '%s\n' "$*" >>"$RELEASE_TRACE.recycle"
echo 'recycle ok'
STUB
chmod +x scripts/runtime/worktree/worktree-task
printf '/web/dist/\n/web/node_modules\n/native/wezdeck-wsl/bin/\n' >.gitignore
touch web/.keep
git add .
git commit -qm base
git push -qu origin master

export PATH="$fixture/bin:$PATH"
cat >"$fixture/bin/corepack" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  'pnpm run -s i18n:check') exit 0 ;;
  'pnpm exec vite build')
    mkdir -p dist/client
    printf '{"buildId":"%s"}\n' "$WEZDECK_BUILD_ID" >dist/client/build.json
    if [[ -n "${RELEASE_ADVANCE_PRIMARY:-}" && ! -e "$RELEASE_TRACE.advanced" ]]; then
      touch "$RELEASE_TRACE.advanced"
      printf '%s\n' concurrent >"$RELEASE_ADVANCE_PRIMARY/web/concurrent.txt"
      git -C "$RELEASE_ADVANCE_PRIMARY" add web/concurrent.txt
      git -C "$RELEASE_ADVANCE_PRIMARY" commit -qm concurrent
    fi
    ;;
  'pnpm exec wrangler deploy -c wrangler.relay.jsonc') exit 0 ;;
  'pnpm exec wrangler deploy -c dist/server/wrangler.json')
    head="$(git rev-parse HEAD)"
    [[ "$(git ls-remote origin refs/heads/master | cut -f1)" == "$head" ]]
    printf 'deployed %s\n' "$head" >>"$RELEASE_TRACE"
    [[ -z "${RELEASE_DIRTY_SOURCE:-}" ]] || touch "$RELEASE_DIRTY_SOURCE/changed-during-deploy"
    cp dist/client/build.json "$RELEASE_LIVE_BUILD_FILE"
    ;;
  *) exit 2 ;;
esac
STUB
cat >"$fixture/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *build.json*) [[ -f "$RELEASE_LIVE_BUILD_FILE" ]] && cat "$RELEASE_LIVE_BUILD_FILE" ;;
  *'/zh/console/sessions'*) printf '<script src="/assets/main.js"></script>\n' ;;
  *'/relay/health'*) printf 200 ;;
  *'/assets/main.js'*) printf 200 ;;
  *) exit 1 ;;
esac
STUB
cat >"$fixture/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  '--user show -p MainPID --value wezdeck-relay') echo 123 ;;
  '--user cat wezdeck-relay') echo "ExecStart=$RELEASE_PRIMARY/native/wezdeck-wsl/bin/wezdeck-wsl relay" ;;
  '--user restart wezdeck-relay') echo restart >>"$RELEASE_TRACE.relay" ;;
  '--user restart wezdeck-relay.service') exit 0 ;;
  '--user is-active -q wezdeck-relay') exit 0 ;;
  '--user daemon-reload'|'--user enable wezdeck-relay.service') exit 0 ;;
  *) exit 1 ;;
esac
STUB
cat >"$fixture/bin/journalctl" <<'STUB'
#!/usr/bin/env bash
version="$(cat "$RELEASE_PRIMARY/native/wezdeck-wsl/bin/.version" 2>/dev/null)"
[[ -z "$version" ]] || echo "event=connected version=$version"
STUB
chmod +x "$fixture/bin/"*

make_worktree() {
  local name="$1"
  git worktree add -qb "$name" "$fixture/$name"
  printf '%s\n' "$name" >"$fixture/$name/web/$name.txt"
  git -C "$fixture/$name" add "web/$name.txt"
  git -C "$fixture/$name" commit -qm "$name"
}
land() {
  (cd "$fixture/$1" && scripts/dev/wezdeck-release.sh --land HEAD --only push --only web --now --skip-smoke --no-test --no-reload)
}
land_squash() {
  (cd "$fixture/$1" && scripts/dev/wezdeck-release.sh --land HEAD --squash --only push --only web --now --skip-smoke --no-test --no-reload)
}
land_relay() {
  (cd "$fixture/$1" && scripts/dev/wezdeck-release.sh --land HEAD --only push --only relay --now --skip-smoke --no-test --no-reload)
}

make_worktree first
printf '#!/usr/bin/env bash\nexit 1\n' >"$origin/hooks/pre-receive"
chmod +x "$origin/hooks/pre-receive"
if land first >"$fixture/rejected.log" 2>&1; then
  echo 'expected push rejection' >&2
  exit 1
fi
[[ ! -e "$RELEASE_TRACE" && ! -e "$RELEASE_TRACE.recycle" ]]
[[ ! -e "$XDG_STATE_HOME/wezdeck/release/recycle" || -z "$(find "$XDG_STATE_HOME/wezdeck/release/recycle" -name '*.json' -print -quit)" ]]
rm "$origin/hooks/pre-receive"

land first >"$fixture/first.log" 2>&1 || { tail -40 "$fixture/first.log"; exit 1; }
[[ "$(wc -l <"$RELEASE_TRACE.recycle")" == 1 ]]
[[ "$(wc -l <"$RELEASE_TRACE")" == 1 ]]

make_worktree dirty
if RELEASE_DIRTY_SOURCE="$fixture/dirty" land dirty >"$fixture/dirty.log" 2>&1; then
  echo 'expected dirty source to skip recycle' >&2
  exit 1
else
  [[ $? == 4 ]]
fi
[[ -f "$fixture/dirty/changed-during-deploy" ]]
[[ "$(wc -l <"$RELEASE_TRACE.recycle")" == 1 ]]
[[ "$(wc -l <"$RELEASE_TRACE")" == 2 ]]
recycle_status="$(python3 scripts/dev/release-recycle.py status --state "$XDG_STATE_HOME/wezdeck" --repo "$primary")"
[[ "$recycle_status" == *'dirty: skipped'* && "$recycle_status" != *"$fixture"* ]]
for record in "$XDG_STATE_HOME/wezdeck/release/recycle/"*.json; do
  [[ "$(stat -c '%a' "$record")" == 600 ]]
done

git worktree add -qb relaytest "$fixture/relaytest"
printf '%s\n' relaytest >"$fixture/relaytest/native/wezdeck-wsl/relaytest.txt"
git -C "$fixture/relaytest" add native/wezdeck-wsl/relaytest.txt
git -C "$fixture/relaytest" commit -qm relaytest
land_relay relaytest >"$fixture/relaytest.log" 2>&1 || { tail -40 "$fixture/relaytest.log"; exit 1; }
[[ "$(wc -l <"$RELEASE_TRACE.relay")" == 1 ]] || { echo 'relay restart count mismatch' >&2; exit 1; }
[[ "$(cat native/wezdeck-wsl/bin/.version)" == "$(git -C "$fixture/relaytest" log -1 --format=%h -- native/wezdeck-wsl)" ]] || { echo 'primary relay binary version mismatch' >&2; exit 1; }
# A matching version stamp cannot conceal an outdated primary executable.
printf '#!/usr/bin/env bash\necho stale\n' >native/wezdeck-wsl/bin/wezdeck-wsl
chmod +x native/wezdeck-wsl/bin/wezdeck-wsl
make_worktree relayrepair
land_relay relayrepair >"$fixture/relayrepair.log" 2>&1 || { tail -40 "$fixture/relayrepair.log"; exit 1; }
[[ "$(wc -l <"$RELEASE_TRACE.relay")" == 2 ]] || { echo 'same-version stale relay was not restarted' >&2; exit 1; }
[[ "$(native/wezdeck-wsl/bin/wezdeck-wsl)" == relay ]] || { echo 'stale primary binary was not replaced' >&2; exit 1; }
mkdir -p "$fixture/home/.config/shell-env.d"
printf 'WEZDECK_RELAY_HOST_TOKEN=test-host\nWEZDECK_RELAY_CLIENT_TOKEN=test-client\n' >"$fixture/home/.config/shell-env.d/wezdeck-remote.env"
builds_before="$(wc -l <"$RELEASE_TRACE.build")"
HOME="$fixture/home" SYSTEMD_USER_UNIT_DIR="$fixture/unit" WEZDECK_RELAY_SKIP_BUILD=1 \
  scripts/dev/install-remote-relay.sh >"$fixture/install.log" 2>&1
[[ "$(wc -l <"$RELEASE_TRACE.build")" == "$builds_before" ]]

# A separate process recovers an intent after deployment was recorded but the
# releasing process ended before its close-out call.
make_worktree replay
expected="$(git -C "$fixture/replay" rev-parse HEAD)"
python3 scripts/dev/release-recycle.py record --state "$XDG_STATE_HOME/wezdeck" \
  --repo "$primary" --source "$fixture/replay" --expected "$expected" >/dev/null
python3 scripts/dev/release-recycle.py watch --state "$XDG_STATE_HOME/wezdeck" \
  --repo "$primary" >"$fixture/recycle-watch.log" 2>&1 &
watch_pid=$!
git merge -q --ff-only replay
git push -q origin master
STATE="$XDG_STATE_HOME/wezdeck"
source scripts/dev/release-queue-lib.sh
release_state_update deployed "sha=$(git rev-parse HEAD)"
wait "$watch_pid"
python3 scripts/dev/release-recycle.py reconcile --state "$XDG_STATE_HOME/wezdeck" \
  --repo "$primary" --source "$fixture/replay" --expected "$expected" >/dev/null
python3 scripts/dev/release-recycle.py reconcile --state "$XDG_STATE_HOME/wezdeck" \
  --repo "$primary" --source "$fixture/replay" --expected "$expected" >/dev/null
[[ "$(wc -l <"$RELEASE_TRACE.recycle")" == 4 ]]

make_worktree stale
expected="$(git -C "$fixture/stale" rev-parse HEAD)"
python3 scripts/dev/release-recycle.py record --state "$XDG_STATE_HOME/wezdeck" \
  --repo "$primary" --source "$fixture/stale" --expected "$expected" >/dev/null
git -C "$fixture/stale" commit -qm changed --allow-empty
git merge -q --ff-only stale
git push -q origin master
release_state_update deployed "sha=$(git rev-parse HEAD)"
if python3 scripts/dev/release-recycle.py reconcile --state "$XDG_STATE_HOME/wezdeck" \
  --repo "$primary" --source "$fixture/stale" --expected "$expected" >/dev/null; then
  echo 'expected changed source HEAD to skip recycle' >&2
  exit 1
else
  [[ $? == 4 ]]
fi
[[ "$(wc -l <"$RELEASE_TRACE.recycle")" == 4 ]]

# Parallel workstations cannot introduce a merge commit into master. The
# lagging source stays intact until it is rebased and retried.
make_worktree parallel_a
make_worktree parallel_b
land parallel_a >"$fixture/parallel-a.log" 2>&1 || { tail -40 "$fixture/parallel-a.log"; exit 1; }
tip_before="$(git rev-parse HEAD)"
if land parallel_b >"$fixture/parallel-b-stale.log" 2>&1; then
  echo 'expected a stale worktree to be rejected' >&2
  exit 1
fi
grep -q 'Rebase the source worktree' "$fixture/parallel-b-stale.log"
[[ "$(git rev-parse HEAD)" == "$tip_before" ]]
! git rev-parse --verify -q MERGE_HEAD >/dev/null
git -C "$fixture/parallel_b" rebase -q origin/master
land parallel_b >"$fixture/parallel-b.log" 2>&1 || { tail -40 "$fixture/parallel-b.log"; exit 1; }
[[ "$(git rev-list --merges --count master)" == 0 ]]

# A stale workstation can explicitly squash several local commits into one
# linear commit; source ancestry changes, but its delivered content recycles.
make_worktree squash_a
make_worktree squash_b
printf '%s\n' extra >"$fixture/squash_b/web/squash_b-extra.txt"
git -C "$fixture/squash_b" add web/squash_b-extra.txt
git -C "$fixture/squash_b" commit -qm 'squash_b extra'
squash_source="$(git -C "$fixture/squash_b" rev-parse HEAD)"
land squash_a >"$fixture/squash-a.log" 2>&1 || { tail -40 "$fixture/squash-a.log"; exit 1; }
squash_base="$(git rev-parse HEAD)"
cat >"$primary/.git/hooks/pre-commit" <<'STUB'
#!/usr/bin/env bash
[[ "$PWD" == "$XDG_STATE_HOME"/wezdeck/release/squash.* ]] || exit 1
[[ -d web/node_modules ]] || exit 1
printf 'squash hook ran\n' >>"$RELEASE_TRACE.squash-hook"
STUB
chmod +x "$primary/.git/hooks/pre-commit"
land_squash squash_b >"$fixture/squash-b.log" 2>&1 || { tail -40 "$fixture/squash-b.log"; exit 1; }
rm "$primary/.git/hooks/pre-commit"
grep -q 'squashed .* into' "$fixture/squash-b.log"
[[ "$(wc -l <"$RELEASE_TRACE.squash-hook")" == 1 ]]
[[ "$(git rev-list --count "$squash_base..master")" == 1 ]]
[[ "$(git rev-list --merges --count master)" == 0 ]]
[[ "$(git log -1 --format=%s master)" == 'squash_b extra' ]]
! git merge-base --is-ancestor "$squash_source" master
git diff --quiet "$squash_source" master -- web/squash_b.txt web/squash_b-extra.txt

# A conflict is confined to the temporary checkout; master remains clean.
make_worktree conflict_a
make_worktree conflict_b
printf '%s\n' alpha >"$fixture/conflict_a/web/.keep"
git -C "$fixture/conflict_a" add web/.keep
git -C "$fixture/conflict_a" commit -qm 'conflict alpha'
printf '%s\n' beta >"$fixture/conflict_b/web/.keep"
git -C "$fixture/conflict_b" add web/.keep
git -C "$fixture/conflict_b" commit -qm 'conflict beta'
land conflict_a >"$fixture/conflict-a.log" 2>&1 || { tail -40 "$fixture/conflict-a.log"; exit 1; }
conflict_base="$(git rev-parse HEAD)"
if land_squash conflict_b >"$fixture/conflict-b.log" 2>&1; then
  echo 'expected squash conflict to be rejected' >&2
  exit 1
fi
grep -q 'squash preparation failed' "$fixture/conflict-b.log"
[[ "$(git rev-parse HEAD)" == "$conflict_base" ]]
[[ -z "$(git status --porcelain)" ]]
[[ -z "$(find "$XDG_STATE_HOME/wezdeck/release" -maxdepth 1 -name 'squash.*' -print -quit)" ]]

# A concurrent land may move the primary checkout, but the batch's build ID
# and deployed artifact must stay pinned to its own commit.
make_worktree stable
stable_id="$(git -C "$fixture/stable" log -1 --format=%h -- web)"
RELEASE_ADVANCE_PRIMARY="$primary" land stable >"$fixture/stable.log" 2>&1 || {
  tail -40 "$fixture/stable.log"
  exit 1
}
[[ -f "$RELEASE_TRACE.advanced" ]]
[[ "$(sed -n 's/.*"buildId":"\([^"]*\)".*/\1/p' "$RELEASE_LIVE_BUILD_FILE")" == "$stable_id" ]]
[[ "$(git -C "$primary" rev-parse HEAD)" != "$(git ls-remote origin refs/heads/master | cut -f1)" ]]
snapshot="$XDG_STATE_HOME/wezdeck/release/deploy-source"
[[ "$(git -C "$snapshot" rev-parse HEAD)" == "$(git ls-remote origin refs/heads/master | cut -f1)" ]]
printf '%s\n' changed >"$snapshot/web/stable.txt"
if (
  REPO="$primary"
  STATE="$XDG_STATE_HOME/wezdeck"
  source scripts/dev/release-snapshot.sh
  release_snapshot_prepare "$(git -C "$snapshot" rev-parse HEAD)"
) >"$fixture/snapshot-dirty.log" 2>&1; then
  echo 'expected dirty release snapshot to be refused' >&2
  exit 1
fi
[[ "$(cat "$snapshot/web/stable.txt")" == changed ]]
echo 'release integration tests passed'
