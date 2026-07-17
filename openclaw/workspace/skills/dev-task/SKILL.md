---
name: dev-task
description: >
  团队仓 development under OpenClaw: always use an isolated claw-* worktree,
  never human WezDeck dev-/task-/hotfix-* trees or the primary checkout for writes.
---

# Dev task (团队仓 + claw worktree)

## When to use

- Implement / fix / refactor / test in **团队仓** only.

## When not to use

- Pure Q&A (no file changes).
- Other repos — refuse.
- Requests to “continue in my existing task-*/dev-* worktree” for **writes** —
  refuse to write there; offer a new `claw-*` worktree (read-only peek OK).

## Path + worktree guards

**Repo allowlist:** runtime roots from `OPENCLAW_TASKS_ALLOWED_ROOTS` or
`$HOME/work/team-repo` + `$HOME/work/.worktrees/team-repo`.

**Worktree ownership:**

| Prefix | Owner | Claw may |
| --- | --- | --- |
| primary root | human | read only for task work |
| `dev-*` / `task-*` / `hotfix-*` | human (WezDeck) | **read only**; never create/reclaim/write |
| `claw-*` | OpenClaw | create, write, reclaim |

## Steps

1. **Ledger open** (task-ledger) — status planned/open; repo 团队仓.
2. **Plan** — scope, acceptance, risk; wait for confirm if needed.
3. **Create claw worktree** (mandatory for writes):

   ```bash
   WT=$(./openclaw/scripts/claw-worktree.sh create \
     --title "<subject>" --cwd "$HOME/work/team-repo")
   # use $WT as cwd for all subsequent work
   ```

   - Dir: `.worktrees/team-repo/claw-<slug>/`
   - Branch: `claw/<slug>`
   - Provider: none (no tmux attach; headless)

4. **Ledger update** — set `cwd` / `分支` to the claw worktree values.
5. **Implement** only under that `cwd`; run filtered tests.
6. **Ledger close** with summary + commits.
7. **Reclaim** when delivered and user did not ask to keep the tree:

   ```bash
   ./openclaw/scripts/claw-worktree.sh reclaim --slug claw-<slug> \
     --cwd "$HOME/work/team-repo"
   ```

## Hard rules

- Never overwrite or reuse human worktrees for claw tasks.
- Never write task changes on primary checkout.
- One claw worktree per task; one writer per tree.
- No push to main/master / force-push without explicit user confirm.
- Completion report includes `task_id`, claw `cwd`, branch, reclaim status.
