---
name: task-ledger
description: >
  Ledger development tasks to Feishu Base via dev-task-ledger.sh.
  Development tasks are 团队仓 only for now. Use on accept/confirm/close
  of coding work; not for pure Q&A.
---

# Development task ledger (Feishu Base)

## Hard rules

1. Development tasks **must** target **团队仓** only, under the runtime
   path allowlist (see Path guard). Do not hard-code another machine's
   `/home/...` paths in prompts or commits.
2. If the user asks for another repo: **do not** `open` a ledger row as accepted
   work; refuse and explain 团队仓-only policy.
3. When accepted:
   - `open` → `confirm` (if required) → `close` (`done`/`failed`/`cancelled`/`blocked`)
4. Never write secrets into the ledger.
5. Final reply **must** include `task_id`.
6. If CLI fails, say so; do not invent `task_id`.

## Path guard

- Local env `OPENCLAW_TASKS_ALLOWED_ROOTS` (colon-separated) overrides defaults.
- Defaults (portable): `$HOME/work/team-repo` and `$HOME/work/.worktrees/team-repo`.
- CLI rejects `--repo` / `--cwd` outside the allowlist.

## CLI

```bash
# from wezterm-config checkout, or $WEZTERM_REPO if set
./openclaw/scripts/dev-task-ledger.sh open \
  --title "…" \
  --repo "$HOME/work/team-repo" \
  --cwd "$HOME/work/team-repo" \
  --scope "packages/… or apps/…" \
  --acceptance "pnpm --filter … test" \
  --risk low|medium|high \
  --source feishu \
  --confirm-required 1

./openclaw/scripts/dev-task-ledger.sh confirm --task-id <uuid>

./openclaw/scripts/dev-task-ledger.sh close \
  --task-id <uuid> \
  --status done|failed|cancelled|blocked \
  --summary "…" \
  --branch "…" \
  --commits "abc1234" \
  --mr "https://…"
```

Config: `~/.config/shell-env.d/openclaw-tasks.env` (local only; never commit filled file).

## Flow

1. Path guard → 团队仓 allowlist.
2. `open` (status `open`/`planned`) — may still point at primary repo path.
3. Plan → user confirm when needed → `confirm`.
4. Create **`claw-*` worktree** (`claw-worktree.sh create`); `update` ledger
   `cwd` + `分支` to that worktree (never human `dev-*`/`task-*`/`hotfix-*`).
5. Implement only under the claw worktree `cwd`.
6. `close` + report with `task_id`.
7. **Ask** if the user wants reclaim (do not auto-reclaim). Prefer keep for
   `claw-dev-*`; for task/hotfix offer reclaim only after user yes.
