# Demo Assets

Screenshots and GIFs embedded in the top-level [`README.md`](../../README.md) Demo section.

The demo is a **WezDeck workspace** named `mock-deck`. Six tabs spawn (three OSS-style "projects" × two "worktree" slots each), each tab's pane runs a typewriter agent through the real attention pipeline. WezTerm tab badges + right-status counter + Alt+/ overlay all render natively because each tab has a real `wezterm_pane_id`.

## Files (target shape)

| File | Source command | Purpose |
|---|---|---|
| `hero.png` | `mock-deck.sh --scenario hero --hold 600` | Static still: `⟳ 2 ⚠ 2 ✓ 2` + 6 tab badges |
| `01-counter-flow.gif` | `mock-deck.sh --scenario continuous` | Right-status counter animating as agents stream |
| `02-alt-slash.gif` | `mock-deck.sh --scenario continuous` + press `Alt+/` | Picker popup with realistic labels across all 6 tabs |
| `03-tab-badges.gif` | live tab navigation `Alt+1..6` inside the demo | Tab badges and active-tab focus transitions |

Width target: 960 px. Size target: ≤ 2 MB per asset.

## One-time setup

The `mock-deck` workspace is registered in [`wezterm-x/local/workspaces.lua`](../../wezterm-x/local/workspaces.lua) (gitignored). Six items reference [`scripts/dev/mock-deck/mock-launcher.sh`](../../scripts/dev/mock-deck/mock-launcher.sh) by absolute path. After cloning a fresh machine you'd add the workspace block + run a runtime sync — already done on this checkout.

The orchestrator auto-creates the six fake project directories under `~/.cache/wezdeck/mock-projects/` on first run.

## Capture workflow

1. **Start the orchestrator** from any pane (it does NOT spawn tabs itself; it manages state):
   ```bash
   /home/yuns/github/wezterm-config/scripts/dev/mock-deck/mock-deck.sh --scenario hero --hold 600 --reset
   ```
   It writes a hero sentinel + pins each tab's status in `attention.json`. Then it sleeps until Ctrl+C.

2. **Switch to the workspace**: `Alt+d → mock-deck`. Six tabs spawn:
   ```
   cli-parser-1   cli-parser-2   image-resizer-1   image-resizer-2   log-daemon-1   log-daemon-2
   ```
   Each tab boots a tmux session whose left pane runs `mock-agent.sh` against the matching tape. Because the hero sentinel is present, agents stream their tape visuals but suppress their own attention emits — your pinned pose holds.

3. **Right-status** shows `⟳ 2 ⚠ 2 ✓ 2`. **Tab badges** show running on cli-parser-{1,2}, waiting on image-resizer-{1,2}, done on log-daemon-{1,2}.

4. **Capture** with [ScreenToGif](https://www.screentogif.com/) (Windows). Use `Alt+1..6` to switch between tabs for narrative GIFs.

5. **Hide noise** for the recording: comment `WAKATIME_API_KEY` in `wezterm-x/local/shared.env` (then `Ctrl+Shift+R` to reload), restore after.

6. **End the demo**: `Ctrl+C` in the orchestrator pane. The cleanup trap removes the sentinel, clears the six demo entries from `attention.json`, and `pkill`s the running `mock-agent.sh` processes (so spawned tabs stop streaming). Tabs remain — switch workspace with `Alt+d` to your normal one, or close the mock tabs manually.

## Continuous mode

Drop `--scenario hero --hold 600` and use `--scenario continuous` instead. The orchestrator creates dirs + waits; agents emit transitions as their tapes play, so the counter and badges animate organically. Best for the counter-flow / alt-slash GIFs.

## Re-encoding

After the recorder dumps a `.mp4` / `.webm`, palette-aware GIF encode:

```bash
ffmpeg -i raw.mp4 -vf "fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" out.gif
```

Drop empty frames in ScreenToGif's editor before exporting — every second of unchanging frames is ~50 KB of waste.

## Tape grammar + adding projects

Tapes live in [`scripts/dev/mock-deck/tapes/`](../../scripts/dev/mock-deck/tapes/) and use a tiny line-oriented grammar (`delay`, `type`, `print`, `read`, `edit`, `bash`, `result`, `prompt`, `status`, …). Full grammar: header of [`mock-agent.sh`](../../scripts/dev/mock-deck/mock-agent.sh).

To add a new project:
1. Drop `<project>-1.tape` and `<project>-2.tape` into `tapes/`.
2. In `mock-deck.sh`: append the project name to `PROJECTS=( … )` and add `HERO_STATE` / `HERO_REASON` entries.
3. In `wezterm-x/local/workspaces.lua` mock-deck workspace: add `mock_item('<project>', 1)` and `mock_item('<project>', 2)`.
