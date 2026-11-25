#!/usr/bin/env bash
# smoke.sh — end-to-end regression test for worktree-task CLI engine.
#
# Runs in an isolated /tmp git repo, exercises launch + reclaim through
# the `none` provider (no tmux/agent dependencies). Sandboxes HOME so the
# transcript-archive path can be exercised without touching the real
# user's ~/.claude/projects/.
#
# Cases:
#   1. happy-path: launch + reclaim creates and removes worktree, branch,
#      and metadata; no phantom worktree entry afterward.
#   2. removed flag: reclaim --allow-long-lived fails with the replacement.
#   3. a workstation from before 2026-11-25 (dev-<name>) reclaims without
#      any extra flag.
#   4. create-prompt preview: name → directory <name>, branch dev/<name>;
#      collisions (also with an old dev-<name> directory) bump; a dev- typed
#      out of habit is dropped; no letters/digits or a reserved prefix is an
#      error.
#   5. open-task-window: creates <name> on dev/<name> with the description
#      as the branch description; --type is refused with the replacement.
#   6. origin-default-branch launch: branch starts from origin/HEAD but
#      does not track the default branch as upstream.
#   7. transcript preserved across reclaim.
#   8. recycle refuses undelivered workstation commits.
#   9. recycle happy path: reset to origin/HEAD, prune merged temp branch,
#      clean debug dirs, write next-task brief, sync origin/<branch>.
#  10. recycle refuses ticket-* (agent-collab's) and aligns a bare-name
#      workstation to dev/<name>.
#  11. recycle accepts squash-merged tip (content absorbed) and force-with-lease
#      syncs a stale origin/<branch>.
#  12. describe: set / get / clear the purpose, shared by every worktree.
#
# Exit non-zero on any failure with a short trace.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKTREE_TASK="$REPO_ROOT/scripts/runtime/worktree/worktree-task"
CREATE_PROMPT="$REPO_ROOT/scripts/runtime/worktree/create-prompt"
OPEN_TASK_WINDOW="$REPO_ROOT/scripts/runtime/worktree/open-task-window"

[[ -x "$WORKTREE_TASK" ]] || {
  printf 'FAIL: worktree-task CLI not found or not executable: %s\n' "$WORKTREE_TASK" >&2
  exit 1
}
[[ -x "$CREATE_PROMPT" ]] || {
  printf 'FAIL: create-prompt not found or not executable: %s\n' "$CREATE_PROMPT" >&2
  exit 1
}
[[ -x "$OPEN_TASK_WINDOW" ]] || {
  printf 'FAIL: open-task-window not found or not executable: %s\n' "$OPEN_TASK_WINDOW" >&2
  exit 1
}

WORK_DIR="$(mktemp -d -t wt-smoke.XXXXXX)"
SANDBOX_HOME="$WORK_DIR/home"
mkdir -p "$SANDBOX_HOME"

# Persist the original HOME so we can hand it to subprocess git commands
# that need user identity (or anything else that legitimately reads the
# real HOME). The runtime under test uses $HOME for transcript paths only.
ORIGINAL_HOME="$HOME"

cleanup() {
  local rc=$?
  # Best-effort cleanup of any leftover worktrees in the throwaway repos.
  if [[ -d "$WORK_DIR" ]]; then
    find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d -name 'origin*' 2>/dev/null | while read -r repo; do
      git -C "$repo" worktree list --porcelain 2>/dev/null \
        | awk '/^worktree / {print $2}' \
        | grep -v "^$repo$" \
        | while read -r wt; do
            git -C "$repo" worktree remove -f "$wt" >/dev/null 2>&1 || true
          done || true
    done
  fi
  rm -rf "$WORK_DIR"
  return $rc
}
trap cleanup EXIT

setup_repo() {
  local repo="$1"
  mkdir -p "$repo"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.email "smoke@example.invalid"
  git -C "$repo" config user.name "Smoke Test"
  echo init > "$repo/README.md"
  git -C "$repo" add -A
  git -C "$repo" commit -q -m init
}

