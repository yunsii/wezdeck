return {
  runtime_mode = 'hybrid-wsl',
  default_domain = 'WSL:your-distro-name',
  shell = {
    program = '/bin/zsh',
  },
  managed_cli = {
    ui_variant = 'light',
  },
  chrome_debug_browser = {
    -- Override executable if your browser binary is not on PATH.
    -- executable = 'google-chrome',
    -- Use a Windows path in hybrid-wsl and a local path in posix-local.
    user_data_dir = '/path/to/chrome-profile',
  },
  diagnostics = {
    wezterm = {
      enabled = true,
      level = 'info',
      max_bytes = 5242880,
      max_files = 5,
      debug_key_events = false,
      categories = {
        vscode = true,
        clipboard = true,
        command_panel = true,
        chrome = true,
        host_helper = true,
        workspace = true,
        tab_visibility = true,
      },
    },
  },
  -- Frequency-driven tab layout. By default no workspace opts in, so
  -- existing tab bars behave identically. Enabled workspaces get
  -- slot-aware tab titles where each tab inside the visible_count window
  -- shows the top-N session by recent focus frequency, with a sticky
  -- slot algorithm so positions stay stable when ranks shuffle inside
  -- the top-N. Schema + algorithm: docs/tab-visibility.md.
  -- tab_visibility = {
  --   enabled_workspaces = { work = true, config = true },
  --   visible_count = 5,    -- per-machine overrides
  --   warm_count = 3,
  --   half_life_days = 7,
  --   -- spawn_visible_only = true,  -- limit startup spawn to top-N.
  --   -- DO NOT enable until the Alt+t overflow picker lands; capped
  --   -- sessions are otherwise unreachable. See docs/tab-visibility.md.
  -- },
}
