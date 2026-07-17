---
name: dev-task
description: >
  coco-forge development under OpenClaw with WezDeck-aligned lifecycle worktrees
  (claw-task/dev/hotfix), mandatory assess before create, never human worktrees.
---

# Dev task (coco-forge + claw lifecycle worktrees)

## When to use

Write work in **coco-forge** only.

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
     --cwd "$HOME/work/coco-forge")

   # parallel second tree in same domain:
   WT=$(./openclaw/scripts/claw-worktree.sh create \
     --title "…" --lifecycle task --domain i18n \
     --cwd "$HOME/work/coco-forge" --force-new)
   ```

4. Ledger update `cwd` + branch; implement only under `$WT`.
5. Ledger `close` with summary + `task_id`.
6. **Ask whether to reclaim** (never auto-run reclaim):
   - `claw-task-*` / `claw-hotfix-*`: 询问是否回收；用户同意再 `reclaim`。
   - `claw-dev-*`: **默认不回收**（长期枢纽）；仅用户明确要求时 reclaim，并
     带 `--allow-long-lived`。
   - 共享 hub 上还有其它进行中工作：说明不回收。

## Domain + multi-task

- Always pass `--domain` when area is known.
- Prefer **one `claw-dev-<domain>-…` hub** for ongoing domain work.
- Same domain + independent parallel PRs → `--force-new` (gets `-2` suffix).
- Never reuse human worktrees.