PASS=0
FAIL=0

assert_pass() {
  printf '[ok ] %s\n' "$1"
  PASS=$((PASS + 1))
}

assert_fail() {
  printf '[FAIL] %s\n' "$1" >&2
  FAIL=$((FAIL + 1))
}

# ---------- case 1: happy path ----------
case1_happy_path() {
  printf '\n=== case 1: happy path ===\n'

  local repo="$WORK_DIR/origin1"
  setup_repo "$repo"
  local slug="smoke-pr2-happy"
  local expect_wt="$WORK_DIR/.worktrees/origin1/$slug"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title "$slug" \
    --base-ref HEAD \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "launch returned non-zero"; return 1; }

  [[ -d "$expect_wt" ]] && assert_pass "worktree dir present" \
    || { assert_fail "worktree dir missing: $expect_wt"; return 1; }

  git -C "$repo" branch --list "dev/$slug" | grep -q "dev/$slug" \
    && assert_pass "branch present (WT_POLICY_BRANCH_PREFIX dev/)" \
    || { assert_fail "branch dev/$slug missing"; return 1; }

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" reclaim \
    --cwd "$repo" \
    --task-slug "$slug" \
    --provider none >/dev/null \
    || { assert_fail "reclaim returned non-zero"; return 1; }

  [[ ! -d "$expect_wt" ]] && assert_pass "worktree dir gone" \
    || { assert_fail "worktree dir still present after reclaim"; return 1; }

  if git -C "$repo" branch --list "dev/$slug" | grep -q "dev/$slug"; then
    assert_fail "branch dev/$slug still present after reclaim"
    return 1
  fi
  assert_pass "branch gone"

  if git -C "$repo" worktree list --porcelain | grep -q "$expect_wt"; then
    assert_fail "phantom worktree entry remains"
    return 1
  fi
  assert_pass "no phantom worktree entry"
}

# ---------- case 2: removed --allow-long-lived ----------
case2_allow_long_lived_removed() {
  printf '\n=== case 2: --allow-long-lived is removed ===\n'

  local repo="$WORK_DIR/origin2"
  setup_repo "$repo"
  local slug="billing"
  local expect_wt="$WORK_DIR/.worktrees/origin2/$slug"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title "$slug" \
    --base-ref HEAD \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "launch failed"; return 1; }

  local stderr_file="$WORK_DIR/case2-stderr"
  if HOME="$SANDBOX_HOME" \
     WEZDECK_REPO="$REPO_ROOT" \
     "$WORKTREE_TASK" reclaim \
       --cwd "$repo" \
       --task-slug "$slug" \
       --allow-long-lived \
       --provider none >/dev/null 2>"$stderr_file"; then
    assert_fail "reclaim accepted the removed --allow-long-lived"
    return 1
  fi
  grep -q -- "--allow-long-lived is removed" "$stderr_file" \
    && assert_pass "removed flag fails with the replacement" \
    || { assert_fail "unclear refusal: $(cat "$stderr_file")"; return 1; }
  [[ -d "$expect_wt" ]] && assert_pass "workstation left in place" \
    || { assert_fail "workstation removed by a refused reclaim"; return 1; }
}

# ---------- case 3: an old dev-<name> workstation reclaims plainly ----------
case3_legacy_dev_reclaim() {
  printf '\n=== case 3: dev-<name> from before 2026-11-25 reclaims ===\n'

  local repo="$WORK_DIR/origin3"
  setup_repo "$repo"
  local slug="dev-ci-fix"
  local expect_wt="$WORK_DIR/.worktrees/origin3/$slug"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title ci-fix \
    --task-slug "$slug" \
    --branch dev/ci-fix \
    --base-ref HEAD \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "launch failed"; return 1; }
  [[ -d "$expect_wt" ]] || { assert_fail "dev-* worktree not created"; return 1; }

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" reclaim \
    --cwd "$repo" \
    --task-slug "$slug" \
    --provider none >/dev/null \
    || { assert_fail "reclaim of dev-ci-fix failed without a flag"; return 1; }
  [[ ! -d "$expect_wt" ]] && assert_pass "dev-* workstation reclaimed without a flag" \
    || { assert_fail "dev-* worktree still present"; return 1; }
}

