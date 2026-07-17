---
name: exec-risk
description: >
  Three-layer host exec gate: rules → Grok re-check → human only if still danger.
  Dev-task planning uses agent judgment; use claw-exec-gate before risky shell.
---

# Exec risk (layered)

## Pipeline

```text
command
  → 1) claw-exec-classify.sh   (rules)
       safe | write  → ALLOW (stop; no LLM, no human)
       danger        → 2)
  → 2) Grok simple classifier  (same grok-proxy as OpenClaw)
       safe | write  → ALLOW (rule false-positive cleared)
       danger        → 3)
  → 3) Human (Feishu)
       explain + wait for explicit yes; then run
```

```bash
./openclaw/scripts/claw-exec-gate.sh 'rm -rf /tmp/x'
# {"decision":"allow|deny","layer":"rules|llm","label":"…","human_required":bool,…}
# exit 0 allow | 2 human required | 4 infra fail (fail closed → ask human)
```

Flags:

- `--always-llm` — also run Grok on safe/write (slow; rare)
- `--skip-llm` — rules only; danger always needs human

## Dev-task agent judgment

**Enough for:** plan, worktree 初评, reuse, ledger, whether to write code.  
**Not a hard shell gate:** still run `claw-exec-gate` when about to execute
shell that might be destructive. With `exec.mode=full`, OpenClaw will not
`/approve`; **you** must honor `human_required` and ask the user in Feishu.

## Labels

| label | Meaning |
| --- | --- |
| safe | probe / read-only |
| write | normal dev (still no force-push main without chat confirm per AGENTS) |
| danger | destructive / secret / pipe-to-shell → human |

Keep rule patterns simple; extend `claw-exec-classify.sh` when real misses appear.
