# cross-repo-delegate — cross-repo tickets (MVP)

Platform skill + runner. Skill id: **`cross-repo-delegate`**. See [`SKILL.md`](./SKILL.md).

## Three modes

| Mode | Command | Who develops |
| --- | --- | --- |
| 1. 主会话创建工单 | `create` (no `--run`) | nobody yet — ticket in inbox |
| 2. 主会话认领并开发 | `claim` → edit in current TUI/cwd | claiming session (`owner=human`) |
| 3. 主会话建单并委托开发 | `create … --run` / `run --phase auto` | headless worker + `delegate-*` worktree |

**Claim never implies run/worktree.** Mode 3 is explicit opt-in only.

```bash
./test.sh                     # MOCK: isolated tickets + fake repos (preferred)
./run.sh selfcheck
./run.sh install-cli          # short CLI → ~/.local/bin/delegate

# Mode 1 — file only:
delegate create --to <target> --from . --title "…" \
  --observed "…" --assumed "…"

# Mode 2 — claim + develop in this session:
delegate inbox --to .
delegate claim --id req-…
delegate show --id req-…
# …edit code here; challenge / close — do NOT run

# Mode 3 — file + headless dispatch on target worktree:
delegate create --to <target> --from . --title "…" \
  --observed "…" --assumed "…" --run [--backend claude]

# Or dispatch an existing unclaimed / worker-owned ticket:
delegate run --id req-… --phase research [--backend claude]
# Session lease held → refused unless --steal
# Offline: add --mock (no LLM / no worktree)
# Workers use scripts/dev/host-agent-invoke/ (write). See docs/agent-scheduling.md
```

From wezdeck root, `./scripts/dev/link-platform-skills.sh` links the skill and installs the short CLI.

Tickets: `~/.agent/tickets/` (see `templates/tickets-README.md`).

Worker prompts embed a **phase view** (not the full `ticket.md`): both phases
keep Summary+Assumptions (the contract); implement also gets Verification+Decision.
`Thread` / `events.jsonl` stay on disk for humans / on-demand Read — trim noise,
not the contract.