# ---------- case 4: create-prompt preview ----------
case4_create_prompt_preview() {
  printf '\n=== case 4: create-prompt preview ===\n'

  local repo="$WORK_DIR/origin4"
  setup_repo "$repo"
  local preview

  plan() {
    (
      cd "$repo"
      HOME="$SANDBOX_HOME" \
      WEZDECK_REPO="$REPO_ROOT" \
      "$CREATE_PROMPT" --preview "$1"
    )
  }
  expect_line() {
    grep -qx -- "$1" <<<"$preview" \
      && assert_pass "$2" \
      || { assert_fail "$2: want '$1' in: $preview"; return 1; }
  }

  preview="$(plan "ci fix")"
  expect_line 'name=ci fix' "preview keeps the typed name" || return 1
  expect_line 'slug=ci-fix' "preview slugifies the name" || return 1
  expect_line "worktree=$WORK_DIR/.worktrees/origin4/ci-fix" "directory is the bare name" || return 1
  expect_line 'branch=dev/ci-fix' "branch is dev/<name>" || return 1
  expect_line 'status=new' "fresh name is new" || return 1

  preview="$(plan "dev-ci fix")"
  expect_line 'slug=ci-fix' "a dev- typed out of habit is dropped" || return 1
  preview="$(plan "dev/ci fix")"
  expect_line 'branch=dev/ci-fix' "a dev/ typed out of habit is dropped" || return 1

  git -C "$repo" branch dev/ci-fix
  preview="$(plan "ci fix")"
  expect_line 'slug=ci-fix-2' "taken branch bumps the directory" || return 1
  expect_line 'branch=dev/ci-fix-2' "taken branch bumps the branch" || return 1
  expect_line 'status=bumped' "bump is reported" || return 1

  mkdir -p "$WORK_DIR/.worktrees/origin4/dev-i18n"
  preview="$(plan "i18n")"
  expect_line 'slug=i18n-2' "an old dev-<name> directory takes the name" || return 1
  expect_line "taken=$WORK_DIR/.worktrees/origin4/dev-i18n" "the old directory is named" || return 1

  preview="$(plan "网页体验")"
  expect_line 'status=error' "a name without letters or digits is an error" || return 1
  grep -q '^error=the name needs letters or digits' <<<"$preview" \
    && assert_pass "error says why" \
    || { assert_fail "error text: $preview"; return 1; }

  preview="$(plan "ticket-x")"
  expect_line 'status=error' "a reserved ticket- prefix is an error" || return 1
}

