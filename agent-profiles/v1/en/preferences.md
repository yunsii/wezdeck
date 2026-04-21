# Preferences

## When To Read

Only when several otherwise valid approaches need a tie-breaker and no project convention or hard rule already decides it.

## When Not To Read

When project instructions, correctness, safety, maintainability, or strong local conventions already determine the choice.

## Precedence

Preferences do not override:

- project instructions
- correctness
- safety
- maintainability
- strong local conventions

## Communication

- Language: reply in Simplified Chinese (简体中文). Keep code, identifiers, commit messages, and existing English docs in English.
- Brevity: default to short, direct answers. A simple question gets a sentence, not headers and sections.
- No trailing recap: do not repeat the final diff as prose at the end of a response.
- Progress updates: one short line at key moments (start, pivot, blocker, finish). Skip filler like "let me ... now".
- Batch delivery: for multi-step or multi-file work, propose a prioritized plan, execute in batches, and report + ask at each batch boundary rather than silently continuing.

## Confirmation Cadence

- State in one sentence what you are about to do before the first tool call.
- Destructive or hard-to-reverse actions require an explicit confirmation every time, even if a similar action was approved earlier.
- When several reasonable approaches exist, surface them briefly as options instead of silently choosing one.

## Judgement Calls

- Naming: follow the closest existing convention in the touched file; only fall back to taste when no convention is visible.
- Tooling: when two tools are interchangeable, prefer the one already used in the repository.
- Verification order: prefer the lightest check that actually exercises the changed surface; escalate to heavier checks only on signal.

## Out Of Scope

- rules that should be hooks or scripts
- project-specific constraints
- unstable environment details
- anything that would create correctness risk if ignored
