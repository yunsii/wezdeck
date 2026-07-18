---
name: reporting
scope: user
triggers:
  - final response preparation
  - progress updates
  - confidence wording
  - evidence summaries
  - option recommendations
tags: [reporting, honesty, confidence-vocabulary]
---

# Reporting

## When To Read

When preparing the final response or intermediate progress updates.

## When Not To Read

When you have already internalized the three-tier confidence vocabulary and the change is small enough that the AGENTS.md one-liner ("state what changed, how it was verified, what remains uncertain") is sufficient.

## Default

[reporting-01] Report outcomes clearly enough that the user can assess correctness, confidence, and next steps without reading tool logs.

## Final Response

State:

- [reporting-02] what was changed
- [reporting-03] how it was verified
- [reporting-04] what remains uncertain or not verified

- [reporting-05] Use concise language.
- [reporting-06] Do not turn a straightforward result into a long changelog.
- [reporting-26] For non-trivial analysis or recommendation, include a concise evidence line: local source, upstream source analysis, official docs, tests/logs, current external references, or deeper research skipped because `<reason>`.
- [reporting-27] When recommending a path among meaningful alternatives, include the considered options, chosen option, why it wins, and remaining tradeoffs.
- [reporting-28] Do not claim multi-source confirmation unless those sources were actually checked.
- [reporting-29] If the final answer relies on inference rather than direct evidence, label it with the confidence vocabulary from [validation.md](./validation.md).

## Final Response Templates

[reporting-20] Choose one main template based on the task outcome: feature, bugfix, refactor, docs/config, or investigation.

[reporting-21] Treat design change as an optional block, not a separate task type.

[reporting-22] Add a visual summary when a design, workflow, state transition, data flow, command chain, user interaction flow, or option selection changed.

[reporting-23] Prefer compact ASCII diagrams for visual summaries. Use them to clarify structure, not to decorate the response.

[reporting-24] Do not add diagrams for typo fixes, one-line local bug fixes, mechanical formatting, dependency bumps without behavior change, or changes already obvious from one short sentence.

[reporting-25] A visual summary never replaces the required outcome, verification, and uncertainty statements.

Use these as compact starting points, not mandatory prose:

```md
**Feature Complete**
Status: [verified|inferred|not verified]

Delivered:
- ...

Behavior:
- ...

Verified:
- `...`

Not Covered:
- ...
```

```md
**Bug Fixed**
Status: [verified|inferred|not verified]

Root Cause:
- ...

Changed:
- ...

Verified:
- Reproduced before fix: ...
- Confirmed after fix: ...

Remaining Risk:
- ...
```

```md
**Refactor Complete**
Status: [verified|inferred|not verified]

Changed:
- ...

Behavior:
- Intended behavior unchanged.

Verified:
- `...`

Risk:
- ...
```

```md
**Docs / Config Updated**
Status: [verified|inferred|not verified]

Changed:
- ...

Impact:
- ...

Verified:
- ...

Not Verified:
- ...
```

```md
**Investigation Result**
Status: [verified|inferred|not verified]

Found:
- ...

Evidence:
- ...

No Change Made:
- ...

Recommended Next Step:
- ...
```

Optional visual block:

```md
Design Change:

Before:
A -> B -> C

After:
A -> Guard -> B -> C

Why:
- Chose this because ...
```

Option-selection visual:

```text
Options
|-- A. Patch local callsite
|   `-- Fast, but duplicates behavior
|-- B. Move logic into shared helper
|   `-- Slightly larger, but keeps one owner
`-- Chosen: B
    `-- Reason: behavior is shared by multiple entry points
```

## Progress Updates

[reporting-07] Keep progress updates short and concrete.

Mention:

- [reporting-08] what is being checked now
- [reporting-09] what has been learned
- [reporting-10] what is about to happen next

[reporting-11] Avoid filler and repeated status phrasing.

## Honesty

- [reporting-12] Be precise about certainty.
- [reporting-13] Use the three-tier confidence vocabulary defined in [validation.md](./validation.md) (`verified`, `inferred`, `not verified`).
- [reporting-14] Do not imply that something was tested if it was only reasoned about.

## Risk

- [reporting-15] If risk remains, say what it is and why it remains.
- [reporting-16] Do not bury uncertainty behind confident wording.

## Large Output

- [reporting-17] When tool output is large (long diff, long log, full test report), do not inline it wholesale in the response. Summarize and either point at the artifact's location or quote a narrowed slice.
- [reporting-18] If the user may need the full output, name where it lives (file path, log location, PR URL) rather than pasting it.
- [reporting-19] Preserve failure-relevant portions verbatim — error lines, failing test names, non-zero exit summaries. The user should not have to ask for the evidence.

## Human-readable user text

- [reporting-30] Prefer plain language the user can read without decoding internal codes (mode letters A–E, skill ids, opaque task ids as the only subject).
- [reporting-31] When an internal code is useful, put the human meaning first and the code in parentheses — e.g. "Main 自写（B）", not bare "开发方式 B".
- [reporting-32] Final answers and progress updates must not leave the user to reverse-engineer platform dumps (raw arrow-lists of failed exec steps without explanation).

## Error closed-loop (reporting side)

- [reporting-33] After any failure (including recovered ones), close the loop in user-facing text: what failed, why, what you did, impact, and either verified recovery or options with a recommendation.
- [reporting-34] Bare stack traces, undecoded platform "Exec failed" lists, or silent retry with no report are non-compliant.
- [reporting-35] When stuck, escalate with situation + at least two concrete options (or one option plus a clear blocker) and a recommended default — not only "something went wrong".

## Rule promotion prompts

- [reporting-36] When a constraint recurs across tasks, a process incident occurs, or the user states a lasting rule, ask whether to elevate it to profile / skill / script, with placement and tradeoffs; never silently rewrite the profile.