# ---------- case 5: open-task-window creates a workstation ----------
case5_open_task_window_workstation() {
  printf '\n=== case 5: open-task-window creates a workstation ===\n'

  local repo="$WORK_DIR/origin5"
  setup_repo "$repo"
  local expect_wt="$WORK_DIR/.worktrees/origin5/web-ux"

  (
    cd "$repo"
    HOME="$SANDBOX_HOME" \
    WEZDECK_REPO="$REPO_ROOT" \
    MANAGED_AGENT_PROFILE=claude \
    WT_QUICK_CREATE_BASE_REF=HEAD \
    WT_QUICK_CREATE_PROVIDER=none \
    WT_QUICK_CREATE_PROVIDER_MODE=off \
    "$OPEN_TASK_WINDOW" --description $'网页控制台\t体验' -- "Web UX" >/dev/null
  ) || { assert_fail "open-task-window failed"; return 1; }

  [[ -d "$expect_wt" ]] && assert_pass "workstation directory is the bare name" \
    || { assert_fail "workstation missing: $expect_wt"; return 1; }
  [[ "$(git -C "$expect_wt" branch --show-current)" == dev/web-ux ]] \
    && assert_pass "branch dev/web-ux" \
    || { assert_fail "branch: $(git -C "$expect_wt" branch --show-current)"; return 1; }
  [[ "$(git -C "$repo" config branch.dev/web-ux.description)" == "网页控制台 体验" ]] \
    && assert_pass "description stored as the branch description (one line)" \
    || { assert_fail "description: $(git -C "$repo" config branch.dev/web-ux.description)"; return 1; }

  local stderr_file="$WORK_DIR/case5-stderr"
  if ( cd "$repo" && HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
       "$OPEN_TASK_WINDOW" --type dev -- x >/dev/null 2>"$stderr_file" ); then
    assert_fail "--type was accepted"
    return 1
  fi
  grep -q -- "--type is removed" "$stderr_file" \
    && assert_pass "--type fails with the replacement" \
    || { assert_fail "unclear --type refusal: $(cat "$stderr_file")"; return 1; }

  if ( cd "$repo" && HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
       "$OPEN_TASK_WINDOW" -- "网页" >/dev/null 2>"$stderr_file" ); then
    assert_fail "a name without letters or digits was accepted"
    return 1
  fi
  assert_pass "a name without letters or digits is refused"
}

# ---------- case 6: origin default does not become upstream ----------
case6_origin_default_no_tracking() {
  printf '\n=== case 6: origin default no tracking ===\n'

  local remote="$WORK_DIR/remote6.git"
  local repo="$WORK_DIR/origin6"
  git init -q --bare "$remote"
  setup_repo "$repo"
  git -C "$repo" remote add origin "$remote"
  git -C "$repo" push -q -u origin main
  git -C "$remote" symbolic-ref HEAD refs/heads/main
  git -C "$repo" remote set-head origin -a >/dev/null

  local slug="remote-base"
  local expect_wt="$WORK_DIR/.worktrees/origin6/$slug"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title "$slug" \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "launch from origin/HEAD failed"; return 1; }

  [[ -d "$expect_wt" ]] && assert_pass "origin-default launch creates worktree" \
    || { assert_fail "origin-default worktree missing: $expect_wt"; return 1; }

  if git -C "$expect_wt" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
    assert_fail "new task branch unexpectedly tracks an upstream: $(git -C "$expect_wt" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')"
    return 1
  fi
  assert_pass "new task branch has no upstream"

  local branch_remote
  branch_remote="$(git -C "$repo" config --get "branch.task/$slug.remote" || true)"
  [[ -z "$branch_remote" ]] && assert_pass "branch config has no remote" \
    || { assert_fail "branch.task/$slug.remote should be empty, got: $branch_remote"; return 1; }
}

# ---------- case 6: transcript preservation ----------
# Reclaim intentionally leaves ~/.claude/projects/<escaped>/ in place so a
# later same-named worktree (rare but legitimate when reusing task types)
# can resume the prior conversation via `claude --continue`. /clear is the
# escape hatch when the resumed context isn't wanted.
case7_transcript_preserved() {
  printf '\n=== case 7: transcript preserved across reclaim ===\n'

  local repo="$WORK_DIR/origin7"
  setup_repo "$repo"
  local slug="task-resume"
  local expect_wt="$WORK_DIR/.worktrees/origin7/$slug"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title "$slug" \
    --base-ref HEAD \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "launch failed"; return 1; }

  local escaped="${expect_wt//\//-}"
  local transcript_src="$SANDBOX_HOME/.claude/projects/$escaped"
  mkdir -p "$transcript_src"
  echo '{"role":"user","content":"hello"}' > "$transcript_src/dummy.jsonl"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" reclaim \
    --cwd "$repo" \
    --task-slug "$slug" \
    --provider none >/dev/null \
    || { assert_fail "reclaim failed"; return 1; }

  [[ -f "$transcript_src/dummy.jsonl" ]] && assert_pass "transcript file preserved at original path" \
    || { assert_fail "transcript dir/file disappeared after reclaim"; return 1; }

  [[ ! -d "$SANDBOX_HOME/.claude/projects/.archive" ]] && assert_pass "no .archive/ side-effect created" \
    || { assert_fail ".archive/ unexpectedly created — archive code may not be fully removed"; return 1; }
}

