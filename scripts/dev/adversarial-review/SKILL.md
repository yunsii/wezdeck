---
name: adversarial-review
description: >
  Three-gate cross-agent review (find → refute → sandbox repro). Backends:
  claude | codex-gpt | codex-grok. Use before merge or dogfood self-review.
---

# Adversarial review (thin skill)

## When

- Runtime code/scripts changed and you want defect-focused review
- Before PR/merge acceptance for wezdeck / allowlisted product work
- After editing `scripts/dev/adversarial-review` itself (`dogfood`)

Skip pure docs/tests-only diffs (the runner auto-skips).

## Backends (three paths)

| Alias | Stack |
| --- | --- |
| `claude` | Claude Code |
| `codex` / `codex-gpt` | Host Codex default (GPT when allowed) |
| `codex-grok` | Host Codex `--profile grok` |

Does **not** use OpenClaw ACP `CODEX_HOME`. Prefer `claude` × `codex-grok` when
proxy GPT is unavailable.

## Do

```bash
# recommended now
scripts/dev/adversarial-review/run.sh <BASE_REF> \
  --reviewer claude --refuter codex-grok --mode strict

# when GPT works
scripts/dev/adversarial-review/run.sh <BASE_REF> \
  --reviewer claude --refuter codex-gpt --mode strict

scripts/dev/adversarial-review/run.sh dogfood --mode strict --fail-on-finding
scripts/dev/adversarial-review/run.sh selfcheck claude codex-gpt codex-grok
```

## Don't

- Don't invent "all three gates passed" for PLAUSIBLE findings
- Don't run unbounded auto-fix loops; max 3 dogfood cycles without human OK
- Don't claim cross-agent success when gate 2 was skipped (SINGLE-MODEL)
- Don't point review Codex at `~/.openclaw/acpx/codex-home` (ACP-only)
