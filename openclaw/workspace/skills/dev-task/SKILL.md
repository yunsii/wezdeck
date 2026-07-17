---
name: dev-task
description: >
  coco-forge development under OpenClaw with WezDeck-aligned lifecycle worktrees
  (claw-task/dev/hotfix), mandatory assess before create, never human worktrees.
  Main orchestrator checklist + handoff to profile-backed coding agents.
---

# Dev task (coco-forge + claw lifecycle worktrees)

## When to use

Write work in **coco-forge** only. Skip this skill for pure Q&A.

## Main checklist (do not skip)

```text
[ ] ledger open → task_id
[ ] assess → 飞书初评 → user confirm
[ ] create/reuse claw-* → ledger update cwd/分支
[ ] small: implement in cwd | large: Handoff brief (no profile bridge)
[ ] accept (tests / chrome if UI)
[ ] ledger close + 结果模板 with task_id
[ ] ask reclaim (never auto)
```

Ad-hoc shell (git, pnpm, one-offs): `claw-run` (exec-risk).  
Repo scripts `claw-worktree.sh` / `dev-task-ledger.sh`: call directly (trusted package).

## Worktree model (mirrors WezDeck)

| Kind | Claw dir | Claw branch | Human analogue |
| --- | --- | --- | --- |
| task | `claw-task-<domain?>-<subject>` | `claw/task/…` | `task-*` |
| dev | `claw-dev-<domain?>-<subject>` | `claw/dev/…` | `dev-*` |
| hotfix | `claw-hotfix-<domain?>-<subject>` | `claw/hotfix/…` | `hotfix-*` |

Human `dev-*` / `task-*` / `hotfix-*` (no `claw-`) are **read-only** for claw.

## Steps

1. Ledger `open` (`skills/task-ledger`).
2. **Assess** (mandatory before create):

   ```bash
   ./openclaw/scripts/claw-worktree.sh assess \
     --title "…" --domain "i18n" --scope "apps/…" --days 3
   ```

   Present 初评 from JSON: `action` (`reuse`|`create`), `reuse`,
   `same_domain_candidates`, `create_slug_if_new`.

3. **Obtain cwd** only after user confirm:

   ```bash
   WT=$(./openclaw/scripts/claw-worktree.sh create \
     --title "…" --lifecycle task --domain i18n \
     --cwd "$HOME/work/coco-forge")
   # parallel second tree: add --force-new
   ```

4. Ledger `update` with `cwd` + branch.
5. **Path choice**
   - **Small:** implement only under `$WT` (main).
   - **Large:** post **Handoff** (AGENTS.md template); coding agent already has
     user agent-profiles via `~/.claude` / `~/.codex` — do **not** bridge.
6. Accept: run stated checks; UI → chrome-devtools MCP (main) or note in handoff.
7. Ledger `close` + Feishu 结果 block with `task_id`.
8. **Ask reclaim** (never auto):
   - `claw-task-*` / `claw-hotfix-*`: ask; reclaim only on yes.
   - `claw-dev-*`: default keep; reclaim only if user insists + `--allow-long-lived`.
   - Shared hub still busy: do not reclaim; explain.

## Handoff brief (copy)

```text
## Handoff
- task_id: …
- cwd: …
- branch: …
- goal / non-goals / acceptance: …
- constraints: no force-push; no push main/master without user yes
- after: summary back to Feishu → main closes ledger + asks reclaim
- resume: cd <cwd> && claude --continue
```

## Domain + multi-task

- Always pass `--domain` when area is known.
- Prefer **one `claw-dev-<domain>-…` hub** for ongoing domain work.
- Same domain + independent parallel PRs → `--force-new` (gets `-2` suffix).
- Never reuse human worktrees.
