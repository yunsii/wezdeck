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
#   2. dev-* prefix refusal: reclaim of a dev-* worktree refuses by default
#      with a clear error and leaves the worktree in place.
#   3. dev-* explicit allow: reclaim of a dev-* worktree succeeds when
#      --allow-long-lived is passed.
#   4. create-prompt preview: lifecycle prompt computes final title, slug,
#      worktree path, and branch before launch.
#   5. open-task-window lifecycle names: quick-create uses lifecycle only
#      for the local worktree slug and keeps branch names type-scoped.
#   6. origin-default-branch launch: branch starts from origin/HEAD but
#      does not track the default branch as upstream.
#   7. transcript preserved across reclaim.
#   8. recycle refuses undelivered workstation commits.
#   9. recycle happy path: reset to origin/HEAD, prune merged temp branch,
#      clean debug dirs, write next-task brief, sync origin/<branch>.
#  10. recycle refuses task-* (short-lived trees use reclaim).
#  11. recycle accepts squash-merged tip (content absorbed) and force-with-lease
#      syncs a stale origin/<branch>.
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

  git -C "$repo" branch --list "task/$slug" | grep -q "task/$slug" \
    && assert_pass "branch present" \
    || { assert_fail "branch task/$slug missing"; return 1; }

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" reclaim \
    --cwd "$repo" \
    --task-slug "$slug" \
    --provider none >/dev/null \
    || { assert_fail "reclaim returned non-zero"; return 1; }

  [[ ! -d "$expect_wt" ]] && assert_pass "worktree dir gone" \
    || { assert_fail "worktree dir still present after reclaim"; return 1; }

  if git -C "$repo" branch --list "task/$slug" | grep -q "task/$slug"; then
    assert_fail "branch task/$slug still present after reclaim"
    return 1
  fi
  assert_pass "branch gone"

  if git -C "$repo" worktree list --porcelain | grep -q "$expect_wt"; then
    assert_fail "phantom worktree entry remains"
    return 1
  fi
  assert_pass "no phantom worktree entry"
}

# ---------- case 2: dev-* default refusal ----------
case2_dev_refusal() {
  printf '\n=== case 2: dev-* prefix refusal ===\n'

  local repo="$WORK_DIR/origin2"
  setup_repo "$repo"
  local slug="dev-billing"
  local expect_wt="$WORK_DIR/.worktrees/origin2/$slug"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title "$slug" \
    --base-ref HEAD \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "launch returned non-zero for dev-* slug"; return 1; }

  [[ -d "$expect_wt" ]] || { assert_fail "dev-* worktree not created"; return 1; }
  assert_pass "dev-* worktree created (launch is allowed)"

  # Reclaim must refuse with a recognizable message.
  local stderr_file="$WORK_DIR/case2-stderr"
  if HOME="$SANDBOX_HOME" \
     WEZDECK_REPO="$REPO_ROOT" \
     "$WORKTREE_TASK" reclaim \
       --cwd "$repo" \
       --task-slug "$slug" \
       --provider none >/dev/null 2>"$stderr_file"; then
    assert_fail "reclaim of $slug should have failed but succeeded"
    return 1
  fi
  assert_pass "reclaim of dev-* refused (non-zero exit)"

  if grep -qiE "long-lived|dev-billing" "$stderr_file"; then
    assert_pass "refusal message mentions long-lived/dev-billing"
  else
    assert_fail "refusal message unclear: $(cat "$stderr_file")"
    return 1
  fi

  [[ -d "$expect_wt" ]] && assert_pass "dev-* worktree still present after refused reclaim" \
    || { assert_fail "dev-* worktree was removed despite refusal"; return 1; }

  # Manual cleanup so case 3 starts clean.
  git -C "$repo" worktree remove -f "$expect_wt" >/dev/null 2>&1 || true
}

