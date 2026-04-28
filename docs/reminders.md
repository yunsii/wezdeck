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

## Diagnostics

- **Manual test from a real tmux pane** (not from an agent process): `scripts/runtime/reminder.sh ' test ' 'visible?'`. Press a key to dismiss. If the popup does not appear, see the items below.
- **Agent-context test note**. Running `reminder.sh` from inside an agent's bash shows the popup but `read -n1` EOFs on the agent's popup pty and closes immediately. Agent-side smoke tests are unreliable for the read step; the cron-fired path has a clean controlling tty and behaves correctly.
- **Cron daemon not running**. `service cron status` should show *active*. If not, `sudo service cron start`. With `systemd=true` in `/etc/wsl.conf`, cron auto-starts on WSL boot.
- **Popup did not show**. `tmux list-clients` should list at least one attached client. If empty, `tmux-popup-active.sh` no-ops by design — open WezTerm, attach a tmux session, and re-fire by running the reminder line manually.
- **Wrong workspace got the popup**. `tmux-popup-active.sh` picks by `client_activity` (most recent key / mouse input). If you switched workspaces by clicking the wezterm tab bar without sending any input into the new tab, the activity timestamp did not update and the popup lands on the previous workspace. Send a keystroke into the target workspace to claim it before the next fire.
