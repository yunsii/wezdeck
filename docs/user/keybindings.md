# Keybindings

Use this doc when you need shortcut behavior.

- `Alt+d`: switch to WezTerm built-in `default`
- `Alt+w`: open or switch to `work` using the private directories configured in `wezterm-x/local/workspaces.lua`
- `Alt+c`: open or switch to `config`
- `Alt+p`: rotate through all currently known workspaces
- `Alt+Shift+x`: open a centered WezTerm confirmation overlay to close the current non-default workspace
- `Alt+Shift+q`: quit WezTerm and close all windows; WezTerm will handle any built-in confirmation
- `Alt+v`: split vertically
- `Alt+s`: split horizontally
- `Alt+o`: open the current WSL working directory in VS Code; when WezTerm only sees the WSL host fallback path, it forwards `Alt+o` to the pane so tmux or the shell can resolve the real cwd
- `Alt+b`: open the Chrome debug browser on the configured port/profile from `wezterm-x/local/constants.lua`, or focus the existing one if it is already running
- `Ctrl+LeftClick`: open the link under the mouse cursor in the system browser
- `Ctrl+c`: copy selection, otherwise send normal `Ctrl+c`
- `Ctrl+v`: paste from clipboard
