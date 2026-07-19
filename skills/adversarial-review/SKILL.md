---
name: adversarial-review
description: >
  Multi-role adversarial code review for this repo. Agent loads this skill and
  runs host scripts (find → refute → sandbox repro). Humans only state intent
  (审一下 / 对抗审查). Use when user asks for adversarial review, acceptance
  recommends review, or runtime code changed before merge.
---

# Adversarial review (repo skill — thin entry)

**Who runs:** the coding agent (Claude-TUI / Codex-TUI / OpenClaw Main), **not** the human.
**Do not** ask the user to copy-paste shell as the primary path.

## Canonical pieces

| Piece | Path |
| --- | --- |
| **Runner (only implementation)** | `scripts/dev/adversarial-review/run.sh` |
| **Writer-aware select** | `scripts/dev/adversarial-review/lib/select-backends.sh` |
| **Full OpenClaw skill** | `openclaw/workspace/skills/adversarial-review/SKILL.md` |
| **Docs** | `docs/adversarial-review.md` |
| **Host TUI doctrine** | `agent-profiles/v1/en/validation.md` (adversarial review rules) |

This file is the **in-repo discovery** surface for agents working in wezdeck cwd.
OpenClaw Main may use the workspace skill instead; both call the same runner.

## When

- User: 对抗审查 / 审一下 / adversarial review
- Task acceptance suggests multi-role review
- Runtime code/scripts changed (runner auto-skips pure docs/tests)

## Multi-role minimum

Find (guilty-until-proven) + Refute (kill weak findings) + Repro (recommended).
Solo monologue = **设计批判**, **not** 对抗审查. Same backend twice → **SINGLE-MODEL**.

## Agent procedure

1. `REPO_ROOT=$(git rev-parse --show-toplevel)` (claw-* worktree or primary).
2. Resolve **writer**: `main` | `claude` | `codex` | `codex-gpt` | `codex-grok` | `human`.
3. Run (prefer writer-aware):

```bash
"$REPO_ROOT/scripts/dev/adversarial-review/run.sh" <BASE_REF> \
  --writer <writer> --mode strict
```

4. Paste disclosure (required):

```text
## 对抗审查披露
- writer: …
- form / degraded / reason: …
- reviewer / refuter: …
- repro: 已跑 | 跳过（理由）
- 命令或范围: …
- skipped_gates: … | 无
- 关键结论: …（绑 find/refute/repro）
```

Optional: `"$REPO_ROOT/scripts/dev/adversarial-review/lib/select-backends.sh" --writer <w> --no-probe`

## Don't

- Don't hand `run.sh` to the human as the main workflow
- Don't skip refute when claiming 对抗审查
- Don't use ACP `CODEX_HOME` for review (runner uses host `~/.codex`)
- Don't claim cross-agent when SINGLE-MODEL
