# Adversarial Review (cross-agent) — v0.2

`scripts/dev/adversarial-review/` runs a **cross-agent adversarial code review**
over a diff, in three gates, and classifies findings so you can use the tool to
**recursively improve itself** (dogfood) without silent false confidence.

Design rationale (why three gates, why empirical repro matters more than debate)
is unchanged from v0.1; v0.2 tightens **contracts**, **naming**, **sandboxing**,
and **self-application**.

## The three gates

| Gate | Who | What |
| --- | --- | --- |
| 1 · Find | `--reviewer` | Finds defects under a **guilty-until-proven** stance; every finding must carry a concrete `failure_scenario`. |
| 2 · Refute | `--refuter` | A *different* model tries to **refute** each finding; burden of proof is on the finding (unsure → refuted). |
| 3 · Empirical | `--reviewer` + sandbox | For each `CONFIRMED` finding, the model writes a minimal repro script and the orchestrator **runs it in a detached worktree**. |

### Modes (survivor definition)

| Mode | Survivors (blockers) | Also reported |
| --- | --- | --- |
| **`strict` (default)** | only `CONFIRMED` **and** `repro.reproduced==true` | `needs_human` (timeout/dangerous/inconclusive); PLAUSIBLE dropped |
| **`advisory`** | same blockers | PLAUSIBLE + needs_human kept in a separate section |

Never claim “survived all three gates” for PLAUSIBLE items — they skip gate 3.

## Usage

```bash
scripts/dev/adversarial-review/run.sh <BASE_REF> [options]

  --reviewer P       provider that finds defects          (default: claude)
  --refuter P        provider that refutes them           (default: codex)
  --critic P         deprecated alias for --refuter
  --head REF         diff endpoint                         (default: HEAD)
  --mode MODE        strict | advisory                     (default: strict)
  --min-severity L   critical|high|medium|low              (default: low)
  --json             machine-readable output
  --dry-run          print the planned gates, call no agents
  --fail-on-finding  exit 10 if any strict survivor

scripts/dev/adversarial-review/run.sh selfcheck [claude|codex ...]
scripts/dev/adversarial-review/run.sh dogfood [--mode MODE] [options]
```

Examples:

```bash
# last commit, Claude finds, Codex refutes (strict)
run.sh HEAD~1 --reviewer claude --refuter codex

# advisory report for humans (includes PLAUSIBLE)
run.sh origin/master --mode advisory --reviewer claude --refuter claude

# recursive self-review of this tool's working tree
run.sh dogfood --mode strict --fail-on-finding

# provider JSON round-trip
run.sh selfcheck claude
```

**Stage 0 auto-skips** diffs that are docs/tests only.

## Recursive self-optimization (dogfood)

Intended loop (human or agent supervised — **no autonomous rewrite loop**):

```text
1. change scripts/dev/adversarial-review (or claw-worktree path core)
2. run.sh dogfood --mode strict
3. read survivors / needs_human
4. apply targeted fixes
5. re-run dogfood until survivors empty (or accept needs_human)
6. stop — do not auto-commit or unbounded multi-agent rewrite
```

`dogfood` scopes the diff to:

- `scripts/dev/adversarial-review/**`
- `docs/adversarial-review.md`
- `openclaw/scripts/claw-worktree.sh` (path core often co-evolves)

Stopping conditions (hard):

- max 3 dogfood→fix cycles per session unless a human re-authorizes
- never `git commit` / `git push` from inside repro scripts
- never treat SINGLE-MODEL (refuter unavailable) as full cross-agent success

## Structure

```
scripts/dev/adversarial-review/
  run.sh                     three-gate orchestration (agent-agnostic)
  lib/provider.sh            ONLY agent-specific code
  lib/findings-schema.json   inter-stage JSON contract (enforced)
  prompts/{critic,refute,repro}.md
docs/adversarial-review.md   this file
```

## Provider status

- **Claude** — verified end-to-end (2026-07-18); `selfcheck claude` expected green.
- **Codex** — adapter written; may be unavailable on PATH. When unavailable, gate 2
  is **skipped and reported**; title marks possible SINGLE-MODEL. Do not silently
  claim cross-agent.

## Safety

- Reviewer/refuter generation run **read-only** (Claude plan mode + read tool allowlist).
- Repro scripts run in a **detached `git worktree` at HEAD** (not the dirty primary),
  with a 60s timeout and a danger-pattern scan; flagged scripts are not executed
  (`needs_human`).
- Nothing is auto-fixed. Survivors are for you (or a supervised agent) to adjudicate.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | completed; no strict survivors (or fail-on not set) |
| 1 | usage |
| 2 | reviewer provider unusable |
| 3 | internal (e.g. invalid stage1 JSON) |
| 10 | `--fail-on-finding` and ≥1 strict survivor |

## Open questions

1. Codex CLI binary + `exec --json` flags on this host (`selfcheck codex`).
2. Project-specific verify conventions for gate 3 beyond shell/unit checks.
3. Cost controls for huge monorepo diffs (`--paths` future).

## What it is NOT

- Not a style/simplification pass (`/simplify`).
- Not an unbounded self-modifying agent. Dogfood is a **supervised** loop.
- Not a substitute for human ownership of security-critical merges.