# ---------- case 8: recycle delivery gate (--require-delivered) vs fast path ----------
# Since 41f9052 the delivery gate is opt-in: --require-delivered refuses
# undelivered work; the default fast path hard-resets onto origin/HEAD.
case8_recycle_undelivered() {
  printf '\n=== case 8: recycle --require-delivered refuses undelivered; default fast path resets ===\n'

  local remote="$WORK_DIR/remote8.git"
  local repo="$WORK_DIR/origin8"
  git init -q --bare "$remote"
  setup_repo "$repo"
  git -C "$repo" remote add origin "$remote"
  git -C "$repo" push -q -u origin main
  git -C "$remote" symbolic-ref HEAD refs/heads/main
  git -C "$repo" remote set-head origin -a >/dev/null

  local slug="dev-recycle-block"
  local expect_wt="$WORK_DIR/.worktrees/origin8/$slug"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title recycle-block \
    --task-slug "$slug" \
    --branch "dev/recycle-block" \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "launch failed"; return 1; }

  echo undelivered >"$expect_wt/undelivered.txt"
  git -C "$expect_wt" add undelivered.txt
  git -C "$expect_wt" commit -q -m "undelivered work"

  local before
  before="$(git -C "$expect_wt" rev-parse HEAD)"
  local stderr_file="$WORK_DIR/case8-stderr"
  if HOME="$SANDBOX_HOME" \
     WEZDECK_REPO="$REPO_ROOT" \
     WT_RECYCLE_NO_CONFIRM=1 \
     "$WORKTREE_TASK" recycle \
       --worktree-root "$expect_wt" \
       --require-delivered \
       -y >/dev/null 2>"$stderr_file"; then
    assert_fail "recycle --require-delivered should refuse undelivered branch"
    return 1
  fi
  assert_pass "recycle --require-delivered refused undelivered"
  [[ "$(git -C "$expect_wt" rev-parse HEAD)" == "$before" ]] \
    && assert_pass "tip unchanged after refused recycle" \
    || { assert_fail "tip moved despite refusal"; return 1; }

  # default fast path: no delivery gate, tip reset onto origin/HEAD
  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  WT_RECYCLE_NO_CONFIRM=1 \
  "$WORKTREE_TASK" recycle \
    --worktree-root "$expect_wt" \
    -y >/dev/null 2>"$stderr_file" \
    || { assert_fail "default fast-path recycle failed: $(tail -1 "$stderr_file")"; return 1; }
  [[ "$(git -C "$expect_wt" rev-parse HEAD)" == "$(git -C "$repo" rev-parse origin/main)" ]] \
    && assert_pass "fast path reset tip onto origin/HEAD (undelivered commit discarded by design)" \
    || { assert_fail "fast path did not reset tip onto origin/HEAD"; return 1; }
}

