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
2. **Assess** (mandatory):

   ```bash
   ./openclaw/scripts/claw-worktree.sh assess \
     --title "…" --domain "i18n" --scope "apps/…" --days 3
   ```

   Read JSON: `action` (`reuse`|`create`), `reuse`, `same_domain_candidates`,
   `create_slug_if_new`. Present 初评: 复用哪个 / 是否 force-new。

3. **Obtain cwd** after confirm:

   ```bash
   # default: prefer reuse
   WT=$(./openclaw/scripts/claw-worktree.sh create \
     --title "…" --lifecycle task --domain i18n \
     --cwd "$HOME/work/team-repo")

   # parallel second tree in same domain:
   WT=$(./openclaw/scripts/claw-worktree.sh create \
     --title "…" --lifecycle task --domain i18n \
     --cwd "$HOME/work/team-repo" --force-new)
   ```

4. Ledger update `cwd` + branch; implement only under `$WT`.
5. Ledger `close`.
6. Reclaim only when this task owned the tree **and** no other open work
   remains there (especially for shared `claw-dev-<domain>-*`).  
   `claw-dev-*` needs `--allow-long-lived`.

## Domain + multi-task

- Always pass `--domain` when area is known.
- Prefer **one `claw-dev-<domain>-…` hub** for ongoing domain work.
- Same domain + independent parallel PRs → `--force-new` (gets `-2` suffix).
- Never reuse human worktrees.
