---
name: dev-task
description: >
  Single-repo development under OpenClaw, currently 团队仓 only.
  Use when the user asks to implement, fix, refactor, or verify code in
  团队仓 (primary checkout or its worktrees).
---

# Dev task (团队仓 only)

## When to use

- Implementation / fix / refactor / tests targeting **团队仓**.
- Paths under the runtime allowlist (see below), not hard-coded host paths.

## When not to use

- Pure Q&A with no file changes.
- Any other repository — **refuse development**; do not open a ledger task.
- Destructive or production operations without explicit user confirm.

## Path guard

Allowed roots (runtime):

1. `OPENCLAW_TASKS_ALLOWED_ROOTS` from local env if set (machine-specific;
   never invent or commit another user's absolute path).
2. Else defaults used by `dev-task-ledger.sh`:
   - `$HOME/work/team-repo`
   - `$HOME/work/.worktrees/team-repo/` (prefix)

If the user says "team-repo" without a path, default `cwd`/`repo` to
`$HOME/work/team-repo` when that directory exists; otherwise ask for the
absolute path and verify it is under the allowlist.

Also follow 团队仓 `AGENTS.md` progressive disclosure once inside the repo.

## Steps

1. **Ledger open** (`skills/task-ledger`) with allowlisted paths only.
2. **Plan** — packages/apps touched, acceptance (`pnpm --filter …` preferred),
   risk; wait for confirm when medium/high or confirm-required.
3. **Isolate** — branch or worktree under 团队仓 layout if needed.
4. **Implement** — stay inside allowed `cwd`; exec allowlist still applies.
5. **Ledger close** + completion report with `task_id`.

## Hard rules

- 团队仓 only (runtime allowlist).
- One writer per working tree.
- No push to `main`/`master`, no force-push without explicit user confirm.
- Completion always includes resume pointers and **`task_id`**.
