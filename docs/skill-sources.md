# External Capability Source And Injection Contract

Use this document when adding, moving, installing, or debugging any capability
whose source is in this repository but whose entry point runs outside the
checkout: skills, agent profiles, permission overlays, CLI wrappers, hooks, or
zsh/bash functions.

## One Source Anchor

`WEZDECK_REPO` is the absolute path to the WezDeck checkout that owns the
capability under development. Every externalized capability must use it to
find repository resources or write absolute paths derived from it. It is a
source anchor, not a copy location and not a second configuration store.

The resolution order for a platform skill is:

1. Validate `WEZDECK_REPO` when it is set.
2. Otherwise resolve the physical skill source with `readlink -f` and walk to
   the repository root.
3. Fail with the expected path and repair command when neither source is valid.

Do not derive the repository root from the logical path under
`~/.agents/skills` or `~/.claude/skills`. Those paths are installation links and
may point into a different home directory.

`${WEZDECK_REPO}` inside `config/worktree-task.env` is a separate runtime
placeholder contract. New external capabilities must use `WEZDECK_REPO` as
their source-discovery input; do not invent another root variable.

## Skill Classes

### Platform skills

Source lives under `skills/<name>/`. The directory contains the skill
body, runner, and any private helpers required by that skill. The registry in
`skills/manifest.tsv` marks its class and link targets; the installer
`scripts/dev/link-platform-skills.sh` links platform rows to:

- `~/.agents/skills/<name>`;
- `~/.claude/skills/<name>` when Claude is installed;
- `openclaw/workspace/skills/<name>`;
- the OpenClaw workspace discovery link when the manifest enables it.

Use this class when the capability should be callable as a user-level skill
across repositories. The manifest is the only place that decides which
platform skills are exported.

### Repo-local skills

Source lives as a real directory under `skills/<name>/`. Its `repo-local`
manifest row means it is invoked by an
absolute repository path or by the project routing docs and is not linked into
user-level skill directories. Use this class when the skill depends on this
checkout's runtime, generated files, or private project layout. `wezdeck-runtime-ops`
is repo-local.

### Agent profiles and permission overlays

`agent-profiles/` contains versioned profile source, not project skills. Its
linker targets `~/.claude/` and `~/.codex/`; it must not be added to the
platform skill registry. The linker must derive its source from the checkout
root, and every symlink target must resolve back to that root. Codex permission
overlays and `agent-tools.env` are separate capability contracts with absolute
paths. A profile or overlay must not infer a source from the target directory.

### Shell injection and CLI wrappers

`wezterm-x/local.example/shell-env.d/` contains user-installed zsh/bash
functions and environment snippets. The repo-root env snippet sets
`WEZDECK_REPO` and derives all wrapper paths from it; functions such as the
Grok wrapper must call repository scripts by absolute path. CLI wrappers under
`scripts/runtime/cli/` follow the same root and are made reachable by `PATH`.
Do not add a new shell snippet that hard-codes a checkout path or resolves the
source through `~/.agents/skills`.

## Development Workflow

When developing an externalized capability:

1. Set `WEZDECK_REPO=/absolute/path/to/wezdeck` in the shell environment used
   by the agent and any user-level runner.
2. Run the relevant linker or install step to refresh the user-level artifact:
   `link-platform-skills.sh` for platform skills, `link-agent-profile.sh` or
   `link-codex-permission-profiles.sh` for profiles, and the shell-env snippet
   install for zsh/bash capabilities.
3. Invoke the external entry point and verify it resolves back to the declared
   checkout, not to the symlink or target directory.
4. Run the capability's narrow test and repo hygiene.

When moving a skill between classes, update the registry, links, routing docs,
and tests in one change. Remove the old installation path; do not keep a
compatibility copy. Emit a warning only for a stale user-local variable or
link, with the replacement path and repair command.

## Human-run Rule

`human-run` is a platform skill. Its scripts resolve their physical source
file before walking to the repository root, and `ensure-env.sh` prefers the
declared `WEZDECK_REPO`. This keeps `wd-run`, `x`, and `agent-run-lib.sh` from
splitting across different checkouts when the skill is launched through a
user-level symlink.
