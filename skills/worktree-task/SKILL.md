---
name: worktree-task
description: Create or reclaim a linked git task worktree under the primary worktree's `.worktrees/` folder, keep the cleaned-up task prompt under `.worktrees/.codex-prompts/`, and optionally launch it through a built-in or custom provider such as the tmux Codex provider.
---

# Worktree Task

Use this skill when the user wants either:

- a new implementation task to start in its own linked git worktree and Codex tmux window instead of continuing inside the current worktree
- an existing task worktree created by this skill to be reclaimed safely after the work is done

The skill-owned scripts are the source of truth for task naming, prompt-file placement, worktree creation, optional provider launch, and task reclaim.

## Launch Workflow

1. Summarize the user request into a compact task prompt that is ready to hand to a fresh Codex session.
2. Pick a short task title that can be slugified into a branch and worktree name.
3. Run the skill script from inside the target repository so it can create the linked worktree under the primary worktree's `.worktrees/` directory.
4. Let the selected provider open or prepare the new task target. The built-in `tmux-codex` provider reuses the current repo-family tmux session when possible.
5. Report the resulting branch name, worktree path, prompt file, and tmux session to the user.

Launch command:

Pipe the cleaned-up task prompt on stdin:

```bash
printf '%s' "$TASK_PROMPT" | bash {{skill_path}}/scripts/worktree-task launch --title "$TASK_TITLE"
```

Useful options:

- `--task-slug value`: override the generated slug prefix
- `--branch value`: force a branch name instead of the default `codex/<slug>`
- `--base-ref value`: create the branch from a specific ref instead of the primary worktree `HEAD`
- `--provider none|tmux-codex|custom:name|/absolute/path`: choose a built-in or external provider
- `--provider-mode off|auto|required`: disable runtime launch, allow provider fallback, or require provider success
- `--workspace value`: override the tmux session namespace used by the built-in tmux provider
- `--session-name value`: force the built-in tmux provider to use a specific session name
- `--variant light|dark|auto`: choose the managed Codex UI variant for the built-in tmux provider
- `--no-attach`: create/select the runtime target without switching the current client

## Reclaim Workflow

1. Identify the task worktree to reclaim. If you are already inside that linked worktree, the reclaim script can infer it automatically.
2. Confirm whether the task worktree has uncommitted changes. Do not discard them silently.
3. Run the reclaim script so it asks the selected provider to clean up runtime state for that worktree, removes the linked worktree, deletes the prompt archive, and deletes the branch only when that branch is already merged into the primary worktree `HEAD`.
4. Report what was removed and what was kept.

Reclaim command:

```bash
bash {{skill_path}}/scripts/worktree-task reclaim
```

Useful options:

- `--task-slug value`: reclaim `.worktrees/<slug>` from the current repo family
- `--worktree-root path`: reclaim a specific linked task worktree
- `--provider none|tmux-codex|custom:name|/absolute/path`: override the provider used for cleanup
- `--provider-mode off|auto|required`: disable runtime cleanup, allow fallback, or require provider success
- `--force`: allow reclaiming a dirty worktree and pass `-f` to `git worktree remove`
- `--keep-branch`: keep the task branch even if it is already merged
- `--keep-prompt`: keep the archived prompt file

## Rules

- Prefer running this skill from the existing managed tmux/Codex window for the target repo. That gives the script enough context to reuse the current repo-family tmux session directly.
- Keep the cleaned-up task prompt concise and action-oriented. Include acceptance criteria or constraints only when they materially affect the implementation.
- Do not ask the user to type into an interactive shell prompt. Pass the prompt through stdin or a prompt file.
- The script creates `.worktrees/` and `.worktrees/.codex-prompts/` under the primary worktree root, not under an arbitrary linked worktree.
- The skill is self-contained. Repo-specific behavior should come from tracked config such as `.codex/worktree-task.env`, not from hard-coded relative paths into the target repository.
- If the requested slug already exists, the script automatically appends a numeric suffix unless the user forced an explicit branch name.
- If you need a non-default branch base, pass `--base-ref` explicitly instead of assuming the current linked worktree branch is correct.
- Reclaim only skill-managed task worktrees under `.worktrees/`; do not silently remove the primary worktree or unrelated linked worktrees.
- By default reclaim refuses to remove a dirty worktree. Require `--force` before discarding local changes.
- Delete the task branch only when it is already merged into the primary worktree `HEAD`; otherwise keep it and report that clearly.
- Built-in providers currently include `none` and `tmux-codex`. External providers can be selected by absolute path or `custom:name` when discoverable through `WT_PROVIDER_SEARCH_PATHS`.

## Script

Unified entry point:

```bash
bash {{skill_path}}/scripts/worktree-task --help
```
