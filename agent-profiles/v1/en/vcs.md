---
name: vcs
scope: user
triggers:
  - commit
  - branch
  - merge
  - rebase
  - push
  - open pull or merge request
tags: [git, commits, push, history-safety]
---

# VCS

## When To Read

When committing, branching, merging, rebasing, opening a pull/merge request, or making any other change to version-control state.

## When Not To Read

When the change is purely local edits and is not yet ready to enter version control.

## Default

- [vcs-01] Treat version-control state as user-owned history.
- [vcs-02] Do not modify shared or published state without explicit instruction.

## Hard Defaults

- [vcs-03] Never auto-commit. Commit only when the user asks.
- [vcs-04] Never auto-push. Push only when the user asks.
- [vcs-05] Never skip hooks (`--no-verify`, `--no-gpg-sign`, etc.) unless the user explicitly authorizes it.
- [vcs-06] Never force-push to a protected or main branch. Warn the user if they request it.
- [vcs-07] Prefer creating a new commit over amending a previously published commit.
- [vcs-08] Stage specific files by name. Avoid `git add -A` / `git add .` because they may include secrets, generated files, or unrelated changes.

## Core VCS: personal projects prefer mainline (OpenClaw L0-13)

**Core rule (cross-surface):** for **personal, owner-maintained** repos with no parallel collaboration, prefer **direct development on the default branch** (`master`/`main`) to maximize throughput. Do not invent branches/worktrees for ceremony.

- [vcs-30] **Personal project default:** develop, commit, and (when the user has authorized delivery) push on the primary default branch.
- [vcs-31] **Branch/worktree only when needed:** parallel tasks, long experiments, large rollback risk, or isolation from another live agent on the same tree.
- [vcs-32] **Linear history:** rebase + fast-forward; do not invent merge commits for ceremony.
- [vcs-33] **Author** = repo owner identity (not a bot name). Optional trailer when an agent assisted: `Assisted-by: OpenClaw (backend=…, model=…)` (OpenClaw L0-20 trailer rules).

### Instance: wezdeck

- [vcs-34] wezdeck (`wezterm-config`) is a personal monorepo: default **primary `master`**; after acceptance **push `master` without a second "merge to main?"** question. Force-push still needs explicit yes.

### Shared / team repos

- [vcs-35] Shared/team repos keep [vcs-03]–[vcs-06] strictly; do **not** assume personal mainline-push rights (e.g. team repos still prefer isolation / explicit yes for main unless the user sets otherwise).

## Commit Granularity

- [vcs-09] One commit, one coherent change.
- [vcs-10] Separate refactor from behavior change when practical.
- [vcs-11] If a task contains both, land the refactor first and the behavior change second.

## Commit Messages

- [vcs-12] Match the existing project style; read recent log before composing.
- [vcs-13] Use the body to explain *why* when the *what* alone is not enough.
- [vcs-14] Do not invent a convention if the project has none. Keep it short and descriptive.

## Conflicts And Recovery

- [vcs-15] Investigate before destructive operations (`git reset --hard`, `git checkout --`, `git clean -f`, branch deletion).
- [vcs-16] Resolve merge conflicts. Do not discard the conflicting side as a shortcut.
- [vcs-17] Lock files, unfamiliar branches, or untracked files may represent the user's in-progress work. Verify before deleting.

## Pull / Merge Requests

- [vcs-18] Create one only when the user asks.
- [vcs-19] Keep the title short. Put details in the body.
- [vcs-20] Summarize the full diff since divergence from the base branch, not only the latest commit.

## Concurrency

- [vcs-21] Do not run git commands that contend on the index lock in parallel.

## Reporting

After any commit, push, or PR action, report:

- [vcs-22] the action taken
- [vcs-23] the visible side effect (commit SHA, branch state, PR URL)
- [vcs-24] whether anything still needs the user's confirmation

## Examples

Good — honors [vcs-03], [vcs-08], [vcs-09]: waits for the user to ask, stages named files, one coherent change.

```
$ git add src/cache.ts tests/test_cache.ts
$ git commit -m "fix(cache): evict under memory pressure"
```

> Committed only after the user said "commit this". Staged the two files that belong to the fix. Message matches the repo's Conventional Commits style.

Bad — violates [vcs-03] and [vcs-08]: agent commits without being asked, and blanket-stages everything.

```
# user asked the agent to "fix the cache bug"; agent proceeds to:
$ git add -A
$ git commit -m "wip"
```

> User never asked to commit. `git add -A` silently stages unrelated edits and possible secrets.
