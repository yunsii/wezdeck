---
name: wezterm-runtime-sync
description: Synchronize this repository's WezTerm runtime. Reuse a valid cached target from repo-root `.sync-target` or `WEZTERM_SYNC_TARGET` when available; otherwise list candidate homes, confirm one with the user, and run the skill-owned sync script.
---

# Wezterm Runtime Sync

Use this skill when the task is to sync runtime files. Reuse a valid cached target when available; otherwise confirm the target home before writing anything.

The scripts under `skills/wezterm-runtime-sync/scripts/` are the source of truth for sync prompting, target discovery, and prompt-format regression checks.

## Workflow

1. Run from the repository root, or set `WEZTERM_CONFIG_REPO=/absolute/path/to/repo` before invoking the skill scripts.
2. If repo-root `.sync-target` or `WEZTERM_SYNC_TARGET` already points at an existing directory, run `skills/wezterm-runtime-sync/scripts/sync-runtime.sh` with no extra arguments.
3. If there is no valid cached target, run `skills/wezterm-runtime-sync/scripts/sync-runtime.sh --list-targets` to print candidate user home directories.
4. Present the candidates to the user and ask which path should be used. Accept either one of the listed paths or another absolute path the user explicitly provides.
5. After the user confirms a target, run `skills/wezterm-runtime-sync/scripts/sync-runtime.sh --target-home /absolute/path`.
6. Summarize the sync result and mention the chosen target path.

## Rules

- Do not ask the user to type into the script's interactive prompt.
- If a valid cached target exists and the user did not ask to change it, sync immediately with no extra confirmation step.
- If the cache is missing, invalid, or the user wants to change targets, use the explicit list-and-confirm flow above.
- Prefer `--target-home` over `WEZTERM_SYNC_TARGET` when the user has explicitly confirmed a path, because `--target-home` also refreshes `.sync-target`.
- If the requested target is outside the writable sandbox and the sync command fails with a filesystem permission error, rerun it with escalated permissions.
- If `--list-targets` prints no directories, report that clearly instead of guessing a target.
- If the user names a path directly, validate that it is absolute and exists before running the sync.
- Treat repo-root `.sync-target` as the cache for the chosen runtime home.
- Remember that gitignored files under `wezterm-x/local/` are still copied because sync reads the repository working tree, not just tracked files.
- Sync also copies `config/worktree-task.env` to `<runtime_dir>/repo-worktree-task.env` so the Windows-side wezterm.exe can read it (`io.open` on a `/home/...` WSL path returns nil from Windows). `wezterm-x/lua/constants.lua` reads that local copy first; without it, the `<base>_resume` profile defined only in the env file is missing on the Windows leg and workspace open silently falls back to the bare profile.
- The `lua-precheck` step (between `publish-runtime` and `helper-install`) dofile-loads the synced `lua/constants.lua` under a mocked `wezterm` and asserts `default_resume_profile ≠ default_profile` plus a `--continue` / `resume` literal in the resume command. Requires `lua5.4` (or `lua5.3`/`lua`); skips with a warning when none is installed.

## Commands

Sync using the cached target:

```bash
skills/wezterm-runtime-sync/scripts/sync-runtime.sh
```

List candidate homes:

```bash
skills/wezterm-runtime-sync/scripts/sync-runtime.sh --list-targets
```

Sync to a confirmed target:

```bash
skills/wezterm-runtime-sync/scripts/sync-runtime.sh --target-home /absolute/path
```

Prompt-format regression test:

```bash
skills/wezterm-runtime-sync/scripts/test-sync-prompt.sh tty en
skills/wezterm-runtime-sync/scripts/test-sync-prompt.sh non-tty zh
```
