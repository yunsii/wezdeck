---
name: dev-task
description: >
  Allowlisted development (wezdeck (+ optional team roots in local config)) under OpenClaw: wezdeck defaults
  to primary master; claw worktrees when parallel/isolation needed; 团队仓
  still prefers claw-*; human/Claw rails (H1/H2, C1/C2/C3), ACP access layer.
---

# Dev task (allowlisted repos)

## When

Write work only under allowlist (see `AGENTS.md`). Pure Q&A: skip. Other repos: refuse.

| Logical | Roots |
| --- | --- |
| 团队仓 | `$HOME/work/team-repo`, `$HOME/work/.worktrees/team-repo` |
| wezdeck | `$HOME/github/wezterm-config` (primary), optional `.worktrees` |

## cwd policy (L0-12/13)

**Core:** personal projects → default mainline. **wezdeck** is the local instance.

| Repo | Default | Worktree when |
| --- | --- | --- |
| **wezdeck** (personal) | **primary `master`** | parallel, long experiment, isolated agent cwd, user asks |
| **团队仓** (team-ish) | **claw-\*** under `dirname(primary)/.worktrees/<repo>/` | default isolation unless user overrides |

Path formula (when used): `dirname(realpath(primary))/.worktrees/<basename(primary)>/<slug>/`.

Architecture: `openclaw/docs/agent-architecture.md`.

## Checklist

Same steps as `AGENTS.md` Write-task checklist (wezdeck may skip assess/create).
Scripts: `dev-task-ledger.sh`, `claw-worktree.sh`, `claw-run.sh`.

## Assess → create (only when isolation/parallel needed)

```bash
./openclaw/scripts/claw-worktree.sh assess \
  --title "<subject>" --domain "<area>" --scope "<hint>" [--days N] \
  --cwd "$HOME/github/wezterm-config"
./openclaw/scripts/claw-worktree.sh create \
  --title "…" --lifecycle task|dev|hotfix --domain "…" \
  --cwd "$HOME/github/wezterm-config"
```

- Prefer-reuse same domain; never human `dev-*`/`task-*` as write targets.
- **Reclaim never automatic** after close (only if a worktree was used).

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

**Full names required** (never bare "Codex"/"Claude" alone):

| Full name | Meaning |
| --- | --- |
| Claude-TUI | host `claude` (H2/C2) |
| Claude-ACP | C3 `agentId=claude` |
| Codex-TUI | host `codex` + `~/.codex` |
| Codex-ACP | C3 `agentId=codex` + isolated CODEX_HOME |
| Codex-Grok-profile | host `codex -p grok` |
| Main-Grok | OpenClaw main model |
| Grok-native | host `grok` CLI |

Before code or ACP, post and wait:

```text
## 开发方式（请抉择）
- 轨: 人工 | Claw
- 推荐: H1 | H2 (Claude-TUI|Codex-TUI|Grok-native) | C1 Main-Grok |
        C2 handoff | C3 (Claude-ACP|Codex-ACP)
- 执行者 / 后端全名: …
- 理由: …（含限制/degraded）
- 备选: …
- 平台约束: 单写者、claw-*、确认前不写码；不改原生默认配置
- 审查建议: review-claude × review-codex-grok | 跳过（理由）
- cwd / task_id: …
请确认。确认前不改代码 / 不 spawn ACP。
```

Heuristics: **C1** small/clear; **Claude-ACP** multi-file/profile; **C2/H2** need TUI;
**H1** already coding; **Codex-ACP** explicit Codex stack.

## C3 ACP spawn constitution (prepend to task)

```text
[OpenClaw C3 constitution — non-negotiable]
1. Single writer: only you write this cwd; no parallel Main/TUI on same tree.
2. cwd is the path Main gave (wezdeck may be primary master or claw-*).
3. No force-push; wezdeck may push master per owner policy; other repos need explicit yes.
4. Prefer 1–3 logical commits; no secret leakage.
5. On completion report: changed files, summary, blockers; honest fail if blocked.
6. You are Claude-ACP or Codex-ACP (access layer), not a replacement for host TUI config.
```

Before spawn: reject if cwd missing or outside allowlist. wezdeck may be primary master; 团队仓 usually claw-*.
After C3: prefer structured report `changed_files` / `summary` / `blockers` / `commits`.

Probe: `openclaw/scripts/agent-matrix-status.sh`.

## 实现方案块

See `AGENTS.md`. Always restate mode even if user named it.

## 落实 / commits

On 落实: review → implement → verify → **1–3 logical commits** → push agreed branch → report.
**wezdeck:** default work on **primary master**; after green checks **commit + push `master`** (L0-12/18/19). If a task branch/worktree was used, ff-only into master then push.
Other repos: push main/master only with explicit yes.
Shell via `claw-run` when required by exec-risk.

### Feishu report default (brevity)

- Progress while working: **1–3 lines**, not tool play-by-play.
- Final report: use AGENTS **精简【结果】卡** by default (status, one-liner, commit anchor, decision ask).
- Do **not** default-paste full acceptance tables, long path lists, full adversarial disclosure, or multi-block bash.
- User says 展开/全文/细节 → then full completion template.
- Failures: 4-line closed-loop first (失败/原因/处置/影响).

### Git author & trailer (mandatory)

| Rule | Detail |
| --- | --- |
| Author | Always repo owner. wezdeck: `Yuns <yuns.xie@qq.com>`. **Never** `YunsClaw` / `yuns@local`. |
| Do not | `git -c user.name=YunsClaw` or other bot identity overrides. |
| Trailer | `Assisted-by: OpenClaw (backend=…, model=…)` |
| C1 Main | `backend=main`, `model=<short model id>` e.g. `grok-4.5` (not `grok-proxy/…` unless debugging) |
| C2/C3 write | `backend=<full name>` e.g. `Claude-ACP`, `Codex-ACP` + that backend's model |
| Editorial only | `Assisted-by: OpenClaw (editorial-only)` or omit |
| Integrate | wezdeck already on master → push; else rebase → `merge --ff-only` → push; **no** default `--no-ff` |

Example message:

```text
feat(scope): subject

- bullet why/what

Assisted-by: OpenClaw (backend=main, model=grok-4.5)
```

## Adversarial review (agent runs it)

**Do not** ask the human to run `run.sh`. On review intent or acceptance:

1. **Load** `skills/adversarial-review/SKILL.md`
2. **Run** `$REPO/scripts/dev/adversarial-review/run.sh <BASE> --writer <family> --mode strict`
3. **Report** L0-20 disclosure (writer / form / reviewer / refuter / conclusions)

「对抗审查」= multi-role (find+refute minimum). Same agent twice with opposite
stance is OK if labeled SINGLE-MODEL. Solo Main monologue = **设计批判** only.
Writer-aware selection: `--writer main|claude|codex|human` (strategy B).

## Constitution (all agents)

Usage may differ by rail/limits; **criteria do not**: L0, skills, scripts,
single-writer, honest pass/fail, no fake green, secret hygiene, error closed-loop
(`Process failed` / `Exec failed` same-turn plain language).
