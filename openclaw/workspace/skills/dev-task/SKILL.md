---
name: dev-task
description: >
  Allowlisted development (wezdeck (+ optional team roots in local config)) under OpenClaw: claw worktrees
  under dirname(primary)/.worktrees/<repo>/, assess before create, modes A/B/C/E,
  handoff, reclaim. Load for any write-task implementation.
---

# Dev task (allowlisted repos + claw lifecycle worktrees)

## When

Write work only under allowlist (see `AGENTS.md`). Pure Q&A: skip. Other repos: refuse.

| Logical | Roots |
| --- | --- |
| 团队仓 | `$HOME/work/team-repo`, `$HOME/work/.worktrees/team-repo` |
| wezdeck | `$HOME/github/wezterm-config`, `$HOME/github/.worktrees/wezterm-config` |

Path formula (WezDeck): `dirname(realpath(primary))/.worktrees/<basename(primary)>/<slug>/`.

## Checklist

Same 9 steps as `AGENTS.md` Write-task checklist. Scripts:

- `openclaw/scripts/dev-task-ledger.sh` — see `skills/task-ledger`
- `openclaw/scripts/claw-worktree.sh` — assess/create/list/reclaim (create 委托 worktree-task)
- `openclaw/scripts/claw-run.sh` — host shell gate

## Assess → 初评

```bash
./openclaw/scripts/claw-worktree.sh assess \
  --title "<subject>" --domain "<area>" --scope "<hint>" [--days N] \
  --cwd "$HOME/github/wezterm-config"   # or 团队仓 primary
```

Present: lifecycle, slug, branch, `action` reuse|create, `worktree_root`, `path_if_create`,
`same_domain_candidates`. **Wait for user** before create when non-trivial.

| Signal | Prefer |
| --- | --- |
| 紧急/线上/P0 | hotfix |
| 大范围/多周 | dev |
| 单功能/明确验收 | task |

### 初评模板

```text
## Worktree 初评
- lifecycle / slug / branch / domain
- action: 复用 … | 新建 …
- worktree_root: …
请确认后我再 create。
```

## Create / reuse / reclaim

```bash
./openclaw/scripts/claw-worktree.sh create \
  --title "…" --lifecycle task|dev|hotfix --domain "…" \
  --cwd "$HOME/github/wezterm-config"   # primary; tree lands under parent .worktrees
```

- Default **prefer-reuse** same domain; `--force-new` for parallel tree (`-2` suffix).
- Never human `dev-*`/`task-*`/`hotfix-*` as write targets.
- **Reclaim never automatic** — ask after `ledger close`; `claw-dev-*` default keep (`--allow-long-lived` if reclaiming).

| Lifecycle | Claw slug / branch |
| --- | --- |
| task | `claw-task-*` / `claw/task/…` |
| dev | `claw-dev-*` / `claw/dev/…` |
| hotfix | `claw-hotfix-*` / `claw/hotfix/…` |

## Modes

| | Who | Main does |
| --- | --- | --- |
| A | User local | Ledger/验收 only |
| B | Main | Implement + verify |
| C | Local after handoff | Post handoff, **stop coding** that cwd |
| E | ACP claude/codex | `sessions_spawn` / `/acp spawn`; single writer |
| D | — | Forbidden |

### Handoff (C)

```text
## Handoff
- task_id / cwd / branch / goal / non-goals / acceptance
- 开发方式: C
- constraints: no force-push; no push main without yes
- after: 本机做完 → 飞书摘要 → main close + reclaim ask
- 本机: cd <cwd> && claude --continue
```

## 开发方式 + 实现方案

See `AGENTS.md` templates. Always restate mode before code/ACP even if user named it.

## 落实 / commits

On 落实: review → implement → verify → **1–3 logical commits** (no scatter) → push agreed branch → report.
Shell via `claw-run` when required by exec-risk.