# ---------- case 3: dev-* explicit allow ----------
case3_dev_allow_long_lived() {
  printf '\n=== case 3: dev-* explicit allow ===\n'

  local repo="$WORK_DIR/origin3"
  setup_repo "$repo"
  local slug="dev-ci-fix"
  local expect_wt="$WORK_DIR/.worktrees/origin3/$slug"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title "$slug" \
    --base-ref HEAD \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "launch returned non-zero for dev-* slug"; return 1; }

  [[ -d "$expect_wt" ]] || { assert_fail "dev-* worktree not created"; return 1; }
  assert_pass "dev-* worktree created for explicit allow"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" reclaim \
    --cwd "$repo" \
    --task-slug "$slug" \
    --allow-long-lived \
    --provider none >/dev/null \
    || { assert_fail "reclaim with --allow-long-lived failed"; return 1; }

  [[ ! -d "$expect_wt" ]] && assert_pass "dev-* worktree gone after explicit allow" \
    || { assert_fail "dev-* worktree still present after explicit allow"; return 1; }
}

# ---------- case 4: create-prompt preview ----------
case4_create_prompt_preview() {
  printf '\n=== case 4: create-prompt preview ===\n'

  local repo="$WORK_DIR/origin4"
  setup_repo "$repo"
  local preview

  preview="$(
    cd "$repo"
    HOME="$SANDBOX_HOME" \
    WEZDECK_REPO="$REPO_ROOT" \
    "$CREATE_PROMPT" --type dev --preview "ci fix"
  )"

  grep -qx 'subject=ci fix' <<<"$preview" \
    && assert_pass "preview preserves subject title" \
    || { assert_fail "preview subject mismatch: $preview"; return 1; }
  grep -qx 'subject_slug=ci-fix' <<<"$preview" \
    && assert_pass "preview slugifies subject" \
    || { assert_fail "preview subject slug mismatch: $preview"; return 1; }
  grep -qx 'worktree_slug=dev-ci-fix' <<<"$preview" \
    && assert_pass "preview applies dev lifecycle to worktree slug" \
    || { assert_fail "preview title mismatch: $preview"; return 1; }
  grep -qx "worktree=$WORK_DIR/.worktrees/origin4/dev-ci-fix" <<<"$preview" \
    && assert_pass "preview shows final worktree path" \
    || { assert_fail "preview worktree mismatch: $preview"; return 1; }
  grep -qx 'branch=dev/ci-fix' <<<"$preview" \
    && assert_pass "preview shows final branch" \
    || { assert_fail "preview branch mismatch: $preview"; return 1; }

  git -C "$repo" branch dev/ci-fix
  preview="$(
    cd "$repo"
    HOME="$SANDBOX_HOME" \
    WEZDECK_REPO="$REPO_ROOT" \
    "$CREATE_PROMPT" --type dev --preview "ci fix"
  )"
  grep -qx 'worktree_slug=dev-ci-fix-2' <<<"$preview" \
    && assert_pass "preview bumps colliding worktree slug" \
    || { assert_fail "preview did not bump collision: $preview"; return 1; }
  grep -qx 'branch=dev/ci-fix-2' <<<"$preview" \
    && assert_pass "preview bumps colliding branch" \
    || { assert_fail "preview did not bump branch: $preview"; return 1; }
}