# ---------- case 9: recycle happy path ----------
case9_recycle_happy() {
  printf '\n=== case 9: recycle happy path ===\n'

  local remote="$WORK_DIR/remote9.git"
  local repo="$WORK_DIR/origin9"
  git init -q --bare "$remote"
  setup_repo "$repo"
  git -C "$repo" remote add origin "$remote"
  git -C "$repo" push -q -u origin main
  git -C "$remote" symbolic-ref HEAD refs/heads/main
  git -C "$repo" remote set-head origin -a >/dev/null

  local slug="dev-recycle-ok"
  local expect_wt="$WORK_DIR/.worktrees/origin9/$slug"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title recycle-ok \
    --task-slug "$slug" \
    --branch "dev/recycle-ok" \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "launch failed"; return 1; }

  # Feature commit on the workstation, then merge into main and advance origin.
  echo feature >"$expect_wt/feature.txt"
  git -C "$expect_wt" add feature.txt
  git -C "$expect_wt" commit -q -m "feature on workstation"
  git -C "$repo" checkout -q main
  git -C "$repo" merge -q --no-ff "dev/recycle-ok" -m "merge workstation"
  echo later >"$repo/later.txt"
  git -C "$repo" add later.txt
  git -C "$repo" commit -q -m "main advances"
  git -C "$repo" push -q origin main
  git -C "$repo" fetch -q origin
  local origin_tip
  origin_tip="$(git -C "$repo" rev-parse origin/HEAD)"

  # Merged temp branch vs unmerged wip.
  git -C "$repo" branch backup/old "$origin_tip"
  git -C "$repo" branch wip/keep
  # Make wip/keep diverge so it is not an ancestor of origin/HEAD.
  git -C "$repo" checkout -q wip/keep
  echo keep >"$repo/keep.txt"
  git -C "$repo" add keep.txt
  git -C "$repo" commit -q -m "unmerged wip"
  git -C "$repo" checkout -q main

  mkdir -p "$expect_wt/.scratch" "$expect_wt/.ticket"
  echo junk >"$expect_wt/.scratch/tmp.log"
  echo ticket >"$expect_wt/.ticket/note.md"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  WT_RECYCLE_NO_CONFIRM=1 \
  "$WORKTREE_TASK" recycle \
    --worktree-root "$expect_wt" \
    -y \
    --task "wire hotkey next" \
    --fresh-agent >/dev/null \
    || { assert_fail "recycle happy path failed"; return 1; }

  [[ "$(git -C "$expect_wt" rev-parse HEAD)" == "$origin_tip" ]] \
    && assert_pass "workstation HEAD matches origin/HEAD" \
    || { assert_fail "HEAD not reset to origin/HEAD"; return 1; }

  [[ "$(git -C "$expect_wt" symbolic-ref --short HEAD)" == "dev/recycle-ok" ]] \
    && assert_pass "branch name preserved" \
    || { assert_fail "branch name changed"; return 1; }

  local upstream=""
  upstream="$(git -C "$expect_wt" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
  [[ "$upstream" == "origin/dev/recycle-ok" ]] \
    && assert_pass "recycled branch tracks origin/<branch>" \
    || { assert_fail "expected upstream origin/dev/recycle-ok, got '${upstream:-none}'"; return 1; }

  git -C "$repo" fetch -q origin
  [[ "$(git -C "$expect_wt" rev-parse HEAD)" == "$(git -C "$repo" rev-parse origin/dev/recycle-ok)" ]] \
    && assert_pass "origin/<branch> matches recycled tip" \
    || { assert_fail "remote branch not synced to origin/HEAD tip"; return 1; }

  if git -C "$repo" show-ref --verify --quiet refs/heads/backup/old; then
    assert_fail "merged backup/old should have been pruned"
    return 1
  fi
  assert_pass "merged backup/old pruned"

  git -C "$repo" show-ref --verify --quiet refs/heads/wip/keep \
    && assert_pass "unmerged wip/keep kept" \
    || { assert_fail "wip/keep was pruned incorrectly"; return 1; }

  [[ ! -e "$expect_wt/.scratch" && ! -e "$expect_wt/.ticket" ]] \
    && assert_pass "debug dirs cleaned" \
    || { assert_fail "debug dirs still present"; return 1; }

  if [[ -e "$expect_wt/.task-brief.md" ]]; then
    assert_fail "must not write .task-brief.md into worktree"
    return 1
  fi
  assert_pass "no worktree task-brief file"

  [[ -f "$expect_wt/later.txt" ]] \
    && assert_pass "origin/HEAD content visible after recycle" \
    || { assert_fail "later.txt missing after reset"; return 1; }
}

