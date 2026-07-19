---
name: dev-task
description: >
  Allowlisted development (coco-forge + wezdeck) under OpenClaw: claw worktrees
  under dirname(primary)/.worktrees/<repo>/, assess before create, human/Claw
  rails (H1/H2, C1/C2/C3; legacy A–E), ACP as access layer, handoff, reclaim.
---

# Dev task (allowlisted repos + claw lifecycle worktrees)

## When

Write work only under allowlist (see `AGENTS.md`). Pure Q&A: skip. Other repos: refuse.

| Logical | Roots |
| --- | --- |
| coco-forge | `$HOME/work/coco-forge`, `$HOME/work/.worktrees/coco-forge` |
| wezdeck | `$HOME/github/wezterm-config`, `$HOME/github/.worktrees/wezterm-config` |

Path formula (WezDeck): `dirname(realpath(primary))/.worktrees/<basename(primary)>/<slug>/`.

Architecture: `openclaw/docs/agent-architecture.md` (Grok 三分, ACP 接入, 命名空间).

## Checklist

Same 9 steps as `AGENTS.md` Write-task checklist. Scripts:

- `openclaw/scripts/dev-task-ledger.sh` — see `skills/task-ledger`
- `openclaw/scripts/claw-worktree.sh` — assess/create/list/reclaim
- `openclaw/scripts/claw-run.sh` — host shell gate

## Assess → 初评

```bash
./openclaw/scripts/claw-worktree.sh assess \
  --title "<subject>" --domain "<area>" --scope "<hint>" [--days N] \
  --cwd "$HOME/github/wezterm-config"
```

Present: lifecycle, slug, branch, `action` reuse|create, `worktree_root`, `path_if_create`.
**Wait for user** before create when non-trivial (落实 may skip re-confirm if already authorized).

## Create / reuse / reclaim

```bash
./openclaw/scripts/claw-worktree.sh create \
  --title "…" --lifecycle task|dev|hotfix --domain "…" \
  --cwd "$HOME/github/wezterm-config"
```

- Prefer-reuse same domain; never human `dev-*`/`task-*` as write targets.
- **Reclaim never automatic** after ledger close.

## Rails & modes (user-facing)

| 轨 | 方式 | 旧 | Who codes | Main does |
| --- | --- | --- | --- | --- |
| 人工 | H1 人直接 | A | User IDE | Ledger/验收 only |
| 人工 | H2 原生 Agent | A | Host grok/claude/codex | Assist only |
| Claw | C1 Main 自写 | B | Main (Main-Grok) | Implement + verify |
| Claw | C2 Handoff | C | Host CLI after handoff | **Stop coding** that cwd |
| Claw | C3 ACP 后端 | E | ACP → claude \| codex | Spawn/close; single writer |
| — | D | D | — | **Forbidden** |

**ACP** = access layer only; backends are Claude/Codex. No `spawn grok`.
Do not rewrite host `~/.codex` / `~/.grok` defaults when fixing ACP
(use `~/.openclaw/acpx/codex-home` for ACP Codex).

### Handoff (C2)

```text
## Handoff
- task_id / cwd / branch / goal / non-goals / acceptance
- 开发方式: C2 本机原生 handoff（C）
- constraints: no force-push; no push main without yes
- after: 本机做完 → 飞书摘要 → main close + reclaim ask
- 本机: cd <cwd> && claude --continue
```

## 开发方式推荐卡（必发）

Before code or ACP, post and wait:

```text
## 开发方式（请抉择）
- 轨: 人工 | Claw
- 推荐: H1 | H2 | C1 Main自写 | C2 handoff | C3 ACP(claude|codex)
- 执行者 / 后端: …
- 理由: …（含限制/degraded）
- 备选: …
- 平台约束: 单写者、claw-*、确认前不写码；不改原生默认配置
- 审查建议: claude × codex-grok | 跳过（理由）
- cwd / task_id: …
请确认。确认前不改代码 / 不 spawn ACP。
```

Heuristics: **C1** small/clear; **C3-claude** multi-file/profile; **C2/H2** need TUI;
**H1** already coding; **C3-codex** explicit Codex stack.

## 实现方案块

See `AGENTS.md`. Always restate mode even if user named it.

## 落实 / commits

On 落实: review → implement → verify → **1–3 logical commits** → push agreed branch → report.
Shell via `claw-run` when required by exec-risk.

## Constitution (all agents)

Usage may differ by rail/limits; **criteria do not**: L0, skills, scripts,
single-writer, honest pass/fail, no fake green, secret hygiene, error closed-loop
(`Process failed` / `Exec failed` same-turn plain language).
