# Reminders

Use this doc when you need anything about the timed reminder pipeline: cron entries, the popup wrapper scripts (`reminder.sh` / `tmux-popup-active.sh`), the install workflow via `wezterm-x/local/crontab`, or troubleshooting why a reminder did not pop.

## How it works

Three layers, each owning one concern:

1. **cron** schedules the trigger. WSL's cron daemon runs under systemd (enabled by `systemd=true` in `/etc/wsl.conf`), fires the entry at the configured time, and inherits no `$TMUX` env. The user crontab is the source of truth for *when* and *what message*.
2. **`scripts/runtime/reminder.sh`** is the domain wrapper. Takes `<title> <message> [width] [height]` and builds the standard popup body: centered message + `回车 / Esc 关闭` hint, with `read -n1 -s` blocking on the popup tty. No timeout — see *Why no auto-dismiss* below.
3. **`scripts/runtime/tmux-popup-active.sh`** is the cron-friendly tmux adapter. Picks the popup target by listing tmux clients and sorting on `client_activity`, so the popup lands on whichever workspace the user was last looking at. Silently no-ops when no client is attached, so cron does not stack up failure-mail when WezTerm is not running.

For non-reminder popups (custom interactive menu, log dump, etc.) call `tmux-popup-active.sh` directly and skip `reminder.sh`.

## Install

The repo ships only the **template** at `wezterm-x/local.example/crontab`; the live crontab lives in the gitignored `wezterm-x/local/crontab` and is loaded into the actual cron table with `crontab <file>`.

```bash
cp wezterm-x/local.example/crontab wezterm-x/local/crontab
$EDITOR wezterm-x/local/crontab     # tweak schedule and message
crontab wezterm-x/local/crontab     # atomically replaces the user crontab
crontab -l                          # confirm
```

Re-running `crontab <file>` on the same source replaces the entire user crontab atomically, so the source file is the durable record — a fresh machine restores all reminders by re-running that one command.

## Adding a new reminder

One line per reminder in `wezterm-x/local/crontab`:

```cron
30 14 * * 1-5 /home/yuns/github/wezterm-config/scripts/runtime/reminder.sh ' ☕ 起来活动 ' '坐 5 小时了，活动一下'
0 18 * * 1-5  /home/yuns/github/wezterm-config/scripts/runtime/reminder.sh ' 🚇 该走了 '   '末班地铁 18:30'
```

Fields:

- Time spec — standard cron 5-tuple. `1-5` in the day-of-week field skips weekends.
- Title — shown in the popup border. Pad with spaces inside the quotes for breathing room around the text.
- Message — single-line text shown inside the popup. Use single quotes so shell metacharacters are literal.

After editing, re-run `crontab wezterm-x/local/crontab` to load the change.

## Why no auto-dismiss

`reminder.sh` deliberately omits `read -t <timeout>`. A reminder that auto-closes while you are away defeats its purpose — the next morning you cannot tell whether you saw it or it timed out unattended. The popup blocks until you press a key, which is the explicit acknowledgement.

If a particular reminder genuinely is fire-and-forget (e.g. a "deploy started" notification that needs no ack), call `tmux-popup-active.sh` directly with a custom body that uses `sleep N` instead of `read`.

## Why not the attention pipeline

The agent-attention right-status counter and tab badges (see [`agent-attention.md`](./agent-attention.md)) are the existing "something needs your eyes" surface, but they were rejected for reminders during design:

- Attention is for *agent* turns (Claude, Codex). Mixing in cron-driven reminders dilutes the `🚨 N waiting` counter's meaning.
- Attention's badge is glanceable but easy to miss when you are heads-down — the whole reason a reminder exists is to interrupt heads-down work.

The popup interrupts; the attention pipeline does not. They are orthogonal.

## View

