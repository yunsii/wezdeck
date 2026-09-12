---
name: cross-repo-delegate
description: >
  Cross-repo work tickets (platform skill). Use when the user wants to file a
  ticket from one project to another (提单 / 跨仓委托 / 开给别的仓库的单), or in
  the receiving project to list inbox, claim, challenge assumptions, reply, or
  close (有没有我的单 / 认领 / 关单). Agent loads this skill and runs the
  co-located runner; humans only state intent. Target repos come from the local
  allowlist config, not from this description.
---

# Cross-repo delegate (work tickets)

**Who runs:** the coding agent (Host TUI / OpenClaw), **not** the human.  
**Never** tell the user to copy-paste `run.sh` as the primary path.

Single source: this directory (`SKILL.md` + `run.sh` + `test.sh`). Other paths
are symlinks from `scripts/dev/link-platform-skills.sh`.

Skill id: **`cross-repo-delegate`**. Short CLI on PATH (optional): **`delegate`**.

## When to load / run

| User intent (examples) | You do |
| --- | --- |
| 跨仓委托；给**另一个**项目/仓库提单；消费方要平台侧改 | `create`（`--to` / `--from` 用 allowlist 里的 key 或 `.`） |
| 有没有我的单；看 inbox；认领这张单 | `inbox` → `claim` → `show` |
| 假设不对；需要对方决策 | `challenge` |
| 答复挑战；关单；写方案路径 | `reply` / `close` |

Concrete repo names live only in `~/.agent/tickets/config.yml` (and the user’s words), not in this skill’s trigger text.

**Skip / redirect:** long exploratory design → interactive TUI / OpenClaw C2 handoff, not a ticket loop.

**Auto-dispatch:** after create, or later:

```bash
"$D" create … --run [--backend claude|codex|grok]
# = research; if verdict=accept → implement immediately
# if challenge/need_input → stops for initiator

"$D" run --id <id> --phase auto|research|implement
"$D" reply --id <id> --decision "…" --continue   # after challenge
"$D" watch --id <id> [--once] [--interval 20]    # blocked initiator loop
```

Policy: **no objection after research → start implement**; **objection → human `reply` then continue**. Filing a ticket means the initiator is blocked — prefer `watch` so work resumes when the ball returns. Use `--mock` offline.

Headless workers set `AGENT_ATTENTION_SKIP=1` and (Claude) `disableAllHooks` so they **must not** appear in the human attention badge / `Alt+/` list.

## Resolve TOOL_HOME (first hit wins)

```text
1. $CROSS_REPO_DELEGATE_HOME or $DELEGATE_HOME
2. directory of this SKILL.md if run.sh is co-located
3. $HOME/.agents/skills/cross-repo-delegate   # usual after link
4. $WEZDECK_ROOT/scripts/dev/cross-repo-delegate
5. $HOME/github/wezterm-config/scripts/dev/cross-repo-delegate
```

```bash
TOOL_HOME=…   # dir that contains run.sh
D="$TOOL_HOME/run.sh"
# If `delegate` is on PATH (install-cli), you may use it; otherwise always $D.
```

**Never** assume the skill lives only under the TARGET repo (TOOL ≠ TARGET).

## One-time (only if missing)

```bash
"$D" init
# optional PATH: "$D" install-cli   # installs short name `delegate`
```

If `~/.agent/tickets/config.yml` lacks the target, add it (path + aliases) before create.

## Agent procedure

### A) File a ticket (initiator project cwd)

1. Resolve TOOL_HOME; confirm `"$D"` is executable.
2. Infer `--to <allowlist_key>` from the user; use `--from .` when cwd is the source project (or an explicit source key).
3. Write **observed** + **assumed** from the user’s finding (required).
4. Run:

```bash
"$D" create \
  --to <target_key> \
  --from . \
  --title "<short>" \
  --observed "<what you saw>" \
  --assumed "<what target should guarantee>" \
  [--snippet-ref "path:line"] \
  [--summary "…"] [--source-pr "#…"]
```

5. Report the printed `id` to the user. Do **not** commit the ticket into any git tree.

### B) Inbox / claim (receiving project cwd)

```bash
"$D" inbox --to .
"$D" next --to .
"$D" claim --id <id>
"$D" show --id <id>
```

Read the **full** ticket before editing code. If claim returns lease held → stop; do not dual-write.

### C) Challenge (target) → reply (initiator)

```bash
"$D" challenge --id <id> \
  --measured "…" --impact "…" --recommended "…" [--needs "…"]
# initiator side:
"$D" reply --id <id> --decision "…" --status waiting_target
```

### D) Close

```bash
"$D" close --id <id> --doc <topic-doc-in-target-repo>
# or explicit skip:
"$D" close --id <id> --no-doc "<reason>"
```

Update/create the **topic solution doc** in the target repo yourself; never commit `~/.agent/tickets/**` into the project.

## Status (authoritative)

`submitted` · `in_progress` · `waiting_initiator` · `waiting_target` · `shipped` · `closed` · `rejected` · `failed`  

`owner`: `worker` | `initiator` | `human`

Use `"$D" next --id <id>` when unsure whose turn it is.

## Don't

- Don’t ask the human to run CLI as the main path
- Don’t commit tickets into project git / `docs/decisions/`
- Don’t invent a second OpenClaw-only ticket store — same skill
- Don’t skip `--observed` / `--assumed` on create
- Don’t close without `--doc` or `--no-doc`
- Don’t start a second claim while a lease is active

## Tests (operators / CI — not the user path)

```bash
"$TOOL_HOME/test.sh"    # isolated MOCK fs; no LLM; no ~/.agent pollution
```

## Related

- Runner: `run.sh` · lib: `lib/` · offline: `test.sh`
- Link: `scripts/dev/link-platform-skills.sh`
- Sibling: `adversarial-review`, `brainstorm`
