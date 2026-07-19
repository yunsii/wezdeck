---
name: validation
scope: user
triggers:
  - completion criteria
  - testing strategy
  - manual verification threshold
  - rollout confidence
  - failure handling
  - plan-time validation
  - adversarial review
  - 对抗审查
  - multi-role review
tags: [quality, testing, escalation, evidence, adversarial-review]
---

# Validation

## When To Read

When the task involves correctness, completion criteria, testing strategy, rollout confidence, or whether to ask the user to verify something manually.

## When Not To Read

When the change has no observable behavior surface and no validation decision is in scope. The one-liner in AGENTS.md is enough for those cases.

## Default

Complete tasks with machine-verifiable confidence and minimal human interruption.
Human review is a fallback, not a default step.

## Complete When

A task is complete when all of the following are true:

- [validation-01] the requested change is implemented
- [validation-02] the relevant system still behaves as expected
- [validation-03] the strongest practical automatic verification available has been run
- [validation-04] any unverified risks are stated clearly

## Validation Order

Use the lightest useful path first:

- [validation-05] Read and reason about the current implementation boundaries
- [validation-06] Run static validation if available
- [validation-07] Run the narrowest behavior-focused validation that covers the change
- [validation-08] Expand to integration or end-to-end validation only when the change justifies it

[validation-09] Do not skip directly to heavy validation when a narrower check would establish correctness.

## Default Rule

- [validation-10] Do not ask the user to manually verify something if the agent can verify it directly, script it, or narrow the uncertainty further.
- [validation-11] Prefer adding the smallest durable check over asking for manual confirmation.

## When To Plan

- [validation-31] Prefer a short explicit plan before execution when the task scope is large or open-ended, several reasonable approaches exist, or a decision is hard to reverse. Surfacing disagreement early is cheaper than redoing work.
- [validation-32] Skip planning for narrowly-scoped edits, single-file bug fixes, or mechanical operations where the next action is obvious and low-risk. A plan for a one-line fix is overhead.

## At Plan Time

- [validation-29] Treat the validation loop as a first-class element of any plan. Name how the change will be verified before execution starts, not after.
- [validation-30] Do not propose human verification as the primary check. If a plan has to rely on it, state explicitly why self-validation is blocked and propose a concrete alternative (scripted check, narrower surface, added instrumentation, stubbed integration). A vague "needs user eyes" is not an acceptable justification.

## Escalate Only When

Human intervention is acceptable only when:

- [validation-12] access or credentials are required
- [validation-13] the environment is unavailable to the agent
- [validation-14] the result depends on subjective product judgment
- [validation-15] hardware, UI, or external systems cannot be exercised automatically
- [validation-16] the remaining uncertainty cannot be reduced further without the user

## Missing Tests

If no test exists, do not automatically stop. Choose one of these paths:

- [validation-17] add the smallest focused test if the repo supports tests
- [validation-18] run an equivalent script or command if a test would be disproportionate
- [validation-19] document the exact unverified surface if neither is practical

## Failure Handling

When validation fails:

- [validation-20] identify whether the failure is in the change, the environment, or pre-existing breakage
- [validation-21] narrow the failure surface
- [validation-22] retry only when there is a concrete reason
- [validation-23] report pre-existing failures separately from new regressions

[validation-24] Treat pre-existing breakage and new regressions as different outcomes.

## Bug Diagnosis

- [validation-33] Reproduce first. Without a reliable repro, proposed fixes are guesses; a weak or flaky repro is a signal to keep narrowing, not to patch blindly.
- [validation-34] Minimize the failing surface before proposing a fix — strip unrelated branches, data, configuration, and environment variation until the smallest failing case remains.
- [validation-35] Find the root cause; do not stop at the first symptom that goes away. A workaround can ship, but it must be labeled as a workaround, not presented as a fix.
- [validation-36] Do not guess-and-retry. Each attempted fix must carry an explicit hypothesis about what actually changed and why the fix addresses it.

## Confidence Language

Use precise language:

- [validation-25] `verified` when actually checked
- [validation-26] `inferred` when concluded from code or evidence
- [validation-27] `not verified` when no direct validation was possible

[validation-28] Do not blur these categories.

## Examples

Good — applies [validation-07] and [validation-10]: narrow automated check, no human in the loop, precise confidence language.

```
$ pytest tests/test_cache.py::test_eviction_under_pressure -q
.                                                                  [100%]
1 passed in 0.42s
```

> Verified the regression with one focused test (`test_eviction_under_pressure`). Ran `tsc --noEmit` as static check. No remaining unverified surface.

Bad — violates [validation-10]: delegates reducible uncertainty back to the user.

```
I pushed the fix. Could you run the app and confirm the cache eviction
works under load? Let me know if anything looks off.
```

The agent could have written a targeted test or script; asking the user is a fallback, not a first move.

## Performance and UX cost

- [validation-40] Do not over-optimize by default during implementation.
- [validation-41] When the change touches interactive UX, first paint, or a known hot path, establish a reproducible baseline before the change when practical.
- [validation-42] If acceptance shows clear UX regression or metric degradation: diagnose the cause before declaring done.
- [validation-43] If the cost is a necessary overhead of the new feature, state it explicitly (what got slower, by roughly how much, and whether it is acceptable) — do not ship silent regressions.

## Adversarial review (platform capability)

Multi-role defect review is a **shared platform capability**, not a human homework script.
When the user asks for 对抗审查 / adversarial review, or acceptance recommends it for runtime changes:

- [validation-50] The **agent** loads the skill and runs the runner; do **not** make the human the primary operator of `run.sh`.
- [validation-51] 「对抗审查」requires at least **find + refute** (repro recommended). A solo monologue is **设计批判** only — never label it 对抗审查.
- [validation-52] Prefer backends **outside the writer family** (writer-aware selection). Same-model multi-role is allowed only when availability forces it; label **SINGLE-MODEL** / degraded.
- [validation-53] In wezdeck (this repo), discovery order:
  1. Repo skill: `skills/adversarial-review/SKILL.md`
  2. OpenClaw workspace skill: `openclaw/workspace/skills/adversarial-review/SKILL.md`
  3. Runner (only implementation): `scripts/dev/adversarial-review/run.sh`
- [validation-54] Typical invoke from repo root or claw worktree:
  `scripts/dev/adversarial-review/run.sh <BASE_REF> --writer <main|claude|codex|human> --mode strict`
- [validation-55] Report with disclosure: writer, form/degraded/reason, reviewer, refuter, repro status, skipped_gates, conclusions bound to gates. Align with openclaw L0-21 spirit.
- [validation-56] Review uses **host headless** CLIs (`claude` / `codex-gpt` / `codex-grok`), not OpenClaw ACP `CODEX_HOME` by default.
- [validation-57] Outside wezdeck: if the runner/skill is absent, say so and fall back to design critique or skip — do not invent a green multi-role review.
