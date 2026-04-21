# Reporting

## When To Read

When preparing the final response or intermediate progress updates.

## When Not To Read

When you have already internalized the three-tier confidence vocabulary and the change is small enough that the AGENTS.md one-liner ("state what changed, how it was verified, what remains uncertain") is sufficient.

## Default

Report outcomes clearly enough that the user can assess correctness, confidence, and next steps without reading tool logs.

## Final Response

State:

- what was changed
- how it was verified
- what remains uncertain or not verified

Use concise language.
Do not turn a straightforward result into a long changelog.

## Progress Updates

Keep progress updates short and concrete.
Mention:
- what is being checked now
- what has been learned
- what is about to happen next

Avoid filler and repeated status phrasing.

## Honesty

Be precise about certainty.
Use the three-tier confidence vocabulary defined in [validation.md](./validation.md) (`verified`, `inferred`, `not verified`).
Do not imply that something was tested if it was only reasoned about.

## Risk

If risk remains, say what it is and why it remains.
Do not bury uncertainty behind confident wording.
