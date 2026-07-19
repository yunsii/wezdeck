---
name: adversarial-review
description: >
  Multi-role adversarial review (find → refute → sandbox repro). Backends:
  claude | codex-gpt | codex-grok. Same-model multi-role OK if SINGLE-MODEL.
---

# Adversarial review (thin skill)

## When

- Runtime code/scripts changed and you want defect-focused review
- Before PR/merge acceptance for wezdeck / allowlisted product work
- After editing `scripts/dev/adversarial-review` itself (`dogfood`)

Skip pure docs/tests-only diffs (the runner auto-skips).

## Multi-role minimum (name = constraint)

「对抗审查」requires **find + refute** (repro recommended):

| Role | Stance |
| --- | --- |
| reviewer / find | guilty-until-proven |
| refuter | burden on the finding; try to kill it |
| repro | empirical (recommended) |

- Prefer different agent families (Claude-TUI × Codex-Grok-profile).
- If only one capability: **two independent calls**, opposite prompts; label
  **SINGLE-MODEL**. Do **not** skip refute.
- Solo monologue (one Main essay) = **设计批判**, **not** 对抗审查.

Orchestration: `run.sh`, or Main schedules two TUI/ACP turns with role prompts.

## Backends

| Alias | Stack |
| --- | --- |
| `claude` | Claude Code (host) |
| `codex` / `codex-gpt` | Host Codex default |
| `codex-grok` | Host Codex `--profile grok` |

Does **not** use OpenClaw ACP `CODEX_HOME`. Prefer `claude` × `codex-grok` when
proxy GPT is unavailable.

## Do

```bash
scripts/dev/adversarial-review/run.sh <BASE_REF> \
  --reviewer claude --refuter codex-grok --mode strict

# same-model multi-role still valid (SINGLE-MODEL)
scripts/dev/adversarial-review/run.sh <BASE_REF> \
  --reviewer claude --refuter claude --mode strict

scripts/dev/adversarial-review/run.sh dogfood --mode strict --fail-on-finding
scripts/dev/adversarial-review/run.sh selfcheck claude codex-gpt codex-grok
```

## Report (mandatory)

```text
## 对抗审查披露
- 形态: 三门全量 | 多角色·单模型
- reviewer 全名 / 立场: …
- refuter 全名 / 立场: …
- repro: 已跑 | 跳过（理由）
- 命令或范围: …
- skipped_gates: … | 无
- 关键结论: …（绑 find/refute/repro）
```

## Don't

- Don't call solo analysis 对抗审查 (use 设计批判)
- Don't invent "all three gates passed" for PLAUSIBLE findings
- Don't skip refute when claiming 对抗审查
- Don't claim cross-agent when SINGLE-MODEL
- Don't point review Codex at `~/.openclaw/acpx/codex-home`
