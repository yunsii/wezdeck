local wezterm = require 'wezterm'
local path_sep = package.config:sub(1, 1)

local function join_path(...)
  return table.concat({ ... }, path_sep)
end

local runtime_dir = rawget(_G, 'WEZTERM_RUNTIME_DIR')
if not runtime_dir or runtime_dir == '' then
  runtime_dir = join_path(wezterm.config_dir, '.wezterm-x')
end
local constants = dofile(join_path(runtime_dir, 'lua', 'constants.lua'))

local managed_launcher = nil
if constants.managed_cli then
  managed_launcher = constants.managed_cli.default_resume_profile
    or constants.managed_cli.default_profile
end

-- The `work` workspace is the primary entry into a company project's
-- workstations (see docs/workspaces.md "Workstations"). Each item below is
-- a separate WezTerm tab pointing at either:
--   - the project's main worktree, or
--   - a workstation (a linked worktree for one direction).
-- Both resolve to the `<base>-resume` profile, which is the resume
-- command wrapped in a fresh-session fallback (e.g. `sh -c 'claude
-- --continue || exec claude'`), so first-open of a workspace tab
-- auto-resumes the cwd's last conversation and falls back to a fresh
-- session when none exists.
--
-- Workstations created on demand (`Ctrl+k g d`, the web console's 新会话)
-- need not be listed here: they live as tmux windows inside the
-- repo-family session, not as WezTerm tabs.
return {
  work = {
    defaults = {
      launcher = managed_launcher,
      -- Optional permission overlay inherited by every managed item.
      -- permission_profile = 'auto' | 'full-access',
    },
    items = {
      -- Primary checkout — keep this one for review, integration, hotfixes.
      { cwd = '/home/your-user/work/myproject/main' },

      -- Workstations: one linked worktree per direction, created with
      -- `Ctrl+k g d` (directory <name>, branch dev/<name>, a one-line
      -- purpose in the git branch description) and reset each round with
      -- `worktree-task recycle`.
      { cwd = '/home/your-user/work/.worktrees/myproject/billing' },
      { cwd = '/home/your-user/work/.worktrees/myproject/search-rewrite' },

      -- Per-repo agent override: this checkout uses Codex for every
      -- launch path (workspace first-open, Alt+g, Ctrl+k g, refresh).
      -- After editing, run wezdeck-runtime-ops so shell paths refresh
      -- wezterm-x/local/workspace-agent-map.tsv.
      -- { cwd = '/home/your-user/work/codex-preferred', launcher = 'codex_resume' },
      -- Per-repo permission override (passed through all managed launch paths):
      -- { cwd = '/home/your-user/work/trusted-local', permission_profile = 'full-access' },

      -- Plain shell over a service repo, no managed agent.
      { cwd = '/home/your-user/work/project-c', command = { 'bash' } },
    },
  },

  -- The `opensource` workspace collects personal / open-source projects
  -- under ~/github, separate from the company `work` workspace. Bound to
  -- Alt+s. Workspace-default agent follows the machine default.
  opensource = {
    defaults = {
      launcher = managed_launcher,
    },
    items = {
      { cwd = '/home/your-user/github/some-oss-repo' },
      { cwd = '/home/your-user/github/another-oss-repo' },
    },
  },

  -- The `config` workspace is for cross-machine dotfiles / terminal-stack
  -- repos you maintain alongside this one (WSL bootstrap, IME schemas,
  -- editor config, etc.). The tracked baseline already points `config` at
  -- the synced wezterm-config repo itself; this override REPLACES the
  -- baseline entry, so the repo root must be listed explicitly as the
  -- first item (using `constants.main_repo_root` keeps it correct after a
  -- repo move). Drop in additional sibling dotfiles repos as extra items.
  --
  -- Workspace-default agent follows the machine default. A single item can
  -- still override with its own
  -- `launcher = 'claude_resume'` / `'codex_resume'`.
  config = {
    defaults = {
      launcher = managed_launcher,
    },
    items = {
      { cwd = constants.main_repo_root or '/home/your-user/github/wezterm-config' },
      { cwd = '/home/your-user/github/WSL' },
      { cwd = '/home/your-user/github/rime-config' },
    },
  },
}
