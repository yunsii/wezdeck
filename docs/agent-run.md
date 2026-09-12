# Agent Run Handoff (`human-run` + `wd-run` / `x`)

Three layers — do not collapse them:

| Layer | Role |
| --- | --- |
| **User-level profile** (`agent-profiles` → `reporting.md`) | Doctrine: when human must run something, skill is **mandatory**; no chat paste channel; agent self-exec stays on tools |
| **Platform skill** `human-run` | Procedure agents load: resolve `wd-run`, `propose --cwd`, tell human `x` |
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

## Agent path (mandatory)

1. Load skill `human-run`.
2. Run `"$TOOL_HOME/ensure-env.sh"` (check + init; idempotent).
3. Tell the human to run `x` (one line).
4. `"$TOOL_HOME/propose.sh" --cwd …` — **defaults to `--wait`** so the tool
   call blocks like a normal shell task until `x` finishes; then continue.
   Prefer host background execution for long waits. No attention badge.
5. Or split: `propose.sh --no-wait` + `wd-run wait --id …`.

Profile rules: `agent-profiles/v1/en/reporting.md` `[reporting-50]`…`[reporting-54]`.

## Human / CLI path

On PATH via `wezterm-env.env` (`scripts/runtime/cli/`).

```bash
# Prepared by agent (or manually) — --cwd is required
wd-run propose --cwd /abs/or/resolvable/dir --actor grok --summary 'fix dns' --stdin <<'EOF'
echo hello
pwd
EOF

# Human
x              # peek HEAD → [y/N] → CAS run in recorded cwd
x -            # peek only
x --id <id>    # run without pager (still CAS against HEAD)

wd-run log --lines 40
wd-run ls --status pending
wd-run cancel
wd-run gc
```

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
cp wezterm-x/local.example/shell-env.d/wezterm-env.env ~/.config/shell-env.d/
# then open a new shell — wd-run and x resolve via WEZTERM_REPO/scripts/runtime/cli

# agent-tools.env wd_run=… (after sync)
skills/wezterm-runtime-sync/scripts/sync-runtime.sh   # or your usual sync
```
