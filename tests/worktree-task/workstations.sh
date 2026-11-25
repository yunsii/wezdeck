#!/usr/bin/env bash
# workstations.sh — worktree-task directions, idle and reuse (split out of
# smoke.sh, which sits at its line budget). Same isolation: throwaway repos
# under /tmp, a sandboxed HOME, the `none` provider (no tmux, no agent).
#
# Cases:
#  13. idle: clean + delivered into origin/HEAD (pushed-only is not idle).
#  14. a taken name opens a parallel slot of that direction (marker +
#      inherited purpose); no direction is guessed from a -N suffix.
#  15. reuse-workstation refuses a busy slot and resets an idle one.

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

# ---------- shared: a repo with origin and origin/HEAD ----------
setup_remote_repo() {
  local name="$1"
  local remote="$WORK_DIR/$name.git" repo="$WORK_DIR/$name"
  git init -q --bare "$remote"
  setup_repo "$repo"
  git -C "$repo" remote add origin "$remote"
  git -C "$repo" push -q -u origin main
  git -C "$remote" symbolic-ref HEAD refs/heads/main
  git -C "$repo" remote set-head origin -a >/dev/null
}

wt_launch() { # repo slug [extra launch args…]
  local repo="$1" slug="$2"
  shift 2
  HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
    "$WORKTREE_TASK" launch --cwd "$repo" --title "$slug" --task-slug "$slug" \
    --provider none --no-attach "$@" >/dev/null
}

idle_state() { # worktree → state
  HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
    "$WORKTREE_TASK" idle --cwd "$1" 2>/dev/null | sed -n 's/^state=//p'
}

# ---------- case 13: idle ----------
case13_idle() {
  printf '\n=== case 13: idle (clean + delivered into origin/HEAD) ===\n'
  setup_remote_repo origin13
  local repo="$WORK_DIR/origin13" wt="$WORK_DIR/.worktrees/origin13/ux"
  wt_launch "$repo" ux || { assert_fail "launch failed"; return 1; }

  [[ "$(idle_state "$wt")" == idle ]] && assert_pass "fresh workstation is idle" \
    || { assert_fail "fresh: $(idle_state "$wt")"; return 1; }
  [[ "$(idle_state "$repo")" == primary ]] && assert_pass "primary is not a workstation" \
    || { assert_fail "primary: $(idle_state "$repo")"; return 1; }

  echo wip >"$wt/wip.txt"
  [[ "$(idle_state "$wt")" == dirty ]] && assert_pass "untracked file → dirty" \
    || { assert_fail "dirty: $(idle_state "$wt")"; return 1; }
  mkdir -p "$wt/.scratch" && mv "$wt/wip.txt" "$wt/.scratch/"
  [[ "$(idle_state "$wt")" == idle ]] && assert_pass "allowlisted leftovers do not count" \
    || { assert_fail "allowlisted: $(idle_state "$wt")"; return 1; }

  echo work >"$wt/feature.txt"
  git -C "$wt" add feature.txt
  git -C "$wt" commit -q -m feature
  [[ "$(idle_state "$wt")" == undelivered ]] && assert_pass "local commit → undelivered" \
    || { assert_fail "undelivered: $(idle_state "$wt")"; return 1; }
  git -C "$wt" push -q -u origin dev/ux
  [[ "$(idle_state "$wt")" == undelivered ]] \
    && assert_pass "pushed to origin/dev/ux but not merged → still undelivered (recycle would rewrite it)" \
    || { assert_fail "pushed-only: $(idle_state "$wt")"; return 1; }
  git -C "$repo" merge -q --ff-only dev/ux
  git -C "$repo" push -q origin main
  git -C "$repo" fetch -q origin
  [[ "$(idle_state "$wt")" == idle ]] && assert_pass "merged into origin/HEAD → idle" \
    || { assert_fail "merged: $(idle_state "$wt")"; return 1; }
}

