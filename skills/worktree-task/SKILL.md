---
name: worktree-task
description: Create or reclaim a linked git task worktree under the primary worktree's `.worktrees/` folder, keep the cleaned-up task prompt under `.worktrees/.codex-prompts/`, and reuse the current repo family's shared Codex tmux session when possible.
---

# Worktree Task

Use this skill when the user wants either:

- a new implementation task to start in its own linked git worktree and Codex tmux window instead of continuing inside the current worktree
- an existing task worktree created by this skill to be reclaimed safely after the work is done

The skill-owned scripts are the source of truth for task naming, prompt-file placement, worktree creation, tmux window launch, and task reclaim.

## Launch Workflow

1. Summarize the user request into a compact task prompt that is ready to hand to a fresh Codex session.
2. Pick a short task title that can be slugified into a branch and worktree name.
3. Run the skill script from inside the target repository so it can create the linked worktree under the primary worktree's `.worktrees/` directory.
4. Let the script open the new task window. When the current tmux session already belongs to that repo family, it reuses the existing shared session instead of creating another one.
5. Report the resulting branch name, worktree path, prompt file, and tmux session to the user.

Launch command:

Pipe the cleaned-up task prompt on stdin:

```bash
printf '%s' "$TASK_PROMPT" | skills/worktree-task/scripts/launch-worktree-task.sh --title "$TASK_TITLE"
```

Useful options:

- `--task-slug value`: override the generated slug prefix
- `--branch value`: force a branch name instead of the default `codex/<slug>`
- `--base-ref value`: create the branch from a specific ref instead of the primary worktree `HEAD`
- `--session-name value`: force the new task window into a specific tmux session for that repo family
- `--variant light|dark|auto`: choose the managed Codex UI variant for the new window
- `--no-attach`: create/select the tmux window without switching the current client

## Reclaim Workflow

1. Identify the task worktree to reclaim. If you are already inside that linked worktree, the reclaim script can infer it automatically.
2. Confirm whether the task worktree has uncommitted changes. Do not discard them silently.
3. Run the reclaim script so it closes tmux windows for that worktree, removes the linked worktree, deletes the prompt archive, and deletes the branch only when that branch is already merged into the primary worktree `HEAD`.
4. Report what was removed and what was kept.

Reclaim command:

```bash
skills/worktree-task/scripts/reclaim-worktree-task.sh
```

Useful options:

- `--task-slug value`: reclaim `.worktrees/<slug>` from the current repo family
- `--worktree-root path`: reclaim a specific linked task worktree
- `--force`: allow reclaiming a dirty worktree and pass `-f` to `git worktree remove`
- `--keep-branch`: keep the task branch even if it is already merged
- `--keep-prompt`: keep the archived prompt file

## Rules

- Prefer running this skill from the existing managed tmux/Codex window for the target repo. That gives the script enough context to reuse the current repo-family tmux session directly.
- Keep the cleaned-up task prompt concise and action-oriented. Include acceptance criteria or constraints only when they materially affect the implementation.
- Do not ask the user to type into an interactive shell prompt. Pass the prompt through stdin or a prompt file.
- The script creates `.worktrees/` and `.worktrees/.codex-prompts/` under the primary worktree root, not under an arbitrary linked worktree.
- If the requested slug already exists, the script automatically appends a numeric suffix unless the user forced an explicit branch name.
- If you need a non-default branch base, pass `--base-ref` explicitly instead of assuming the current linked worktree branch is correct.
- Reclaim only skill-managed task worktrees under `.worktrees/`; do not silently remove the primary worktree or unrelated linked worktrees.
- By default reclaim refuses to remove a dirty worktree. Require `--force` before discarding local changes.
- Delete the task branch only when it is already merged into the primary worktree `HEAD`; otherwise keep it and report that clearly.

## Script

Launch entry point:

```bash
skills/worktree-task/scripts/launch-worktree-task.sh --help
```

Reclaim entry point:

```bash
skills/worktree-task/scripts/reclaim-worktree-task.sh --help
```