# ---------- case 10: recycle scope ----------
case10_recycle_scope() {
  printf '\n=== case 10: recycle refuses ticket-*, aligns a bare workstation ===\n'

  local remote="$WORK_DIR/remote10.git"
  local repo="$WORK_DIR/origin10"
  git init -q --bare "$remote"
  setup_repo "$repo"
  git -C "$repo" remote add origin "$remote"
  git -C "$repo" push -q -u origin main
  git -C "$remote" symbolic-ref HEAD refs/heads/main
  git -C "$repo" remote set-head origin -a >/dev/null

  local ticket_wt="$WORK_DIR/.worktrees/origin10/ticket-req-1"
  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title req-1 \
    --task-slug ticket-req-1 \
    --branch ticket/req-1 \
    --base-ref HEAD \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "ticket launch failed"; return 1; }

  local stderr_file="$WORK_DIR/case10-stderr"
  if HOME="$SANDBOX_HOME" \
     WEZDECK_REPO="$REPO_ROOT" \
     "$WORKTREE_TASK" recycle \
       --worktree-root "$ticket_wt" \
       -y >/dev/null 2>"$stderr_file"; then
    assert_fail "recycle should refuse ticket-*"
    return 1
  fi
  grep -qi "agent-collab" "$stderr_file" \
    && assert_pass "refusal names the owner" \
    || { assert_fail "unclear refusal: $(cat "$stderr_file")"; return 1; }
  [[ -d "$ticket_wt" ]] && assert_pass "ticket worktree left in place" \
    || { assert_fail "ticket worktree disappeared"; return 1; }

  # a bare-name workstation on a stray branch: recycle aligns it to dev/<name>
  local ws_wt="$WORK_DIR/.worktrees/origin10/ux"
  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title ux \
    --task-slug ux \
    --branch wip/ux \
    --base-ref HEAD \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "workstation launch failed"; return 1; }
  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" recycle \
    --worktree-root "$ws_wt" \
    -y >/dev/null \
    || { assert_fail "recycle of a bare-name workstation failed"; return 1; }
  [[ "$(git -C "$ws_wt" branch --show-current)" == dev/ux ]] \
    && assert_pass "bare workstation aligned to dev/ux" \
    || { assert_fail "branch: $(git -C "$ws_wt" branch --show-current)"; return 1; }
}

# ---------- case 11: squash merge + stale remote sync ----------
case11_recycle_squash_and_sync_remote() {
  printf '\n=== case 11: recycle squash-merged tip + sync stale remote ===\n'

  local remote="$WORK_DIR/remote11.git"
  local repo="$WORK_DIR/origin11"
  git init -q --bare "$remote"
  setup_repo "$repo"
  git -C "$repo" remote add origin "$remote"
  git -C "$repo" push -q -u origin main
  git -C "$remote" symbolic-ref HEAD refs/heads/main
  git -C "$repo" remote set-head origin -a >/dev/null

  local slug="dev-recycle-squash"
  local expect_wt="$WORK_DIR/.worktrees/origin11/$slug"
  local branch="dev/recycle-squash"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title recycle-squash \
    --task-slug "$slug" \
    --branch "$branch" \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "launch failed"; return 1; }

  echo squash-me >"$expect_wt/feature.txt"
  git -C "$expect_wt" add feature.txt
  git -C "$expect_wt" commit -q -m "workstation feature"
  local old_tip
  old_tip="$(git -C "$expect_wt" rev-parse HEAD)"

  # Publish the pre-squash tip so origin/<branch> exists and later needs rewrite.
  git -C "$expect_wt" push -q -u origin "$branch"

  # Squash into main: content lands, original SHA does not.
  git -C "$repo" checkout -q main
  git -C "$repo" merge -q --squash "$branch"
  git -C "$repo" commit -q -m "squash workstation feature"
  echo later >"$repo/later.txt"
  git -C "$repo" add later.txt
  git -C "$repo" commit -q -m "main advances after squash"
  git -C "$repo" push -q origin main
  git -C "$repo" fetch -q origin
  local origin_tip
  origin_tip="$(git -C "$repo" rev-parse origin/HEAD)"

  # SHA ancestry must fail (squash), content absorption must pass.
  if git -C "$repo" merge-base --is-ancestor "$old_tip" "$origin_tip" 2>/dev/null; then
    assert_fail "fixture broken: old tip unexpectedly ancestor of origin/HEAD"
    return 1
  fi
  assert_pass "fixture: squash broke SHA ancestry"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  WT_RECYCLE_NO_CONFIRM=1 \
  "$WORKTREE_TASK" recycle \
    --worktree-root "$expect_wt" \
    -y >/dev/null \
    || { assert_fail "recycle should accept content-absorbed squash tip"; return 1; }

  [[ "$(git -C "$expect_wt" rev-parse HEAD)" == "$origin_tip" ]] \
    && assert_pass "local tip reset to origin/HEAD after squash" \
    || { assert_fail "local tip not on origin/HEAD"; return 1; }

  git -C "$repo" fetch -q origin
  [[ "$(git -C "$repo" rev-parse "origin/$branch")" == "$origin_tip" ]] \
    && assert_pass "stale origin/<branch> force-with-lease synced to base" \
    || { assert_fail "origin/$branch still stale"; return 1; }

  [[ -f "$expect_wt/later.txt" ]] \
    && assert_pass "post-squash main content visible" \
    || { assert_fail "later.txt missing"; return 1; }
}

