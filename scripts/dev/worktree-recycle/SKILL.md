---
name: worktree-recycle
description: >
  Reset a long-lived linked dev-* workstation onto origin/HEAD after the round
  is delivered: soft preflight (beyond git), call worktree-task recycle, then
  project-specific post-init. Use when the user says 重置开发分支 / 重置工作站 /
  recycle this worktree / 收尾换下一轮, optionally with a next-task brief.
---

# Worktree recycle (platform skill — single source)

**Who runs:** the coding agent, **not** the human.  
**Never** tell the user to copy-paste `worktree-task recycle` as the primary path — load this skill and run the co-located runner.

Hard git ops stay in **`worktree-task recycle`** (delivered gate including squash content-absorption, allowlisted clean, `reset --hard origin/HEAD`, sync `origin/<branch>` to the same tip).  
This skill owns what the script cannot: **richer preflight**, **human-readable blockers**, and telling the agent what “ready for the next round” still needs after git is clean.

## When to load / run

| User intent (examples) | You do |
| --- | --- |
| 重置开发分支 / 重置工作站 / recycle / 收尾换下一轮 | `preflight` → if only soft warnings or squash false-positive risk is gone, `recycle -y` → `init` |
| 重置并开始做 X / recycle with task X | same, pass `--task "X"` |
| 只要看看能不能重置 | `preflight` or `recycle --dry-run` only |

**Skip / redirect:**

- Short-lived `task-*` / `hotfix-*` end-of-life → **`worktree-task reclaim`** / `Ctrl+k g r` (not this skill)
- Primary worktree / mainline-only checkout with no linked `dev-*` → refuse; do not invent a slug
- Pure `git reset` without delivery checks → do not bypass this skill

## Resolve TOOL_HOME (first hit wins)

```text
1. $WORKTREE_RECYCLE_HOME
2. directory of this SKILL.md if run.sh is co-located
3. $HOME/.agents/skills/worktree-recycle
4. $WEZDECK_ROOT/scripts/dev/worktree-recycle
5. $HOME/github/wezterm-config/scripts/dev/worktree-recycle
```

```bash
TOOL_HOME=…   # dir that contains run.sh
R="$TOOL_HOME/run.sh"
```

Install / refresh discovery (idempotent, from wezdeck):

```bash
./scripts/dev/link-platform-skills.sh
```

## Who runs what

| Layer | Duty |
| --- | --- |
| **Skill + `run.sh`** | Soft preflight report, orchestrate recycle, print readiness hints |
| **`worktree-task recycle`** | Dirty/delivered hard gates, temp-branch prune, debug-file allowlist, `reset --hard`, remote sync |
| **Agent (you)** | After git is clean, **re-initialize the project yourself** for whatever stack this repo uses — do not ask the human to run bootstrap |
| **Human** | Intent; confirm only when preflight shows **real** blockers (unique undelivered content, dirty outside allowlist) |

## Agent procedure

1. **Resolve** TOOL_HOME; confirm `"$R"` is executable. Cwd should be the linked `dev-*` worktree (or pass `--cwd`).
2. **Preflight** (always first):
   ```bash
   "$R" preflight --cwd "$PWD"
   ```
   Read the report. Soft signals (attention waiting, open `.delegate/`) are warnings — explain in Chinese only if they matter. Unique undelivered content / dirty outside allowlist are real blockers.
3. If the user already named the next task, keep it for `--task`.
4. **When the user already said 重置 / recycle:** do **not** ask again about squash vs push vs manual reset. Squash merges are content-checked automatically; remote sync is the default end state. Proceed:
   ```bash
   "$R" recycle --cwd "$PWD" -y [--task "…"] [--fresh-agent] [--dry-run]
   ```
   Prefer `-y` after a clean preflight or when the user explicitly overrode a real blocker. Do **not** invent a second “先 push 旧 tip / 不推手动 reset” fork.
5. **Init report** (always after a successful non-dry recycle — `run.sh recycle` already chains this; call only if you invoked `worktree-task` directly):
   ```bash
   "$R" init --cwd "$PWD"
   ```
   Treat the printed recipe / suggestions as hints only. **You** then bring the tree to a workable state for *this* repo (deps, codegen, caches, services — whatever the project actually needs). Stay stack-agnostic: Node may be `pnpm install`, Rust `cargo fetch`, Go `go mod download`, or a project `make bootstrap` — infer from the tree; do not hard-code one ecosystem, and do not invent a per-repo hook just to run install. Open/read `.task-brief.md` if present and start the next round from that brief.
6. **Report** briefly: delivery basis (SHA merged / content absorbed / pushed), new HEAD, remote sync result, pruned/cleaned summary, what you ran to re-init (if anything), next step (including `/clear` when `--fresh-agent`).

## Preflight covers (skill layer)

| Check | Hard / soft | Notes |
| --- | --- | --- |
| Linked `dev-*` (not primary / not task-*) | hard via CLI | Script refuses otherwise |
| Dirty outside recycle allowlist | hard | Fix or explicit `--force` from user |
| Delivered (`origin/HEAD` ancestor, **content absorbed**, or pushed remote contains HEAD) | hard | Squash/rebase: content check, no human quiz |
| `.delegate/` leftovers | soft→clean | Allowlisted clean; warn if looks like an active ticket |
| Attention `waiting` on this pane | soft warn | Do not treat attention `done` as merge proof |
| Next-task text from user | passthrough | Becomes `--task` / `.task-brief.md` |

## Desired end state

After a successful recycle + agent re-init:

- Local `dev/*` tip == `origin/HEAD` (default branch tip)
- `origin/<same branch>` tip == that same commit (unless `--no-sync-remote`)
- Upstream is `origin/<branch>` (never the default branch)
- The workstation is actually usable for the next round (agent restored whatever this repo needs — not “git clean but deps broken”)

## Project init (after recycle)

Git reset is universal; **project bootstrap is not**. Keep that split:

1. `run.sh init` may print a builtin recipe / suggestions (wezdeck skips `sync-runtime`; generic may list detected lockfiles). Suggestions are **not** executed by the skill.
2. Optional escape hatches only when a repo truly needs non-obvious automation: executable `.worktree-recycle/post-recycle.sh`, or `WT_RECYCLE_POST_HOOK`. Do **not** add a hook just to run a one-line package-manager install — the agent should do that.
3. **Default path:** after recycle, the agent inspects the tree and re-initializes appropriately for that stack. No Node/Rust/Go special-case in the skill runner.

## Don't

- Don't ask the human to run CLI as the main path
- Don't re-ask squash / push / manual-reset questions after the user already said 重置开发分支
- Don't use recycle for short-lived `task-*` / `hotfix-*` (use reclaim)
- Don't `--force` away dirty trees without an explicit user override
- Don't treat attention / ledger / delegate `shipped` as proof of merge
- Don't run `sync-runtime` just because recycle finished
- Don't auto-install a single ecosystem inside the skill runner “for convenience” — that breaks generality; instruct the agent instead
- Don't leave the human to bootstrap after recycle; the agent re-inits
- Don't delete Claude transcripts; use `--fresh-agent` + `/clear` when a blank session is wanted
- Don't maintain a second SKILL.md body outside this directory (link only)

## Related

- Runner: `run.sh`, `lib/preflight.sh`, `lib/init.sh`
- Hard ops: `scripts/runtime/worktree/worktree-task recycle`
- Docs: `docs/workspaces.md` (Recycle), `docs/daily-workflow.md` (closing a round)
- Link: `scripts/dev/link-platform-skills.sh`
- Offline: `"$TOOL_HOME/test.sh"`
