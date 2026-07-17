---
name: exec-risk
description: >
  Host shell MUST go through claw-run (gate then exec). Three layers:
  rules → Grok re-check → human only if still danger. Prefer claw-run over bare exec.
---

# Exec risk (layered) — option A protocol

OpenClaw `exec.mode=full` does **not** hard-block host shell. **You** enforce
this skill on every host command. Skipping the gate is a protocol violation.

## Platform vs classifier (division of labor)

| Layer | Local setting | Role |
| --- | --- | --- |
| OpenClaw host policy | `mode=full`, `ask=off` | No `/approve` spam for normal shell |
| OpenClaw `strictInlineEval` | **`false`** (personal YunsClaw) | Do **not** hard-block `xargs` / `-c` at platform |
| **This skill** (`claw-run` / gate) | always | Semantic risk: rules → Grok → **飞书** if danger |

`strictInlineEval=false` does **not** disable the classifier. It only removes
platform `/approve` on inline carriers. Risk control is **claw-run + Feishu**.

Prefer: `rg -l 'pat' packages` over `find … \| xargs rg`.  
Classifier soft-covers high-risk inline forms (`python -c`, `xargs rm/sh`, …);
innocent `xargs rg` is not auto-danger — still run via `claw-run`.

## Required entry

**Prefer** `claw-run.sh` (gate + run in one step):

```bash
# From repo root, or use absolute path under wezterm-config/openclaw/scripts/
./openclaw/scripts/claw-run.sh -- git status
./openclaw/scripts/claw-run.sh 'ls -la'
./openclaw/scripts/claw-run.sh --dry-run 'rm -rf /tmp/x'   # classify only
```

Gate-only (inspect without running):

```bash
./openclaw/scripts/claw-exec-gate.sh '<command>'
```

| exit | meaning |
| --- | --- |
| 0 | allow (or command finished after allow) |
| 2 | `human_required` — **do not** run; ask 飞书 |
| 3 | usage / empty |
| 4 | infra fail — treat as need human (fail closed) |

Stdout/stderr:

- On deny: JSON on stdout (and stderr). Parse `human_required`, `layer`, `reason`.
- On allow via `claw-run`: command owns stdout; gate JSON is on stderr.

## Mandatory agent loop

```text
before ANY host shell (exec / bash -c / pipelines):
  1. Prefer: claw-run.sh [--] <command>
     Or:     claw-exec-gate.sh <command>  then run only if decision=allow
  2. If exit 2 or human_required=true:
       - 飞书说明 layer + reason + 完整命令
       - 等待用户明确同意（是 / 确认 / yes）
       - 仅在同意后: claw-run.sh --force -- <same command>
  3. Never invent --force. Never “先跑再报”.
  4. Trivial probes still go through claw-run (rules allow instantly; no LLM).
```

Exceptions (no gate):

- Calling `claw-exec-gate.sh` / `claw-exec-classify.sh` / `claw-run.sh` themselves
- Pure in-process file tools that are not shell (if the platform provides them)

## Pipeline (inside gate)

```text
command
  → 1) claw-exec-classify.sh   (rules)
       safe | write  → ALLOW (stop; no LLM, no human)
       danger        → 2)
  → 2) Grok simple classifier  (grok-proxy /responses)
       safe | write  → ALLOW (rule false-positive cleared)
       danger        → 3)
  → 3) Human (Feishu)
       explain + wait for explicit yes
       → claw-run.sh --force -- '<command>'
```

Flags (gate / run):

| flag | effect |
| --- | --- |
| `--skip-llm` / `CLAW_RUN_SKIP_LLM=1` | rules only; danger always human |
| `--always-llm` (gate only) | also LLM on safe/write |
| `--force` / `CLAW_RUN_FORCE=1` | skip gate after human yes |
| `--dry-run` (run only) | gate decision only, no exec |

## Dev-task agent judgment

**Enough for:** plan, worktree 初评, reuse, ledger, whether to write code.  
**Not enough for:** host shell — still `claw-run` / gate.

## Labels

| label | Meaning |
| --- | --- |
| safe | probe / read-only |
| write | normal dev (still no force-push main without chat confirm per AGENTS) |
| danger | destructive / secret / pipe-to-shell → human |

Keep rule patterns simple; extend `claw-exec-classify.sh` when real misses appear.

## Not option B

Do **not** reconfigure OpenClaw allowlist to replace this skill unless the user
explicitly asks for hybrid hard-block (`allowlist` only `claw-run`). Default is
protocol + wrapper (option A).