# ---------- case 5: open-task-window lifecycle names ----------
case5_open_task_window_lifecycle_names() {
  printf '\n=== case 5: open-task-window lifecycle names ===\n'

  local repo="$WORK_DIR/origin5"
  setup_repo "$repo"
  local expect_wt="$WORK_DIR/.worktrees/origin5/task-ci-fix"

  (
    cd "$repo"
    HOME="$SANDBOX_HOME" \
    WEZDECK_REPO="$REPO_ROOT" \
    MANAGED_AGENT_PROFILE=claude \
    WT_QUICK_CREATE_BASE_REF=HEAD \
    WT_QUICK_CREATE_PROVIDER=none \
    WT_QUICK_CREATE_PROVIDER_MODE=off \
    "$OPEN_TASK_WINDOW" --type task -- "ci fix" >/dev/null
  ) || { assert_fail "open-task-window task quick-create failed"; return 1; }

  [[ -d "$expect_wt" ]] && assert_pass "quick-create worktree uses lifecycle slug" \
    || { assert_fail "quick-create worktree missing: $expect_wt"; return 1; }
  git -C "$repo" branch --list "task/ci-fix" | grep -q "task/ci-fix" \
    && assert_pass "quick-create branch uses type prefix plus subject" \
    || { assert_fail "branch task/ci-fix missing"; return 1; }
  if git -C "$repo" branch --list "task/task-ci-fix" | grep -q "task/task-ci-fix"; then
    assert_fail "legacy duplicated branch task/task-ci-fix was created"
    return 1
  fi
  assert_pass "quick-create avoids duplicated branch prefix"
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

# ---------- case 8: recycle refuses undelivered work ----------
case8_recycle_undelivered() {
  printf '\n=== case 8: recycle refuses undelivered ===\n'

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
       -y >/dev/null 2>"$stderr_file"; then
    assert_fail "recycle should refuse undelivered branch"
    return 1
  fi
  assert_pass "recycle refused undelivered"
  [[ "$(git -C "$expect_wt" rev-parse HEAD)" == "$before" ]] \
    && assert_pass "tip unchanged after refused recycle" \
    || { assert_fail "tip moved despite refusal"; return 1; }
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

  mkdir -p "$expect_wt/.scratch" "$expect_wt/.delegate"
  echo junk >"$expect_wt/.scratch/tmp.log"
  echo ticket >"$expect_wt/.delegate/note.md"

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

  [[ ! -e "$expect_wt/.scratch" && ! -e "$expect_wt/.delegate" ]] \
    && assert_pass "debug dirs cleaned" \
    || { assert_fail "debug dirs still present"; return 1; }

  [[ -f "$expect_wt/.task-brief.md" ]] \
    && grep -q "wire hotkey next" "$expect_wt/.task-brief.md" \
    && assert_pass "next-task brief written" \
    || { assert_fail "brief missing or wrong"; return 1; }

  [[ -f "$expect_wt/later.txt" ]] \
    && assert_pass "origin/HEAD content visible after recycle" \
    || { assert_fail "later.txt missing after reset"; return 1; }
}

# ---------- case 10: recycle refuses task-* ----------
case10_recycle_refuses_task_slug() {
  printf '\n=== case 10: recycle refuses task-* ===\n'

  local repo="$WORK_DIR/origin10"
  setup_repo "$repo"
  local slug="task-recycle-no"
  local expect_wt="$WORK_DIR/.worktrees/origin10/$slug"

  HOME="$SANDBOX_HOME" \
  WEZDECK_REPO="$REPO_ROOT" \
  "$WORKTREE_TASK" launch \
    --cwd "$repo" \
    --title recycle-no \
    --task-slug "$slug" \
    --branch "task/recycle-no" \
    --base-ref HEAD \
    --provider none \
    --no-attach >/dev/null \
    || { assert_fail "launch failed"; return 1; }

  local stderr_file="$WORK_DIR/case10-stderr"
  if HOME="$SANDBOX_HOME" \
     WEZDECK_REPO="$REPO_ROOT" \
     "$WORKTREE_TASK" recycle \
       --worktree-root "$expect_wt" \
       -y >/dev/null 2>"$stderr_file"; then
    assert_fail "recycle should refuse task-* slug"
    return 1
  fi
  if grep -qiE "dev-\*|long-lived|reclaim" "$stderr_file"; then
    assert_pass "refusal points at reclaim / dev-* scope"
  else
    assert_fail "unclear refusal: $(cat "$stderr_file")"
    return 1
  fi
  [[ -d "$expect_wt" ]] && assert_pass "task worktree left in place" \
    || { assert_fail "task worktree disappeared"; return 1; }
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

# ---------- run ----------
case1_happy_path
case2_dev_refusal
case3_dev_allow_long_lived
case4_create_prompt_preview
case5_open_task_window_lifecycle_names
case6_origin_default_no_tracking
case7_transcript_preserved
case8_recycle_undelivered
case9_recycle_happy
case10_recycle_refuses_task_slug
case11_recycle_squash_and_sync_remote

printf '\n=== summary ===\n'
printf 'pass=%d fail=%d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
echo PASS smoke
