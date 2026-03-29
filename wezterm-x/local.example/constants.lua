return {
  default_domain = 'WSL:your-distro-name',
  chrome_debug_browser = {
    user_data_dir = 'C:\\path\\to\\chrome-profile',
  },
  diagnostics = {
    wezterm = {
      enabled = false,
      level = 'info',
      file = 'C:\\Users\\your-user\\.wezterm-x\\wezterm-debug.log',
      debug_key_events = false,
      categories = {
        alt_o = true,
        chrome = true,
        workspace = true,
      },
    },
  },
}
