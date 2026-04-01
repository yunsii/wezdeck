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
- `Alt+o`: open the current worktree root in VS Code; in managed workspaces it resolves the target from the live tmux session path so linked-worktree switches stay in the current worktree instead of jumping back to the repo family's primary worktree, and outside git worktrees it still uses the current directory
- `Alt+g`: open a centered tmux popup worktree picker for the current repo family; selecting an unopened worktree creates its tmux window on demand
- `Alt+Shift+g`: cycle to the next git worktree in the current repo family, creating the tmux window on demand when needed
- `Alt+b`: open the configured Chrome debug browser profile from `wezterm-x/local/constants.lua`; in `hybrid-wsl` it uses the synced Windows launcher, and in `posix-local` it uses the synced shell launcher
- `LeftClick`: inside tmux, use the click only to focus the pane under the mouse; it does not start tmux selection and is not forwarded as a mouse click into the pane application
- `Shift+LeftDrag`: start a tmux copy-mode selection inside the current pane without crossing into neighboring tmux panes; press `Ctrl+c` or `Enter` to copy and exit copy-mode
- `LeftDrag`: outside tmux copy-mode, plain drag does not start selection; use `Shift+LeftDrag` for tmux pane-local selection or `Alt+LeftDrag` for WezTerm terminal-wide selection
- `Alt+LeftDrag`: bypass tmux mouse reporting and use WezTerm's terminal-wide text selection when you intentionally want to select across pane boundaries; copy it with `Ctrl+c` or `Ctrl+Shift+c`
- `Ctrl+LeftClick`: open the link under the mouse cursor in the system browser
- `Ctrl+c`: if the current WezTerm pane has a terminal selection, copy it to the system clipboard and clear the selection; otherwise send a normal terminal `Ctrl+c`, which in tmux copy-mode copies the current tmux selection and exits copy-mode
- `Ctrl+Shift+c`: if the current WezTerm pane has a terminal selection, copy it to the system clipboard and clear the selection; otherwise forward `Ctrl+Shift+c` to the pane
- `Ctrl+v`: smart paste; in Windows-hosted `hybrid-wsl`, if the current Windows clipboard content is a bitmap image, export it to a temporary `.png` on the Windows host and paste its WSL path into the active pane; otherwise do a normal clipboard paste
- `Ctrl+Shift+v`: force a normal clipboard paste without the image-export helper
- `Enter` in tmux copy-mode: copy the current tmux selection to the system clipboard and leave copy-mode
