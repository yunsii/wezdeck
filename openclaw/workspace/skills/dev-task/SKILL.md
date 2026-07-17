---
name: dev-task
description: >
  团队仓 development under OpenClaw with WezDeck-aligned lifecycle worktrees
  (claw-task/dev/hotfix), mandatory assess before create, never human worktrees.
---

# Dev task (团队仓 + claw lifecycle worktrees)

## When to use

Write work in **团队仓** only.

## Worktree model (mirrors WezDeck)

| Kind | Claw dir | Claw branch | Human analogue |
| --- | --- | --- | --- |
| task | `claw-task-<domain?>-<subject>` | `claw/task/…` | `task-*` |
| dev | `claw-dev-<domain?>-<subject>` | `claw/dev/…` | `dev-*` |
| hotfix | `claw-hotfix-<domain?>-<subject>` | `claw/hotfix/…` | `hotfix-*` |

Human `dev-*` / `task-*` / `hotfix-*` (no `claw-`) are **read-only** for claw.

## Steps

1. Ledger `open`.
2. **Assess** (mandatory for new write trees):

   ```bash
   ./openclaw/scripts/claw-worktree.sh assess \
     --title "…" --domain "i18n" --scope "apps/…" --days 3
   ```

   Present 初评 to the user (lifecycle, slug, branch, reclaim rule). Wait for
   confirm on non-trivial tasks.

3. **Create** after confirm:

   ```bash
   WT=$(./openclaw/scripts/claw-worktree.sh create \
     --title "…" --lifecycle task --domain i18n \
     --cwd "$HOME/work/team-repo")
   ```

4. Ledger update `cwd` + branch; implement only under `$WT`.
5. Ledger `close`.
6. Reclaim: `claw-task-*` / `claw-hotfix-*` standard; `claw-dev-*` needs
   `--allow-long-lived`.

## Domain

Use `--domain` when work is area-scoped (i18n, platform, userscript, server, …)
so parallel claw tasks do not collide and audit stays readable.
