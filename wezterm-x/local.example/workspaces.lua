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
-- two-tier worktree model (see docs/workspaces.md "Task Worktree Lifecycle
-- Model"). Each item below is a separate WezTerm tab pointing at either:
--   - the project's main worktree, or
--   - a long-lived dev-* worktree.
-- Both resolve to the `<base>-resume` profile, which is the resume
-- command wrapped in a fresh-session fallback (e.g. `sh -c 'claude
-- --continue || exec claude'`), so first-open of a workspace tab
-- auto-resumes the cwd's last conversation and falls back to a fresh
-- session when none exists.
--
-- task-* and hotfix-* worktrees are NOT listed here — they're created on
-- demand via `Ctrl+k g t` / `Ctrl+k g h` and live as tmux windows inside
-- the repo-family session, not as WezTerm tabs.
return {
  work = {
    defaults = {
      launcher = managed_launcher,
    },
    items = {
      -- Primary checkout — keep this one for review, integration, hotfixes.
      { cwd = '/home/your-user/work/myproject/main' },

      -- Long-lived parallel dev workstations. Each maps to a worktree
      -- created once via `git worktree add` (manually) and lives weeks-
      -- to-months. Naming is up to you; recommended `dev-<area>` so the
      -- intent is obvious in tmux titles and `git worktree list`.
      { cwd = '/home/your-user/work/myproject/dev-billing' },
      { cwd = '/home/your-user/work/myproject/dev-search-rewrite' },

      -- Plain shell over a service repo, no managed agent.
      { cwd = '/home/your-user/work/project-c', command = { 'bash' } },
    },
  },

  -- The `opensource` workspace collects personal / open-source projects
  -- under ~/github, separate from the company `work` workspace. Bound to
  -- Alt+s. Same launcher resolution as `work` — first open auto-resumes
  -- the cwd's last conversation, falling back to a fresh agent.
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
