# Agent Run Handoff (`human-run` + `wd-run` / `x`)

Three layers — do not collapse them:

| Layer | Role |
| --- | --- |
| **User-level profile** (`agent-profiles` → `reporting.md`) | Doctrine: when human must run something, skill is **mandatory**; no chat paste channel; agent self-exec stays on tools |
| **Platform skill** `human-run` | Procedure agents load: resolve `wd-run`, staged chat (preparing → ready peek-header → result), `propose --no-wait` then `wait`, human `x` |
| **wezdeck runtime CLI** `wd-run` / `x` | Store, CAS, audit, retention, execute in recorded cwd |

Human-only handoff. Agent self-exec is **out of scope**.

## Why

Multi-line scripts pasted from a TUI chat often pick up broken newlines.
Handoff payloads live on disk; the human peeks with `x` (pager) and
confirms. Chat should at most show one line: `x`.

## Boundary

| In scope | Out of scope |
| --- | --- |
| Agent cannot / must not run it; human must | Agent tool shell / self-exec |
| Skill `human-run` → `wd-run propose` → `x` | Attention `waiting`, session-bridge `take` |
| Audit of handoff lifecycle | Wrapping every managed command |

## Agent path (mandatory, staged)

1. Load skill `human-run`.
2. Run `"$TOOL_HOME/ensure-env.sh"` (check + init; idempotent).
3. **Session① preparing:** user-visible line that a handoff is being written —
   do **not** ask the human to run `x` yet (skill template).
4. `"$TOOL_HOME/propose.sh" --no-wait --cwd … --summary …` — require a
   human-readable `--summary` (peek title). stdout: `id=…`. stderr:
   `agent-run: ready` block whose fields match the `x` peek page header
   (`id` / `status` / `actor` / `cwd` / `summary`).
5. **Session② ready:** restates that peek header, then asks the human to run
   `x` (only moment that is allowed to say 请跑 `x`). Not
   tool-description-only; no attention badge as the waiting signal.
6. `"$WD_RUN" wait --id …` — blocks like a normal shell task until `x`
   finishes; stderr ends with `agent-run: done id=… status=… [exit=…]`.
7. **Session③ result** + agent-owned follow-up.

`propose.sh` still defaults to `--wait` for hosts that cannot split tool
calls; that path cannot insert session② between write and block and is
race-prone — skill marks it as fallback only.

**Handoff body = non-blocking kickoff.** Trigger/async ack only; exit quickly.
Do not `gh run watch` / health-poll / rollout-wait inside `x`. After wait
returns, the agent polls CI and handles the rest with tools.

Profile rules: `agent-profiles/v1/en/reporting.md` `[reporting-50]`…`[reporting-55]`.

## Human / CLI path

On PATH via `wezdeck-env.env` (`scripts/runtime/cli/`).

```bash
# Prepared by agent (or manually) — --cwd and a readable --summary are required
wd-run propose --cwd /abs/or/resolvable/dir --actor grok --summary 'fix dns' --stdin <<'EOF'
echo hello
pwd
EOF
# stderr: agent-run: ready  (id/status/actor/cwd/summary — same shape as x peek header)
# stdout: id=<id>

# Human (after agent session② says ready)
x              # peek HEAD → Enter=run / other=cancel → CAS run in recorded cwd
x -            # peek only
x --id <id>    # run without pager (still CAS against HEAD)

# Agent after session②
wd-run wait --id <id>   # stderr ends: agent-run: done id=… status=… [exit=…]

wd-run log --lines 40
wd-run ls --status pending
wd-run cancel
wd-run gc
```

Empty HEAD: `x` explains there is no pending handoff and tells the human to
wait for the agent’s「脚本已就绪」line if prepare is still in flight.

Discovery for agents: `$HOME/.wezterm-x/agent-tools.env` key `wd_run`
(absolute path to `cli/wd-run`), written by `sync-runtime.sh`.

Shell `x` is unrelated to WezTerm **`Alt+x`** (overflow tab picker).

## Working directory

- `propose` **requires** `--cwd`. Relative paths are resolved to an
  absolute canonical path; the directory must exist at propose time.
- The entry stores `session.cwd` immutably.
- `run` / `x` always `cd` into that cwd before executing. If the
  directory is gone, the run fails closed (does not fall back to `$PWD`).

## Storage

```text
~/.local/state/wezterm-runtime/
  state/agent-run/HEAD.json
  state/agent-run/entries/<id>.json
  logs/agent-run.jsonl[.1…]
```

Constants: `WSL_AGENT_RUN_*` in
`scripts/runtime/wsl-runtime-paths-lib.sh`.

`runtime.log` category `agent_run` is diagnostic only; **audit truth**
is `agent-run.jsonl`.

## Concurrency

Single-slot **HEAD** + immutable entry body + **CAS** on run:

1. `propose` writes `entries/<id>.json`, then under flock points HEAD at
   `id` (previous pending HEAD → `superseded`).
2. `x` binds the id at peek time; confirm runs **that** id.
3. If HEAD moved, or status ≠ `pending`, run exits `2` (superseded) or
   `3` (busy) — never silently executes a newer script.

## Retention (anti-growth)

Same spirit as `runtime.log` rotation:

| Knob | Default | Effect |
| --- | --- | --- |
| `AGENT_RUN_ENTRY_KEEP` | `50` | Max entry JSON files; GC after each propose (and `wd-run gc`). Never deletes HEAD or `status=running`. |
| `AGENT_RUN_AUDIT_ROTATE_BYTES` | `5242880` (5 MiB) | Rotate `agent-run.jsonl` → `.1` … |
| `AGENT_RUN_AUDIT_ROTATE_COUNT` | `5` | Rotated audit generations kept |

## Install

```bash
# skill discovery (Claude / Codex / OpenClaw / ~/.agents)
./scripts/dev/link-platform-skills.sh

# CLI on PATH (once per machine)
cp wezterm-x/local.example/shell-env.d/wezdeck-env.env ~/.config/shell-env.d/
# then open a new shell — wd-run and x resolve via WEZDECK_REPO/scripts/runtime/cli

# agent-tools.env wd_run=… (after sync)
skills/wezdeck-runtime-ops/scripts/sync-runtime.sh   # or your usual sync
```
