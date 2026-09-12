---
name: human-run
description: >
  Mandatory handoff when a human (not the agent) must run a script/command.
  Agent loads this skill, runs ensure-env (check+init), proposes via propose.sh
  with an explicit --cwd, and tells the human to preview/run with `x`. Never
  paste multi-line scripts into chat. Agent self-exec is out of scope. Use when:
  you would otherwise ask the user to paste/run a script, the command needs
  interactive TTY / host secrets / out-of-sandbox privileges, or the user must
  visually confirm before exec.
---

# human-run (platform skill — single source)

**Who runs the script:** the **human**, via shell command `x`.  
**Who prepares it:** the **agent**, via this skill’s `ensure-env.sh` + `propose.sh`.  
**Never** paste a multi-line script into chat as the execution channel.  
**Never** wrap agent self-exec through this skill — tools already run those.

Runtime CLI lives in the same wezdeck tree as this skill:
`scripts/runtime/cli/{wd-run,x}` + `agent-run-lib.sh`.  
Docs: `docs/agent-run.md`. Profile: `agent-profiles` → `reporting.md`.

## Who runs what

| Actor | Duty |
| --- | --- |
| **Human** | In a real terminal: `x` (peek → confirm → run in recorded cwd) |
| **Any agent** | **Load skill → ensure-env → propose.sh → tell user only `x`** |
| **Agent tools** | Self-runnable work — do **not** call this skill |

## When to load (mandatory)

Load whenever **any** of these is true:

- You are about to ask the human to run / paste / copy a shell script or multi-line command
- The command needs a real TTY, GUI, host secret the agent must not hold, or privileges outside the agent sandbox
- The human must read and approve the exact script before it runs

**Do not load** when you can run it with tools, or when the snippet is illustrative only (mark 勿粘贴执行).

## Resolve TOOL_HOME

```text
1. directory of this SKILL.md (follow symlinks; ~/.agents/skills/human-run → …)
2. $HUMAN_RUN_HOME if set
3. else fail — re-run link-platform-skills.sh from a wezdeck that has human-run
```

## Environment check + init (mandatory first step)

**Do not** hand-roll path guessing in the chat. Always:

```bash
TOOL_HOME="$(readlink -f "${HUMAN_RUN_HOME:-$HOME/.agents/skills/human-run}")"
"$TOOL_HOME/ensure-env.sh"
```

`ensure-env.sh` is idempotent. It:

1. Verifies this skill’s wezdeck tree has `wd-run` / `x` / `agent-run-lib.sh`
2. If `$WEZTERM_REPO/scripts/runtime/cli` lacks them, **symlinks** from the skill tree (so `wezterm-env` PATH and human `x` work even when that clone’s HEAD is behind)
3. Writes/updates `~/.wezterm-x/agent-tools.env` with a working `wd_run=`
4. Smokes the binary; prints the absolute `wd-run` path on stdout

If ensure-env fails → **fail closed** (report the ensure-env stderr). Do **not** paste scripts into chat.

## Agent procedure

1. **Decide** this is human-only (if you can self-run → do that; skip this skill).
2. **Ensure env:** `"$TOOL_HOME/ensure-env.sh"` (required).
3. **Choose cwd** — existing directory; never omit `--cwd`.
4. **Propose** via the skill wrapper (runs ensure again, then propose):

   ```bash
   "$TOOL_HOME/propose.sh" \
     --cwd "/abs/workdir" \
     --actor "${AGENT_NAME:-agent}" \
     --summary "short title ≤80" \
     --stdin <<'EOF'
   # script body
   EOF
   ```

5. **Tell the human** one line: run `x`. Optional `id=…` from stdout. Do not reprint the script as paste payload.
6. **Stop** — they own `x`.

## Don't

- Don't paste multi-line runnable scripts into chat
- Don't skip `ensure-env.sh` / `propose.sh` and call a guessed `wd-run` path
- Don't `propose` work you can run with tools
- Don't omit `--cwd`
- Don't ask the human to run `wd-run` as the primary path — that is `x`
- Don't confuse shell `x` with WezTerm **`Alt+x`**

## Related

- `ensure-env.sh`, `propose.sh`, `lib/resolve-wd-run.sh` (this dir)
- Runtime: `scripts/runtime/cli/wd-run`, `scripts/runtime/cli/x`
- Docs: `docs/agent-run.md`
- Install links: `scripts/dev/link-platform-skills.sh`