# ---------- case 12: describe ----------
case12_describe() {
  printf '\n=== case 12: describe ===\n'

  local repo="$WORK_DIR/origin12"
  setup_repo "$repo"
  local wt="$WORK_DIR/.worktrees/origin12/docs"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title docs \
    --base-ref HEAD \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "launch failed"; return 1; }

  local out
  out="$(HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" "$WORKTREE_TASK" describe --cwd "$wt")"
  [[ -z "$out" ]] && assert_pass "no purpose yet" \
    || { assert_fail "unexpected purpose: $out"; return 1; }

  HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
    "$WORKTREE_TASK" describe --cwd "$wt" --set $'文档\n整理' >/dev/null \
    || { assert_fail "describe --set failed"; return 1; }
  # read from the primary checkout: the purpose lives in the shared config
  [[ "$(git -C "$repo" config branch.dev/docs.description)" == "文档 整理" ]] \
    && assert_pass "set flattens to one line, visible from every worktree" \
    || { assert_fail "stored: $(git -C "$repo" config branch.dev/docs.description)"; return 1; }
  out="$(HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" "$WORKTREE_TASK" describe --cwd "$wt")"
  [[ "$out" == "文档 整理" ]] && assert_pass "describe reads it back" \
    || { assert_fail "read back: $out"; return 1; }

  HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
    "$WORKTREE_TASK" describe --cwd "$wt" --clear >/dev/null \
    || { assert_fail "describe --clear failed"; return 1; }
  if git -C "$repo" config branch.dev/docs.description >/dev/null; then
    assert_fail "description still set after --clear"
    return 1
  fi
  assert_pass "clear removes it"

  if HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
     "$WORKTREE_TASK" describe --cwd "$wt" --set "   " >/dev/null 2>&1; then
    assert_fail "empty --set accepted"
    return 1
  fi
  assert_pass "empty --set refused"
}

# ---------- run ----------
case1_happy_path
case2_allow_long_lived_removed
case3_legacy_dev_reclaim
case4_create_prompt_preview
case5_open_task_window_workstation
case6_origin_default_no_tracking
case7_transcript_preserved
case8_recycle_undelivered
case9_recycle_happy
case10_recycle_scope
case11_recycle_squash_and_sync_remote
case12_describe

printf '\n=== summary ===\n'
printf 'pass=%d fail=%d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
echo PASS smoke
