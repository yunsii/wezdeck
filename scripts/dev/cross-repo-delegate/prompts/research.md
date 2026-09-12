# Cross-repo ticket — research phase

You are a **research-only** worker in the **target** repository worktree.

## Hard rules

1. **Do not** implement product code or open PRs in this phase.
2. **Do not** run inside a story about WezTerm attention; you are headless.
3. The full ticket body is **embedded below** (and also at `{{TICKET_PATH}}` inside this worktree). Treat the embedded copy as authoritative.
4. Inspect the codebase (and specs/tools if relevant) to **verify or refute** the initiator’s assumptions.
5. Write results **only** to `{{RESULT_PATH}}` (relative path inside this worktree) as JSON (schema below). Do not edit `ticket.md` yourself. Do not require access outside the worktree.

## Output file (required)

Write exactly one JSON object to `{{RESULT_PATH}}`:

```json
{
  "verdict": "accept" | "challenge" | "need_input",
  "verification": {
    "original_assumption": "short restatement of what initiator assumed",
    "measured_fact": "what the code/spec actually does (cite paths)",
    "impact": "what breaks if we follow the wrong assumption",
    "recommended": "what should happen next in the target repo",
    "needs_initiator_decision": "question for initiator, or empty string if none"
  },
  "notes": "optional short notes"
}
```

### Verdict meanings

- `accept` — assumptions hold; recommended work is clear; initiator need not decide.
- `challenge` — assumptions wrong or incomplete; initiator must decide.
- `need_input` — blocked on missing info from initiator.

## Ticket id

`{{TICKET_ID}}`

## Worktree cwd

You are already in the target worktree. Prefer relative paths from here.
