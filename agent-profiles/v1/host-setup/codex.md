# Codex CLI Setup Notes

Operator-facing setup notes for `~/.codex/config.toml`. Codex's permission
model is sandbox + approval policy, not a Claude-style allowlist — these
are knobs you tune once, not patterns an agent proposes per call.

This file is a checklist, not a normative profile. The agent-facing rules
in [../en/permissions.md](../en/permissions.md) are host-agnostic and
apply equally to a Codex session, but Codex itself does not consume the
rules in [../en/permissions-claude.md](../en/permissions-claude.md).

## Tuning Knobs (Ranked By ROI)

### 1. `approval_policy` × `sandbox_mode` default

The biggest lever. Keep the normal personal default on Codex Auto: commands
inside the workspace run under the sandbox without per-command prompts, and
eligible boundary requests go through Codex's automatic reviewer:

```toml
# Personal default — Codex Auto with automatic boundary review.
approval_policy    = "on-request"
approvals_reviewer = "auto_review"
sandbox_mode       = "workspace-write"
```

Codex profiles are overlays: `~/.codex/config.toml` remains the single base
configuration, while `~/.codex/auto.config.toml` and
`~/.codex/full-access.config.toml` override only permission fields. Model,
provider, hooks, MCP, project trust, and other base settings are inherited;
there is no second full copy to drift out of sync. This is the native
`codex --profile <name>` behavior in CLI 0.156.1.

Codex CLI 0.156.1 exposes `on-request` and `never`; the older `on-failure`
value is not a valid replacement for Auto mode. With `on-request`, commands
already allowed by `workspace-write` run without a user prompt.

```toml
# Optional manual-review profile — use when you want user approval.
approval_policy    = "on-request"
approvals_reviewer = "user"
sandbox_mode       = "workspace-write"
```

The second bundle can live in `~/.codex/manual-review.config.toml` when you
want explicit user approval. A new interactive session must be started after
changing `~/.codex/config.toml`; existing sessions keep the policy they
started with.

When the automatic reviewer is unavailable or returns an unsupported-model
error, switch the session to the tracked `full-access` profile. Link both
overlays once so future repository updates stay synchronized:

```bash
scripts/dev/link-codex-permission-profiles.sh
codex --profile full-access
```

Full access is the configuration equivalent of
`codex --dangerously-bypass-approvals-and-sandbox` (also called `--yolo`). It
removes both filesystem and network boundaries, so keep it as an explicit
personal-workstation escape hatch rather than the default.

Auto-review is a reviewer swap, not a permission grant. It is only active when
`approval_policy` remains interactive, and a reviewer failure can fail closed
before the requested command runs. When that happens, switch to `full-access`
for the current personal session instead of changing the default.

### 2. Named profiles for different work modes

Create `~/.codex/<name>.config.toml` as a thin overlay and switch with
`codex --profile <name>` instead of editing the main config per task.

```toml
# ~/.codex/research.config.toml
approval_policy = "never"
sandbox_mode    = "read-only"
[sandbox_workspace_write]
network_access = false
```

```toml
# ~/.codex/manual-review.config.toml
approval_policy    = "on-request"
approvals_reviewer = "user"
sandbox_mode       = "workspace-write"
[sandbox_workspace_write]
network_access = true
```

```toml
# ~/.codex/full-access.config.toml (tracked template)
approval_policy = "never"
sandbox_mode    = "danger-full-access"
```

`research` is for browsing-only sessions, `manual-review` is for explicit
approvals, and `full-access` is the explicit elevated session.

### 3. Approval reviewer model

`review_model` configures the model used by the `/review` code-review command;
it does not select the model used by `approvals_reviewer = "auto_review"`.
The auto-review model is selected from the active model catalog. A provider can
return `auto_review_model_override` metadata for its model; there is no stable
user-level `approval_model` key in `config.toml`. For a custom provider, an
unavailable `codex-auto-review` catalog entry can make auto-review fail closed.
Use Full access to bypass that path, or have the provider expose a review model
that the endpoint actually serves.

### 4. `writable_roots` for cross-fs work

This repo's runtime sync writes paths outside the WSL home (Windows-side
runtime, WezDeck Runtime state, machine cache). Without these in
`writable_roots`, every sync invocation re-prompts:

```toml
[sandbox_workspace_write]
writable_roots = [
  "~/.wezterm-x",
  "~/.cache/wezterm-runtime",
  "/mnt/c/Users/Yuns/AppData/Local/wezterm-runtime",
  "/mnt/c/Users/Yuns/.wezterm-x",
]
network_access = true
```

