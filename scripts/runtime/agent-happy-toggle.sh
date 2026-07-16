#!/usr/bin/env bash
# agent-happy-toggle.sh — flip the focused agent pane between a bare CLI
# session and a Happy-wrapped (phone-sync) session, resuming the same
# conversation across the switch.
#
# This is the "simple version" (see docs/mobile-access.md): it assumes
# one in-progress conversation per cwd, so it resumes via the launcher's
# own `--continue` / `resume --last` rather than owning explicit session
# ids. A precise, id-owning variant is deferred until the agent CLIs can
# both (a) start a fresh session with a caller-supplied id and (b) expose
# the running session id of a bare process — neither is possible today
# (verified: bare `claude` leaks its id via neither argv, /proc/fd, nor
# environ; `codex` has no `--session-id` at all).
#
# Mechanism (mirrors refresh-current-window): identify the agent in the
# target pane, then `respawn-pane -k` it through agent-launcher.sh with or
# without `--happy`. The conversation survives via the on-disk session
# log; only live scroll / unsent input is lost, same as a window refresh.
#
# Only ever touches the pane it is handed (refresh-current-window rule).
#
# Usage (from the Ctrl+k p chord or the command palette):
#   agent-happy-toggle.sh <pane_id> <pane_current_path>

set -eu

pane_id="${1:-}"
pane_cwd="${2:-}"

script_dir="$(cd "$(dirname "$0")" && pwd -P)"

msg() { tmux display-message "$1" 2>/dev/null || true; }

[ -n "$pane_id" ] || { msg "agent-happy-toggle: no pane id given"; exit 0; }

pane_pid="$(tmux display-message -p -t "$pane_id" '#{pane_pid}' 2>/dev/null || true)"
[ -n "$pane_pid" ] || { msg "agent-happy-toggle: cannot resolve pane pid"; exit 0; }

# Two facts shape detection (both verified against a live wrapped pane):
#   1. Happy runs the CLI behind an inner pty, so the pane's own
#      `pane_current_command` reads `sh`/`node`, not `claude`.
#   2. A Happy-wrapped pane's argv does NOT carry a clean flavour token —
#      the frontend is `happy/dist/index.mjs --continue` (claude is the
#      implicit default; only `happy codex` names it) and the inner
#      binary is `.../claude/versions/<v> --resume <id>`, where "claude"
#      sits mid-path. So we cannot pull the flavour out of the wrapped
#      argv reliably.
# Therefore: use the presence of `happy/dist/index.mjs` in the pane's
# descendant tree as the ground truth for *wrapped*, and take the
# *flavour* from the `@wezterm_pane_role` tag (stamped on every respawn
# below), falling back to `pane_current_command` / the launcher argv for
# a bare pane and to `claude` for a wrapped pane with no tag.
ps_snapshot="$(ps -eo pid=,ppid=,args= 2>/dev/null || true)"

# Emit the full "pid ppid args" ps line for the root pid and every
# descendant. Detection greps the args; the demote teardown pulls Happy
# frontend pids from the first column. Scoped strictly to this pane's
# subtree so teardown can never reach the shared daemon or another pane's
# session.
descendant_lines() {
  local seen=" $1 " frontier="$1" out="" next pid line kids k
  while [ -n "$frontier" ]; do
    next=""
    for pid in $frontier; do
      line="$(printf '%s\n' "$ps_snapshot" | awk -v p="$pid" '$1==p {print}')"
      [ -n "$line" ] && out="$out
$line"
      kids="$(printf '%s\n' "$ps_snapshot" | awk -v p="$pid" '$2==p {print $1}')"
      for k in $kids; do
        case "$seen" in *" $k "*) : ;; *) seen="$seen$k "; next="$next $k" ;; esac
      done
    done
    frontier="$next"
  done
  printf '%s\n' "$out"
}

tree="$(descendant_lines "$pane_pid")"
pane_cmd="$(tmux display-message -p -t "$pane_id" '#{pane_current_command}' 2>/dev/null || true)"
role="$(tmux show-options -p -t "$pane_id" -v @wezterm_pane_role 2>/dev/null || true)"
role_flavor="${role#agent-cli:}"
[ "$role_flavor" = "$role" ] && role_flavor=""

flavor=""
wrapped=0
if printf '%s' "$tree" | grep -qE 'happy/dist/index\.mjs'; then
  wrapped=1
  # codex mode shows `index.mjs codex`; otherwise it is claude.
  if printf '%s' "$tree" | grep -qE 'index\.mjs +codex'; then
    flavor="codex"
  else
    flavor="${role_flavor:-claude}"
  fi
else
  case "$pane_cmd" in
    claude*) flavor="claude" ;;
    codex*)  flavor="codex" ;;
    *)
      if [ -n "$role_flavor" ]; then
        flavor="$role_flavor"
      elif printf '%s' "$tree" | grep -qE 'agent-launcher\.sh +codex'; then
        flavor="codex"
      elif printf '%s' "$tree" | grep -qE 'agent-launcher\.sh +claude'; then
        flavor="claude"
      fi
      ;;
  esac
fi

[ -n "$flavor" ] || { msg "Not an agent pane — nothing to toggle."; exit 0; }

# Simple version ships claude only. Promoting codex needs the (untested)
# `happy codex` resume form and codex cannot own a fresh session id, so
# refuse to promote it for now. Demote stays safe (bare `codex` resume),
# but we never wrap codex, so it should not arise.
if [ "$flavor" = "codex" ] && [ "$wrapped" -eq 0 ]; then
  msg "codex Happy 切换待实测,暂不支持(见 docs/mobile-access.md)"
  exit 0
fi

launcher="$script_dir/agent-launcher.sh"
[ -n "$pane_cwd" ] && [ -d "$pane_cwd" ] || pane_cwd="${HOME:-/}"

if [ "$wrapped" -eq 1 ]; then
  cmd="$launcher $flavor"
  note="$flavor: Happy → bare (phone sync off)"
  # Graceful teardown before the hard respawn: SIGTERM the Happy frontend
  # so it can deregister the session from the relay. respawn-pane -k
  # SIGKILLs, which leaves the phone showing the session online until the
  # relay times the dropped socket out. Strictly scoped to Happy
  # frontends inside THIS pane's subtree ($tree), and the daemon
  # (`daemon start-sync`) / other daemon-spawned sessions are excluded, so
  # this can never touch the shared background service or another session.
  term_pids="$(printf '%s\n' "$tree" | awk '/happy\/dist\/index\.mjs/ && $0 !~ /daemon start-sync/ && $0 !~ /--started-by daemon/ {print $1}')"
  if [ -n "$term_pids" ]; then
    # shellcheck disable=SC2086
    kill -TERM $term_pids 2>/dev/null || true
    # Bounded wait (≤1.5s) for the frontend to exit; break as soon as it
    # is gone so a fast deregister keeps the toggle snappy.
    for _ in $(seq 1 15); do
      still=""
      for p in $term_pids; do kill -0 "$p" 2>/dev/null && still=1; done
      [ -n "$still" ] || break
      sleep 0.1
    done
  fi
else
  cmd="$launcher $flavor --happy"
  note="$flavor: bare → Happy (phone sync on)"
fi

tmux respawn-pane -k -t "$pane_id" -c "$pane_cwd" "$cmd"
# Re-stamp the pane role so Ctrl+n / Ctrl+P keep recognising the agent
# through the wrapper's sh/node boot transient (see @agent_pane_match).
tmux set-option -p -t "$pane_id" @wezterm_pane_role "agent-cli:$flavor" 2>/dev/null || true
msg "$note"
