# Compatibility And Migration Policy

Use this document when changing a repository-owned configuration shape, skill
name, runtime script entry point, generated artifact contract, or other local
operator interface.

## Default

WezDeck is a personal control plane whose repository is the source of truth.
For repository-owned interfaces, make the new version authoritative in one
change. Do not keep the old path, old key, old command spelling, or a second
parser only to make an in-repo migration feel gradual.

This applies to:

- `skills/` names and skill-owned command paths;
- `wezterm-x/` configuration keys, generated files, and local templates;
- `scripts/runtime/` and `scripts/dev/` command interfaces;
- internal environment variables and runtime metadata owned by this repo;
- documentation and agent-facing instructions that point at those interfaces.

## Migration Signals

When an old form may still exist on a user's machine, guide the migration at
the boundary where it is detected:

1. Detect the old form explicitly.
2. Emit a structured warning or error with the old value, the replacement, and
   the exact repair command or file to edit.
3. Fail or continue according to the risk of the operation. A missing required
   runtime must fail before publication; an optional preference may warn and
   fall back to a documented default.
4. Record the outcome in the existing runtime log category and update the
   operator documentation in the same change.
5. Remove the old branch once repository-owned callers and docs are updated.

A warning is a migration guide, not a compatibility implementation. A
warning-only detector may remain briefly at the boundary, but the old value
must not affect behavior and the old detector should have a clear removal
follow-up. Do not silently translate old names forever.

## When Compatibility Is Allowed

Keep a compatibility reader or alias only when at least one of these is true:

- the input is an external protocol or service contract that WezDeck does not
  control;
- the data is persisted on disk and cannot be atomically rewritten before the
  next read;
- another repository or released binary must interoperate during a stated
  rollout window;
- a destructive or irreversible upgrade needs a recovery reader.

An allowed compatibility layer must document its owner, accepted old form,
warning signal, removal condition, and expiry or follow-up issue. Prefer a
one-time data migration over a permanent dual-format reader. Keep compatibility
at the boundary; do not spread legacy branches through core logic.

## Agent Procedure

When an agent finds an old repository-owned form:

1. Search the repository for all producers, consumers, docs, tests, generated
   files, and permission allowlists.
2. Decide whether the form is repository-owned or an external contract.
3. For repository-owned forms, update all callers in the same change, remove
   the old path, and add a direct check for the new form.
4. Add a warning or diagnostic only where a stale user-local installation can
   be observed; do not add a permanent old-path wrapper just to print it.
5. Run the narrow check, the relevant runtime check, and repo hygiene. Report
   the migration signal and any remaining stale local state.

## Recent Application

The `wezterm-runtime-sync` skill was renamed to `wezdeck-runtime-ops` when its
scope expanded from configuration copying to environment, agent, Lua, Node,
and dependency checks. The old skill directory was removed, all repository
references were updated, and the new check entry point reports migration
warnings such as nvm still supplying Node. No old skill alias is retained.

The canonical warning-only migration example is commit
`f6844fec6a935cf0021c041deabb491a7a29ea6e` (`feat(ui): share repository
display aliases`). It moved the source of truth from the tmux-only
`TMUX_STATUS_REPO_ALIAS` / `@tmux_status_repo_alias` to shared
`WEZTERM_REPO_ALIASES`, removed the old tmux option, updated the Lua and shell
consumers plus tests, and only warned when a retired variable was still set.
The retired value never remained behaviorally active. Follow this pattern for
future repository-owned migrations.