Adjust per machine — these paths are user-specific. Source of truth for
the runtime path layout is
[`scripts/runtime/windows-runtime-paths-lib.sh`](../../../scripts/runtime/windows-runtime-paths-lib.sh).

### 5. `[shell_environment_policy]` to limit token surface

Aligns with [../en/secrets.md](../en/secrets.md): keep secret-shaped
env vars out of agent context.

```toml
[shell_environment_policy]
inherit = "core"
exclude = [
  "*_TOKEN", "*_KEY", "*_SECRET",
  "GH_TOKEN", "GITHUB_TOKEN",
  "ANTHROPIC_*", "OPENAI_API_KEY",
]
```

`inherit = "core"` means only PATH / HOME / USER / etc. flow through;
anything else must be explicitly whitelisted via `set` or `include`.

### 6. Browser / MCP parity with other host agents

**Chrome DevTools is not a Codex resident MCP.** Match Claude: drive the
WezDeck CDP Chrome (`http://127.0.0.1:9222`) through the shared uxc skill
`chrome-devtools-mcp-skill` and the pre-seeded link `chrome-devtools-mcp-cli`
(absolute `node` + pinned global package + `--usageStatistics=false`,
idle-reaped). Do **not** put `npx chrome-devtools-mcp@latest` (or a bare
global binary) under `[mcp_servers.chrome-devtools]` — that reintroduces
per-session resident Node + the npm launcher tax documented in
[`docs/guest-oom.md`](../../../docs/guest-oom.md).

Wire discovery once (same pool Claude already uses):

```bash
mkdir -p ~/.codex/skills
ln -sfn ~/.agents/skills/chrome-devtools-mcp-skill ~/.codex/skills/chrome-devtools-mcp-skill
ln -sfn ~/.agents/skills/uxc ~/.codex/skills/uxc
command -v chrome-devtools-mcp-cli   # must already exist; recreate via guest-oom recipe if missing
```

OpenClaw's gateway keeps a **separate** resident `mcp.servers.chrome-devtools`
on purpose (one gateway-level instance). Host Codex / Claude / Grok share
the Chrome on 9222, not that MCP runtime.

Other MCP servers (deepwiki / context7 / HTTP docs) can still live under
`[mcp_servers.*]` when they are not memory-hot the way chrome-devtools is:

```toml
[mcp_servers.deepwiki]
command = "deepwiki-mcp-cli"
args    = ["serve"]
```

### 7. `notify` hook → desktop / Feishu

Pipe approval-request events to the same notification path the rest of
this repo uses (`scripts/runtime/agent-clipboard.sh`,
`feishu-notify` skill, etc.). Keeps cross-host signal consistent.

```toml
notify = ["bash", "/home/yuns/github/wezterm-config/scripts/codex-hooks/notify.sh"]
```

The notify script does not exist yet — write it when this knob is
actually wanted.

### 8. `~/.codex/prompts/` for saved prompts

Filesystem-backed equivalent of slash commands. Drop a `.md` per prompt;
recall in a session via Codex's `/` menu. Common candidates from this
repo: "sync runtime", "reload tmux", "render hotkey report".

### 9. Removed top-level settings

Do not add these legacy top-level keys to current Codex config files:
`disable_response_storage`, `network_access`, and
`windows_wsl_setup_acknowledged`. Codex CLI 0.156.1 reports each as an
unrecognized startup setting. Configure `network_access` under the relevant
`[sandbox_workspace_write]` table instead, as shown above. The other
two settings have no current config key; omit them rather than suppressing
the warning.

## What This File Is Not

- **Not** a Codex-side equivalent of `permissions-claude.md`. Codex has
  no per-pattern allowlist, so there is no agent-facing "decide whether
  to promote a pattern" loop to specify.
- **Not** automatically loaded by any agent. This is operator
  documentation for setting up `~/.codex/config.toml` once.
- **Not** machine-portable verbatim — `writable_roots` and
  `notify` paths are user-specific.

## Verification

After editing `~/.codex/config.toml`:

```bash
codex --strict-config doctor                    # validates the active config
codex --profile auto --strict-config doctor     # validates the Auto overlay
codex --profile research --strict-config doctor  # validates a named profile
codex --profile full-access --strict-config doctor
```

If a profile fails to load, Codex usually surfaces the parse error
inline rather than silently falling back.
