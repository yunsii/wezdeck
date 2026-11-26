#!/usr/bin/env bash
# Real Git worktrees and a local bare origin. Build and deployment are stubs.
set -euo pipefail
source_repo="$(cd "$(dirname "$0")/../.." && pwd)"
fixture="$(mktemp -d)"
cleanup() {
  local rc=$?
  if ((rc != 0)); then
    for log in "$fixture/"*.log; do
      [[ -f "$log" ]] && { printf '%s\n' "$log"; tail -20 "$log"; }
    done
  fi
  rm -rf "$fixture"
}
trap cleanup EXIT
export XDG_STATE_HOME="$fixture/state"
export RELEASE_TRACE="$fixture/trace"
primary="$fixture/primary checkout"
origin="$fixture/origin.git"
git init -q --bare -b master "$origin"
git init -q -b master "$primary"
cd "$primary"
git config user.name 'Release test'
git config user.email 'test@example.invalid'
git remote add origin "$origin"
mkdir -p scripts/dev web "$fixture/bin"
cp "$source_repo/scripts/dev/"{wezdeck-release,source-fingerprint}.sh scripts/dev/
printf '/web/dist/\n' > .gitignore
touch web/.keep
git add .
git commit -qm base
git push -qu origin master

export PATH="$fixture/bin:$PATH"
cat > "$fixture/bin/corepack" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  'pnpm exec vite build')
    mkdir -p dist/client
    printf '{"buildId":"%s"}\n' "$WEZDECK_BUILD_ID" >dist/client/build.json
    if [[ -n "${RELEASE_RACE_REPO:-}" && ! -e "$RELEASE_TRACE.raced" ]]; then
      touch "$RELEASE_TRACE.raced"
      git -C "$RELEASE_RACE_REPO" push -q origin HEAD:master
    fi
    ;;
  'pnpm exec wrangler deploy')
    head="$(git rev-parse HEAD)"
    [[ "$(git ls-remote origin refs/heads/master | cut -f1)" == "$head" ]]
    printf 'start %s\n' "$head" >>"$RELEASE_TRACE"
    if [[ -n "${RELEASE_DEPLOY_PAUSE:-}" ]]; then sleep "$RELEASE_DEPLOY_PAUSE"; fi
    printf 'end %s\n' "$head" >>"$RELEASE_TRACE"
    ;;
  *) exit 2 ;;
esac
STUB
printf '#!/usr/bin/env bash\nexit 1\n' > "$fixture/bin/curl"
chmod +x "$fixture/bin/"*

for name in first second race; do
  git worktree add -qb "$name" "$fixture/$name"
  printf '%s\n' "$name" >"$fixture/$name/web/$name.txt"
  git -C "$fixture/$name" add "web/$name.txt"
  git -C "$fixture/$name" commit -qm "$name"
done
land() {
  (cd "$fixture/$1" && scripts/dev/wezdeck-release.sh --land HEAD --only push --only web --no-test --no-reload)
}

# A hard rejection must not reach the deployment stub.
printf '#!/usr/bin/env bash\nexit 1\n' > "$origin/hooks/pre-receive"
chmod +x "$origin/hooks/pre-receive"
if land first >"$fixture/rejected.log" 2>&1; then
  echo 'expected push rejection' >&2
  exit 1
fi
[[ ! -e "$RELEASE_TRACE" ]]
rm "$origin/hooks/pre-receive"

# Once admitted, two worktrees integrate and deploy without overlapping.
RELEASE_DEPLOY_PAUSE=4 land first >"$fixture/first.log" 2>&1 &
first_pid=$!
for ((i=0; i<100; i++)); do
  [[ -s "$RELEASE_TRACE" ]] && break
  sleep 0.1
done
[[ -s "$RELEASE_TRACE" ]]
if WEZDECK_RELEASE_LOCK_WAIT=0 land second >"$fixture/locked.log" 2>&1; then
  echo 'expected the shared release lock to be held' >&2
  exit 1
else
  [[ $? == 75 ]]
fi
land second >"$fixture/second.log" 2>&1
wait "$first_pid"
first="$(git -C "$fixture/first" rev-parse HEAD)"
second="$(git rev-parse HEAD)"
[[ "$(cat "$RELEASE_TRACE")" == "$(printf 'start %s\nend %s\nstart %s\nend %s' "$first" "$first" "$second" "$second")" ]]
git merge-base --is-ancestor "$first" "$second"
git merge-base --is-ancestor second "$second"

# An external push during build requires another integration and build.
external="$fixture/external"
git clone -q "$origin" "$external"
git -C "$external" -c user.name=External -c user.email=test@example.invalid commit -qm external --allow-empty
RELEASE_RACE_REPO="$external" land race >"$fixture/race.log" 2>&1
grep -q 'integrating and rebuilding once' "$fixture/race.log"
git merge-base --is-ancestor "$(git -C "$external" rev-parse HEAD)" HEAD
git merge-base --is-ancestor race HEAD
[[ "$(wc -l < "$RELEASE_TRACE")" == 6 ]]
# Deploy-only cannot ship an unpushed revision.
git commit -qm unpublished --allow-empty
if scripts/dev/wezdeck-release.sh --only web --no-test --no-reload >"$fixture/unpublished.log" 2>&1; then
  echo 'expected an unpublished revision to be refused' >&2
  exit 1
fi
[[ "$(wc -l < "$RELEASE_TRACE")" == 6 ]]
echo 'release integration tests passed'
