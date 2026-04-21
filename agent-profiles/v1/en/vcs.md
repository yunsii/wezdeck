# VCS

## When To Read

When committing, branching, merging, rebasing, opening a pull/merge request, or making any other change to version-control state.

## When Not To Read

When the change is purely local edits and is not yet ready to enter version control.

## Default

Treat version-control state as user-owned history.
Do not modify shared or published state without explicit instruction.

## Hard Defaults

- Never auto-commit. Commit only when the user asks.
- Never auto-push. Push only when the user asks.
- Never skip hooks (`--no-verify`, `--no-gpg-sign`, etc.) unless the user explicitly authorizes it.
- Never force-push to a protected or main branch. Warn the user if they request it.
- Prefer creating a new commit over amending a previously published commit.
- Stage specific files by name. Avoid `git add -A` / `git add .` because they may include secrets, generated files, or unrelated changes.

## Commit Granularity

- One commit, one coherent change.
- Separate refactor from behavior change when practical.
- If a task contains both, land the refactor first and the behavior change second.

## Commit Messages

- Match the existing project style; read recent log before composing.
- Use the body to explain *why* when the *what* alone is not enough.
- Do not invent a convention if the project has none. Keep it short and descriptive.

## Conflicts And Recovery

- Investigate before destructive operations (`git reset --hard`, `git checkout --`, `git clean -f`, branch deletion).
- Resolve merge conflicts. Do not discard the conflicting side as a shortcut.
- Lock files, unfamiliar branches, or untracked files may represent the user's in-progress work. Verify before deleting.

## Pull / Merge Requests

- Create one only when the user asks.
- Keep the title short. Put details in the body.
- Summarize the full diff since divergence from the base branch, not only the latest commit.

## Concurrency

- Do not run git commands that contend on the index lock in parallel.

## Reporting

After any commit, push, or PR action, report:

- the action taken
- the visible side effect (commit SHA, branch state, PR URL)
- whether anything still needs the user's confirmation
