---
name: dev-task
description: >
  团队仓 development under OpenClaw with WezDeck-aligned lifecycle worktrees
  (claw-task/dev/hotfix), mandatory assess before create, never human worktrees.
  Main orchestrator checklist + handoff to profile-backed coding agents.
---

# Dev task (团队仓 + claw lifecycle worktrees)

## When to use

Write work in **团队仓** only. Skip this skill for pure Q&A.

## Main checklist (when main accepts a write task)

```text
[ ] ledger open → task_id
[ ] assess → 飞书初评 → user confirm
[ ] create/reuse claw-* → ledger update cwd/分支
[ ] path: B self-implement | C Handoff then stop coding | A user-only → assist only
[ ] accept if B; if C/A wait for user return then close
[ ] ledger close + 结果 (task_id)
[ ] ask reclaim (never auto)
```

**Modes:** A human direct · B main direct · C handoff (local finish → main wrap-up).
Never dual-write with a live host CLI. Full table:
`openclaw/README.md` → Development modes.

Ad-hoc shell: `claw-run` (exec-risk).  
Repo scripts `claw-worktree.sh` / `dev-task-ledger.sh`: call directly.

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
     --cwd "$HOME/work/team-repo")
   # parallel second tree: add --force-new
   ```

4. Ledger `update` with `cwd` + branch.
5. **Path choice**
   - **B Small:** implement only under `$WT`.
   - **C Large:** post **Handoff**, then **stop coding**; normal: user finishes
     locally → Feishu return → main close. Host CLI already has agent-profiles.
   - **A User self-drive:** no forced handoff; ledger/验收 only if asked.
6. Accept if B (tests / chrome UI). If C/A: wait for user before `close`.
7. Ledger `close` + Feishu 结果 (`task_id`).
8. **Ask reclaim** (never auto):
   - `claw-task-*` / `claw-hotfix-*`: ask; reclaim only on yes.
   - `claw-dev-*`: default keep; reclaim only if user insists + `--allow-long-lived`.
   - Shared hub still busy: do not reclaim; explain.

## Handoff brief (mode C — copy)

```text
## Handoff
- task_id: …
- cwd: …
- branch: …
- goal / non-goals / acceptance: …
- constraints: no force-push; no push main/master without user yes
- after: 本机做完 → 飞书摘要 → main close + reclaim ask
- 本机: cd <cwd> && claude --continue
```

## Domain + multi-task

- Always pass `--domain` when area is known.
- Prefer **one `claw-dev-<domain>-…` hub** for ongoing domain work.
- Same domain + independent parallel PRs → `--force-new` (gets `-2` suffix).
- Never reuse human worktrees.
