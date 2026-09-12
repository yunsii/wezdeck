---
name: human-run
description: >
  Mandatory handoff when a human (not the agent) must run a script/command.
  Agent loads this skill, proposes via wezdeck `wd-run` with an explicit --cwd,
  and tells the human to preview/run with `x`. Never paste multi-line scripts
  into chat for the human to copy. Agent self-exec is out of scope — keep using
  tools. Use when: you would otherwise ask the user to paste/run a script, the
  command needs interactive TTY / host secrets / out-of-sandbox privileges, or
  the user must visually confirm before exec.
---

# human-run (platform skill — single source)

**Who runs the script:** the **human**, via shell command `x`.  
**Who prepares it:** the **agent**, via `wd-run propose` (this skill).  
**Never** paste a multi-line script into chat as the execution channel.  
**Never** wrap agent self-exec through this skill — tools already run those.

This directory is the skill unit. Runtime CLI lives in wezdeck
`scripts/runtime/cli/{wd-run,x}` + `agent-run-lib.sh`. Docs:
`docs/agent-run.md`. User-level doctrine: `agent-profiles` → `reporting.md`
(Human-run handoff).

## Who runs what

| Actor | Duty |
| --- | --- |
| **Human** | In a real terminal: `x` (peek → confirm → run in recorded cwd) |
| **Any agent** | **Load this skill → propose → tell user only `x`** |
| **Agent tools** | Self-runnable work — do **not** call this skill |

## When to load (mandatory)

Load and follow this skill whenever **any** of these is true:

- You are about to ask the human to run / paste / copy a shell script or multi-line command
- The command needs a real TTY, GUI, host secret the agent must not hold, or privileges outside the agent sandbox
- The human must read and approve the exact script before it runs

**Do not load / do not propose** when:

- You can run it yourself with available tools (default)
- It is only an illustrative snippet (mark as 勿粘贴执行; no `propose`)

## Resolve WD_RUN

First hit wins:

```text
1. $WD_RUN                              # explicit override
2. $HOME/.wezterm-x/agent-tools.env → wd_run=… (must exist + executable)
3. command -v wd-run
4. $WEZTERM_REPO/scripts/runtime/cli/wd-run
5. $HOME/github/wezterm-config/scripts/runtime/cli/wd-run
6. else: fail — "wd-run not on PATH; sync-runtime / wezterm-env.env / link-platform-skills"
```

Human short command `x` is installed next to `wd-run` under `scripts/runtime/cli/`
(PATH via `~/.config/shell-env.d/wezterm-env.env`).

## Agent procedure

1. **Decide** this is human-only (if unsure and you *can* self-run → self-run).
2. **Resolve** `WD_RUN` (above). Fail clearly if missing — do not fall back to chat paste.
3. **Choose cwd** — absolute or resolvable existing directory the script must run in.
   Relative paths are OK at propose time; `wd-run` canonicalizes. **Never omit `--cwd`.**
4. **Propose** (body via stdin or temp file — never as argv):

   ```bash
   "$WD_RUN" propose \
     --cwd "/abs/workdir" \
     --actor "${AGENT_NAME:-agent}" \
     --summary "short title ≤80" \
     --stdin <<'EOF'
   # script body
   EOF
   ```

5. **Report to the human** (Chinese OK): one line instruction to run `x`.
   Optionally include `id=…` from propose stdout. **Do not** reprint the script body
   as something to paste. Illustrative excerpts only if marked 仅供阅读 / 勿粘贴执行.
6. **Stop** — do not poll for completion unless the user asks; they own `x`.

## Don't

- Don't paste multi-line runnable scripts into chat for copy-paste
- Don't `propose` work you can run with tools
- Don't omit `--cwd` or invent a cwd that does not exist
- Don't ask the human to run `wd-run` as the primary path — that is `x`
- Don't confuse shell `x` with WezTerm **`Alt+x`** (overflow picker)

## Related

- Runtime: `scripts/runtime/cli/wd-run`, `scripts/runtime/cli/x`, `agent-run-lib.sh`
- Docs: `docs/agent-run.md`
- Profile: `agent-profiles/v1/en/reporting.md` → Human-run handoff
- Install links: `scripts/dev/link-platform-skills.sh`
