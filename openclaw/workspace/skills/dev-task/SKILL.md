---
name: dev-task
description: >
  Allowlisted development (wezdeck (+ optional team roots in local config)/wezterm-config) under OpenClaw
  with claw lifecycle worktrees, assess before create, declare mode A/B/C/E
  after requirement confirm, never human worktrees.
---

# Dev task (allowlisted repos + claw lifecycle worktrees)

## When to use

Write work only under the **development allowlist**:

| Logical | Default roots |
| --- | --- |
| **团队仓** | `$HOME/work/team-repo`, worktrees under `.worktrees/team-repo` |
| **wezdeck** | `$HOME/github/wezterm-config` (or `$HOME/work/wezterm-config`), worktrees under `.worktrees/wezterm-config` |

Skip this skill for pure Q&A. Other repos: refuse.

## Main checklist (when main accepts a write task)

```text
[ ] ledger open → task_id
[ ] assess → 飞书【初评】→ user confirms goal/tree
[ ] 【开发方式】A|B|C|E + 理由 + 执行者 → user confirms (before code / ACP spawn)
[ ] ledger confirm  # 确认时间; 需确认=false (if open used confirm-required 1)
[ ] create/reuse claw-* → ledger update cwd/分支
[ ] execute per mode (B write | C handoff stop | E acp spawn | A assist only)
[ ] accept if B; if C/A/E wait then close (no dual-write)
[ ] ledger close + 结果 (task_id + actual mode; 结束时间=结案秒级)
[ ] ask reclaim (never auto)
```

**Modes:** A human · B main · C handoff · E ACP (`claude`|`codex`) · **D forbidden**.  
Full table: `openclaw/README.md` → Development modes.

Ad-hoc shell: `claw-run` (exec-risk).  
Repo scripts `claw-worktree.sh` / `dev-task-ledger.sh`: call directly.

## Steps

1. Ledger `open` (`skills/task-ledger`).
2. **Assess** (mandatory before create):

   ```bash
   ./openclaw/scripts/claw-worktree.sh assess \
     --title "…" --domain "i18n" --scope "apps/…" --days 3
   ```

   Present 初评 from JSON: `action` (`reuse`|`create`), `reuse`,
   `same_domain_candidates`, `create_slug_if_new`.

3. **【开发方式】** after user confirms requirements / 初评 — **before** implement
   or ACP spawn. Template (Feishu):

   ```text
   ## 开发方式
   - 选用: A | B | C | E
   - 执行者: Main | 本机 CLI (handoff) | ACP claude | ACP codex | 用户自干
   - 理由: …
   - cwd / task_id: …
   - 你将看到: …
   请确认或改用 A/B/C/E。确认前不开始改代码。
   ```

   Heuristics (user overrides):
   - **B** — small, clear scope, Feishu-followable.
   - **E** — multi-file / wants Claude·Codex profile + Feishu-driven worker
     (`/acp spawn claude|codex --cwd <wt>`; default claude).
   - **C** — user wants local TUI or says they will code locally; then **stop** coding.
   - **A** — user already coding; assist ledger/验收 only.
   - **D** — never.

4. **Obtain cwd** after tree + mode confirm:

   ```bash
   # 团队仓 product:
   WT=$(./openclaw/scripts/claw-worktree.sh create \
     --title "…" --lifecycle task --domain i18n \
     --cwd "$HOME/work/team-repo")
   # wezdeck / wezterm-config:
   # --cwd "$HOME/github/wezterm-config"
   ```

5. Ledger `update` cwd + branch.
6. Execute per confirmed mode (single writer).
7. Accept if B (tests / chrome). If C/A/E: wait for completion before `close`.
8. Ledger `close` + 结果 including **actual** 开发方式.
9. **Ask reclaim** (never auto).

## Handoff brief (mode C — copy)

```text
## Handoff
- task_id: …
- cwd: …
- branch: …
- goal / non-goals / acceptance: …
- 开发方式: C
- constraints: no force-push; no push main/master without user yes
- after: 本机做完 → 飞书摘要 → main close + reclaim ask
- 本机: cd <cwd> && claude --continue
```

## Domain + multi-task

- Always pass `--domain` when area is known.
- Prefer **one `claw-dev-<domain>-…` hub** for ongoing domain work.
- Same domain + independent parallel PRs → `--force-new` (gets `-2` suffix).
- Never reuse human worktrees.
