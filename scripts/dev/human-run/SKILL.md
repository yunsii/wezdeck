---
name: human-run
description: >
  Mandatory handoff when a human (not the agent) must run a script/command.
  Agent loads this skill, ensure-env, propose.sh --cwd (default --wait until x
  finishes), then the agent continues follow-up itself. Handoff script bodies
  must be non-blocking kickoffs (trigger/async ack) — never wait for CI/deploy
  inside x. Never paste multi-line scripts into chat. Agent self-exec is out of
  scope. Use when you would otherwise ask the user to paste/run a script, or
  the command needs TTY / host secrets / out-of-sandbox privileges.
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

## Script body contract (non-blocking kickoff)

`x` only covers the **human-gated moment**. The script must finish quickly so
`wd-run wait` returns and **you** resume ownership of the long tail.

| Put in the `x` script | Keep out of the `x` script (agent after wait) |
| --- | --- |
| Trigger / fire-and-forget (start deploy, enqueue job, open privileged CLI that submits then exits) | Poll CI / pipeline / rollout until green |
| Print a clear “triggered” ack + any id/url the agent will need | `sleep` loops, `gh run watch`, `kubectl rollout status` waits |
| Fail fast if trigger rejected | Multi-stage verification the agent can do with tools |

**Rule:** prefer async trigger + exit 0 once accepted. If a tool has sync vs async
modes, choose async for the handoff body. After `propose.sh --wait` returns,
the agent polls / verifies / retries with its own tools.

Anti-patterns (do **not** ship in handoff body):

```bash
# BAD — blocks the human and the agent's wait on CI
gh run watch "$id" --exit-status
while ! curl -fsS "$health"; do sleep 5; done
```

```bash
# GOOD — trigger only; agent continues after wait
gh workflow run deploy.yml -f ref=…
echo "triggered workflow=deploy.yml"   # agent scrapes / lists runs next
```

## Agent procedure

1. **Decide** this is human-only (if you can self-run → do that; skip this skill).
2. **Split the work:** handoff body = non-blocking kickoff; post-wait = agent-owned follow-up.
3. **Ensure env:** `"$TOOL_HOME/ensure-env.sh"` (required).
4. **Choose cwd** — existing directory; never omit `--cwd`.
5. **Tell the human first** (one line): 请在本机终端运行 `x` 预览并确认（脚本应很快结束）。Do not paste the script body.
6. **Propose + wait** — same shape as a normal blocking/background shell task.
   `propose.sh` **defaults to `--wait`** (blocks until `x` finishes — which should
   be seconds, not CI duration). Prefer host background if needed. **No** attention badge.

   ```bash
   "$TOOL_HOME/propose.sh" \
     --cwd "/abs/workdir" \
     --actor "${AGENT_NAME:-agent}" \
     --summary "short title ≤80" \
     --timeout 600 \
     --stdin <<'EOF'
   # non-blocking kickoff only
   EOF
   ```

   Default `--timeout` for wait should assume a **short** human action (minutes),
   not a full pipeline. Or split: `propose.sh --no-wait …` then `wd-run wait --id …`.

7. **Continue after wait** — with tools, handle CI/status/verification yourself.
   Do not ask the human to sit in `x` until the pipeline ends.

## Don't

- Don't put long waits / CI watches inside the handoff script body
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
