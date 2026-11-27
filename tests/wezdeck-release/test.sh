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
  fi
  rm -rf "$fixture"
}
trap cleanup EXIT
export XDG_STATE_HOME="$fixture/state"
export RELEASE_TRACE="$fixture/trace"
export RELEASE_LIVE_BUILD_FILE="$fixture/live-build"
primary="$fixture/primary checkout"
origin="$fixture/origin.git"
git init -q --bare -b master "$origin"
git init -q -b master "$primary"
cd "$primary"
git config user.name 'Release test'
git config user.email 'test@example.invalid'
git remote add origin "$origin"
mkdir -p scripts/dev scripts/runtime/worktree web "$fixture/bin"
cp "$source_repo/scripts/dev/"{wezdeck-release,source-fingerprint,release-queue-lib}.sh scripts/dev/
cat > scripts/runtime/worktree/worktree-task <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == recycle ]] || exit 2
printf '%s\n' "$*" >>"$RELEASE_TRACE.recycle"
echo 'recycle ok'
STUB
chmod +x scripts/runtime/worktree/worktree-task
printf '/web/dist/\n' >.gitignore
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
    ;;
  'pnpm exec wrangler deploy')
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
  *'/assets/main.js'*) exit 0 ;;
  *) exit 1 ;;
esac
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

make_worktree first
printf '#!/usr/bin/env bash\nexit 1\n' >"$origin/hooks/pre-receive"
chmod +x "$origin/hooks/pre-receive"
if land first >"$fixture/rejected.log" 2>&1; then
  echo 'expected push rejection' >&2
  exit 1
fi
[[ ! -e "$RELEASE_TRACE" && ! -e "$RELEASE_TRACE.recycle" ]]
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
echo 'release integration tests passed'
