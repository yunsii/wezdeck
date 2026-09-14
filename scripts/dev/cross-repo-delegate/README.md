# cross-repo-delegate — cross-repo tickets (MVP)

Platform skill + runner. Skill id: **`cross-repo-delegate`**. See [`SKILL.md`](./SKILL.md).

```bash
./test.sh                     # MOCK: isolated tickets + fake repos (preferred)
./run.sh selfcheck
./run.sh install-cli          # short CLI → ~/.local/bin/delegate

# File + auto research dispatch on target repo worktree:
delegate create --to <target> --from . --title "…" \
  --observed "…" --assumed "…" --run [--backend claude]

# Or dispatch an existing ticket:
delegate run --id req-… --phase research [--backend claude]
# Offline: add --mock (no LLM / no worktree)
# Workers use scripts/dev/host-agent-invoke/ (write). See docs/agent-scheduling.md
```

From wezdeck root, `./scripts/dev/link-platform-skills.sh` links the skill and installs the short CLI.

Tickets: `~/.agent/tickets/` (see `templates/tickets-README.md`).

Worker prompts embed a **phase view** (not the full `ticket.md`): both phases
keep Summary+Assumptions (the contract); implement also gets Verification+Decision.
`Thread` / `events.jsonl` stay on disk for humans / on-demand Read — trim noise,
not the contract.