`reminders` (under `scripts/runtime/cli/`, on PATH via the `wezterm-env.env` template — see [setup.md](./setup.md#env-loading-model)) prints every entry in the installed user crontab — popup-driven reminders alongside any other commands you have scheduled — with the next scheduled fire computed via `systemd-analyze calendar` and one or two recent-activity signals.

- **`fired`** counts cron-journal `(yuns) CMD (...)` lines that match the entry's script basename in the configured window. This is evidence cron *started* the command — for popup entries it is NOT proof the popup appeared.
- **`shown`** (popup entries only) counts `popup` category `message="shown"` rows that `tmux-popup-active.sh` emits to runtime.log immediately before `exec tmux display-popup`. This is the actual "popup reached tmux" signal. The view matches acks to entries by their literal `popup_title` (including any padding spaces), so the parsed title in the View output and the title in the runtime log are always the same string.

Non-popup entries (anything that doesn't route through `reminder.sh` or `tmux-popup-active.sh`) get a `command` row showing the full first-token path and a `fired` row; the ack contract is popup-specific so `shown` is omitted entirely rather than printed as a confusing N/A.

When both counts agree on a popup entry, it's healthy. When `shown` is the dim placeholder text, either ack tracking was introduced after the window started or the popup has never actually fired in that window — the docs note below explains. When `shown` is non-zero but lower than the post-first-ack `fired` count, the view prints a `⚠ N fires after <ts> lack an ack` warning: those fires are the silent-drop smoking gun and you should jump straight to the *tmux binary mismatch* / *Popup did not show* items below.

Cron schedule translation covers the common patterns: single integer, `*`, and comma-list values in minute and hour; weekday ranges and single days in the day-of-week column. Anything more exotic (steps, multi-field ranges) degrades to `(complex schedule — next-fire calc skipped)` rather than guessing wrong; `fired`/`shown` still work for those entries because they read the journal/log directly without re-computing schedules.

Env knobs: `REMINDERS_JOURNAL_SINCE` (default `14 days ago`) widens or narrows both windows. `NO_COLOR=1` disables ANSI styling, useful when piping the output.

## Diagnostics

- **Manual test from a real tmux pane** (not from an agent process): `scripts/runtime/reminder.sh ' test ' 'visible?'`. Press a key to dismiss. If the popup does not appear, see the items below.
- **Simulate cron's stripped environment**: `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" scripts/runtime/tmux-popup-active.sh ' smoke ' 'sleep 2'`. Reproduces the cron call site without waiting for the next tick. If this silently exits 0 with no popup, `tmux list-clients` returned empty under that env — check the tmux-binary item below.
- **tmux binary mismatch after upgrade**. If the running tmux server lives at `/usr/local/bin/tmux` (e.g. a newer self-built or Homebrew install) but cron's default `PATH=/usr/bin:/bin` finds an older `/usr/bin/tmux`, the version-skewed client cannot talk to the server: `tmux list-clients` prints `server exited unexpectedly` to stderr (discarded by cron) and `tmux-popup-active.sh` silently no-ops. Fix in `wezterm-x/local/crontab` by setting `PATH=/usr/local/bin:/usr/bin:/bin` at the top of the file (cron honors env declarations for all subsequent CMDs), then reinstall with `crontab wezterm-x/local/crontab`.
- **Cron entry calls a user-installed tool not on cron's PATH** (the general form of the previous item). Cron's `PATH=/usr/bin:/bin` excludes `/usr/local/bin`, `~/.local/bin`, the fnm default-alias `bin/` (`~/.local/share/fnm/aliases/default/bin/` — where npm-global Node CLIs like `lark-cli`, `cnb`, `codex` are symlinked), Python venv `bin/`s, and anything else your interactive shell adds. A subprocess call that worked at the terminal raises `FileNotFoundError` / `command not found` under cron, but the cron journal still logs a clean fire — so `reminders` shows `fired` increment with no signal that anything went wrong. For popup entries the `shown` divergence catches this; for plain script entries you have to read the script's own log (e.g. `/tmp/sync.log`). Fix by extending the `PATH=...` line at the top of `wezterm-x/local/crontab` with whatever stable dir holds the missing tool — fnm's `aliases/default/bin/` is the right anchor for any npm-global CLI installed under the default Node version.
- **Agent-context test note**. Running `reminder.sh` from inside an agent's bash shows the popup but `read -n1` EOFs on the agent's popup pty and closes immediately. Agent-side smoke tests are unreliable for the read step; the cron-fired path has a clean controlling tty and behaves correctly.
- **Cron daemon not running**. `service cron status` should show *active*. If not, `sudo service cron start`. With `systemd=true` in `/etc/wsl.conf`, cron auto-starts on WSL boot.
- **Popup did not show**. `tmux list-clients` should list at least one attached client. If empty, `tmux-popup-active.sh` no-ops by design — open WezTerm, attach a tmux session, and re-fire by running the reminder line manually.
- **Wrong workspace got the popup**. `tmux-popup-active.sh` picks by `client_activity` (most recent key / mouse input). If you switched workspaces by clicking the wezterm tab bar without sending any input into the new tab, the activity timestamp did not update and the popup lands on the previous workspace. Send a keystroke into the target workspace to claim it before the next fire.
