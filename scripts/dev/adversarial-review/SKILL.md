---
name: adversarial-review
description: >
  Three-gate cross-agent review (find → refute → sandbox repro). Use before
  merging runtime changes, or dogfood to recursively improve this tool itself.
---

# Adversarial review (thin skill)

## When

- Runtime code/scripts changed and you want defect-focused review
- Before PR/merge acceptance for wezdeck / allowlisted product work
- After editing `scripts/dev/adversarial-review` itself (`dogfood`)

Skip pure docs/tests-only diffs (the runner auto-skips).

## Do

```bash
# normal range
scripts/dev/adversarial-review/run.sh <BASE_REF> \
  --reviewer claude --refuter codex --mode strict

# self-improve loop (supervised)
scripts/dev/adversarial-review/run.sh dogfood --mode strict --fail-on-finding

# provider health
scripts/dev/adversarial-review/run.sh selfcheck claude
```

Read `docs/adversarial-review.md` for contracts, modes, exit codes, and
**stopping rules** for recursive optimization.

## Don't

- Don't invent “all three gates passed” for PLAUSIBLE findings
- Don't run unbounded auto-fix loops; max 3 dogfood cycles without human OK
- Don't claim cross-agent success when gate 2 was skipped (SINGLE-MODEL)
