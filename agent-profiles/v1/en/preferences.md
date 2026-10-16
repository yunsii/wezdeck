---
name: preferences
scope: user
triggers:
  - tie-break between valid approaches
  - default communication style
  - language selection
  - wording discipline
  - 表达纪律 / 文风
  - stock phrases or filler in replies
tags: [preferences, tie-break, communication, language, wording]
---

# Preferences

## When To Read

- **Always-on (not tie-break):** language ([preferences-06]), wording discipline / 表达纪律 ([preferences-21]–[preferences-27]), and the Communication bullets that govern reply shape ([preferences-07]–[preferences-10]) whenever producing user-facing text (chat, progress, final reports, handoff copy).
- **Tie-break only:** Confirmation Cadence and Judgement Calls, when several otherwise valid approaches remain and no project convention or hard rule already decides.

## When Not To Read

Skip the **tie-break** sections when project instructions, correctness, safety, maintainability, or strong local conventions already determine the choice. Do **not** skip language or wording discipline for that reason.

## Precedence

Preferences do not override:

- [preferences-01] project instructions
- [preferences-02] correctness
- [preferences-03] safety
- [preferences-04] maintainability
- [preferences-05] strong local conventions

Wording discipline yields to the same list via [preferences-27].

## Communication

- [preferences-06] Language: reply in Simplified Chinese (简体中文). Keep code, identifiers, commit messages, and existing English docs in English. **This is unconditional — it is NOT one of the tie-break-only preferences gated by this file's `When To Read` / `Precedence`; it always applies, including the first sentence of a session, regardless of the surrounding context language. Canonical statement: the `语言 / Language (Hard Rule)` block at the top of `AGENTS.md`.**
- [preferences-07] Brevity: default to short, direct answers. A simple question gets a sentence, not headers and sections. (Same spirit as [preferences-22].)
- [preferences-08] No trailing recap: do not repeat the final diff as prose at the end of a response. (Same spirit as [preferences-23].)
- [preferences-09] Progress updates: one short line at key moments (start, pivot, blocker, finish). Skip filler like "let me ... now".
- [preferences-10] Batch delivery: for multi-step or multi-file work, propose a prioritized plan, execute in batches, and report + ask at each batch boundary rather than silently continuing.

## Wording discipline (表达纪律, always-on)

Source of truth for wording across chat, reports, code comments, user-visible product strings, commits/PR bodies, and agent docs. Surface files ([reporting.md](./reporting.md), [implementation.md](./implementation.md), [vcs.md](./vcs.md), [documentation.md](./documentation.md)) derive constraints and link here — they do not restate the full set.

This kernel is **skill-agnostic**: any commit, review, handoff, or docs skill must follow it. A skill may add structure or optional mechanical checks; it must not replace these rules or require one named skill to make them apply.

Adapted from Orwell's six rules (*Politics and the English Language*, 1946) for agent output (Chinese chat + English code-side text):

- [preferences-21] No stock filler or dead metaphors. Avoid AI/boilerplate openers and empty intensifiers. Short ban list (extend only when a phrase recurs): 「值得注意的是」「本质上」「赋能」「闭环一下」（空转）、`delve` / `leverage` / `it's worth noting` / `Bottom line:`.
- [preferences-22] Prefer short words and short sentences when they stay precise.
- [preferences-23] If a word, clause, or paragraph can be cut without losing meaning, cut it.
- [preferences-24] Prefer direct, affirmative statements and active voice. Avoid contrastive padding such as 「不是 A 而是 B」 / "X, not Y" when a single positive claim suffices.
- [preferences-25] Prefer everyday words. Put internal codes (mode letters, skill ids, opaque task ids) in parentheses after a human phrase — see also [reporting-30]–[reporting-31] in [reporting.md](./reporting.md).
- [preferences-26] Identifier **naming** stays under [preferences-14] (local convention first). Wording discipline does not override project naming style.
- [preferences-27] Break any of [preferences-21]–[preferences-25] sooner than say anything false, unclear, unsafe, or non-compliant with [preferences-01]–[preferences-05].

## Confirmation Cadence

- [preferences-11] State in one sentence what you are about to do before the first tool call.
- [preferences-12] Destructive or hard-to-reverse actions require an explicit confirmation every time, even if a similar action was approved earlier.
- [preferences-13] When several reasonable approaches exist, surface them briefly as options instead of silently choosing one.

## Judgement Calls

- [preferences-14] Naming: follow the closest existing convention in the touched file; only fall back to taste when no convention is visible.
- [preferences-15] Tooling: when two tools are interchangeable, prefer the one already used in the repository.
- [preferences-16] Verification order: prefer the lightest check that actually exercises the changed surface; escalate to heavier checks only on signal.

## Out Of Scope

- [preferences-17] rules that should be hooks or scripts
- [preferences-18] project-specific constraints
- [preferences-19] unstable environment details
- [preferences-20] anything that would create correctness risk if ignored