# ---------- case 14: parallel slots of a direction ----------
case14_parallel_slots() {
  printf '\n=== case 14: a taken name opens a parallel slot ===\n'
  local repo="$WORK_DIR/origin14"
  setup_repo "$repo"
  open14() {
    ( cd "$repo" && HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
      WT_QUICK_CREATE_BASE_REF=HEAD WT_QUICK_CREATE_PROVIDER=none WT_QUICK_CREATE_PROVIDER_MODE=off \
      "$OPEN_TASK_WINDOW" "$@" >/dev/null )
  }
  open14 --description "网页控制台" -- ux || { assert_fail "first ux failed"; return 1; }

  local preview
  preview="$(cd "$repo" && HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" "$CREATE_PROMPT" --preview ux)"
  grep -qx 'parallel_of=ux' <<<"$preview" && grep -qx 'slug=ux-2' <<<"$preview" \
    && assert_pass "preview: ux is taken by a workstation → parallel ux-2" \
    || { assert_fail "preview: $preview"; return 1; }

  open14 -- ux || { assert_fail "second ux failed"; return 1; }
  [[ "$(git -C "$repo" config branch.dev/ux-2.workstationDirection)" == ux ]] \
    && assert_pass "ux-2 is marked as a slot of ux" \
    || { assert_fail "no direction marker on dev/ux-2"; return 1; }
  [[ "$(git -C "$repo" config branch.dev/ux-2.description)" == "网页控制台" ]] \
    && assert_pass "ux-2 inherits the purpose" \
    || { assert_fail "purpose not inherited"; return 1; }
  open14 --description "列表页" -- ux || { assert_fail "third ux failed"; return 1; }
  [[ "$(git -C "$repo" config branch.dev/ux-3.description)" == "列表页" ]] \
    && assert_pass "a typed purpose wins over the inherited one" \
    || { assert_fail "typed purpose lost"; return 1; }

  # a direction named ci-2 is its own direction, not a slot of ci
  open14 -- ci-2 || { assert_fail "ci-2 failed"; return 1; }
  if git -C "$repo" config branch.dev/ci-2.workstationDirection >/dev/null; then
    assert_fail "ci-2 was guessed into a direction"
    return 1
  fi
  assert_pass "no direction guessed from a -N suffix"

  local slots
  slots="$(bash -c 'source "$1/scripts/runtime/worktree/lib/helpers.sh"; source "$1/scripts/runtime/worktree/lib/workstation.sh"; WT_POLICY_BRANCH_PREFIX=dev/ wt_workstation_slots "$2" ux' _ "$REPO_ROOT" "$repo" | cut -f2 | tr '\n' ' ')"
  [[ "$slots" == "dev/ux dev/ux-2 dev/ux-3 " ]] && assert_pass "slots of ux: ux, ux-2, ux-3" \
    || { assert_fail "slots: '$slots'"; return 1; }
}

# ---------- case 15: reuse-workstation ----------
case15_reuse() {
  printf '\n=== case 15: reuse an idle workstation ===\n'
  setup_remote_repo origin15
  local repo="$WORK_DIR/origin15" wt="$WORK_DIR/.worktrees/origin15/ux"
  local reuse="$REPO_ROOT/scripts/runtime/worktree/reuse-workstation"
  wt_launch "$repo" ux --description "网页" || { assert_fail "launch failed"; return 1; }
  run_reuse() {
    HOME="$SANDBOX_HOME" WEZDECK_REPO="$REPO_ROOT" \
      WT_QUICK_CREATE_PROVIDER=none WT_QUICK_CREATE_PROVIDER_MODE=off \
      "$reuse" --no-attach "$wt"
  }

  echo wip >"$wt/wip.txt"
  local rc=0
  run_reuse >/dev/null 2>"$WORK_DIR/case15-stderr" || rc=$?
  [[ "$rc" == 3 ]] && grep -q "not idle (dirty)" "$WORK_DIR/case15-stderr" \
    && assert_pass "a dirty workstation is refused (exit 3)" \
    || { assert_fail "dirty reuse rc=$rc: $(cat "$WORK_DIR/case15-stderr")"; return 1; }
  [[ -f "$wt/wip.txt" ]] && assert_pass "and its changes are untouched" \
    || { assert_fail "wip.txt lost"; return 1; }
  rm "$wt/wip.txt"

  # main moves on; the idle workstation then starts its new round there
  echo later >"$repo/later.txt"
  git -C "$repo" add later.txt
  git -C "$repo" commit -q -m later
  git -C "$repo" push -q origin main
  local out
  out="$(run_reuse 2>"$WORK_DIR/case15-stderr")" \
    || { assert_fail "reuse failed: $(cat "$WORK_DIR/case15-stderr")"; return 1; }
  grep -q '^reused=1$' <<<"$out" && grep -q "^worktree_path=$wt$" <<<"$out" \
    && assert_pass "reuse reports the workstation" \
    || { assert_fail "output: $out"; return 1; }
  [[ "$(git -C "$wt" rev-parse HEAD)" == "$(git -C "$repo" rev-parse origin/HEAD)" ]] \
    && assert_pass "reset onto the latest origin/HEAD" \
    || { assert_fail "not on origin/HEAD"; return 1; }
  [[ "$(git -C "$wt" branch --show-current)" == dev/ux && "$(git -C "$repo" config branch.dev/ux.description)" == 网页 ]] \
    && assert_pass "same directory, branch and purpose" \
    || { assert_fail "branch/purpose changed"; return 1; }
}

# ---------- run ----------
case13_idle
case14_parallel_slots
case15_reuse

printf '\n=== summary ===\npass=%d fail=%d\n' "$PASS" "$FAIL"
if (( FAIL > 0 )); then
  printf 'FAIL workstations\n'
  exit 1
fi
printf 'PASS workstations\n'
