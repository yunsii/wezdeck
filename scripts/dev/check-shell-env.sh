#!/usr/bin/env bash
# Read-only check that interactive zsh and managed agents share shell-env.d.
#
# Healthy means:
#   - ~/.config/shell-env.d/wezdeck-env.env is mode 600 and exports WEZDECK_REPO
#   - ~/.zshrc contains the current wezdeck:shell-env.d snippet, after the
#     grok installer PATH block when that block is present
#   - a login zsh reports grok as a function whose body calls the repo wrapper
#   - retired wezterm-env.env / wezterm-fn.env are absent
#
# Exit 1 with a fix line per failure. --advisory always exits 0.
set -euo pipefail

advisory=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --advisory) advisory=1; shift ;;
    -h|--help)
      printf 'Usage: %s [--advisory]\n' "$(basename "$0")"
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
shell_env_dir="${SHELL_ENV_DIR:-$HOME/.config/shell-env.d}"
zshrc="${ZDOTDIR:-$HOME}/.zshrc"
fail=0

note() { printf '[shell-env-check] %s\n' "$*"; }

fail_line() {
  fail=1
  note "warning: $*"
}

check_mode_600() {
  local file="$1"
  local mode=""
  [[ -f "$file" ]] || {
    fail_line "missing $file"
    note "fix: cp $repo_root/wezterm-x/local.example/shell-env.d/$(basename "$file") $shell_env_dir/ && chmod 600 $shell_env_dir/$(basename "$file")"
    return
  }
  mode="$(stat -c '%a' "$file" 2>/dev/null || stat -f '%OLp' "$file")"
  if [[ "$mode" != "600" ]]; then
    fail_line "$file mode is $mode (want 600)"
    note "fix: chmod 600 $file"
  fi
}

check_mode_600 "$shell_env_dir/wezdeck-env.env"
if [[ -f "$shell_env_dir/wezdeck-env.env" ]]; then
  if ! grep -qE '^[[:space:]]*export[[:space:]]+WEZDECK_REPO=' "$shell_env_dir/wezdeck-env.env"; then
    fail_line "$shell_env_dir/wezdeck-env.env does not export WEZDECK_REPO"
  fi
fi

for retired in wezterm-env.env wezterm-fn.env; do
  if [[ -e "$shell_env_dir/$retired" ]]; then
    fail_line "retired file still present: $shell_env_dir/$retired"
    note "fix: rm $shell_env_dir/$retired  # then install wezdeck-${retired#wezterm-} from wezterm-x/local.example/shell-env.d/ if that file is missing"
  fi
done

if [[ ! -f "$zshrc" ]]; then
  fail_line "missing $zshrc"
else
  if grep -q 'wezterm-config:shell-env.d' "$zshrc"; then
    fail_line "$zshrc still has retired marker wezterm-config:shell-env.d"
    note "fix: replace that block with $repo_root/wezterm-x/local.example/zshrc-shell-env.zsh"
  fi
  if ! grep -q 'wezdeck:shell-env.d' "$zshrc"; then
    fail_line "$zshrc has no wezdeck:shell-env.d snippet"
    note "fix: append $repo_root/wezterm-x/local.example/zshrc-shell-env.zsh after the grok installer PATH block"
  else
    grok_line="$(grep -n 'export PATH="\$HOME/.grok/bin:\$PATH"' "$zshrc" | head -n1 | cut -d: -f1 || true)"
    marker_line="$(grep -n 'wezdeck:shell-env.d' "$zshrc" | head -n1 | cut -d: -f1 || true)"
    if [[ -n "$grok_line" && -n "$marker_line" && "$marker_line" -lt "$grok_line" ]]; then
      fail_line "wezdeck:shell-env.d is above the grok installer PATH block (function cannot shadow ~/.grok/bin)"
      note "fix: move the snippet below export PATH=\"\$HOME/.grok/bin:\$PATH\""
    fi
    if ! grep -q 'wezterm-env.env|wezterm-fn.env' "$zshrc"; then
      fail_line "$zshrc snippet does not skip retired wezterm-env.env / wezterm-fn.env"
      note "fix: replace the block with $repo_root/wezterm-x/local.example/zshrc-shell-env.zsh"
    fi
  fi
fi

if [[ -x "$shell_env_dir/grok-focus-filter.env" || -f "$shell_env_dir/grok-focus-filter.env" ]]; then
  :
else
  note "note: $shell_env_dir/grok-focus-filter.env is absent; interactive grok stays on PATH until you copy the template"
fi

if command -v zsh >/dev/null 2>&1 && [[ -f "$zshrc" ]]; then
  probe="$(zsh -ilc 'whence -w grok; whence -f grok' 2>/dev/null || true)"
  if [[ "$probe" != grok:\ function* ]]; then
    fail_line "login zsh does not define grok as a function"
    note "fix: source ~/.zshrc in a new login shell after installing wezdeck-env.env and grok-focus-filter.env"
  elif [[ "$probe" != *grok-with-focus-filter.sh* ]]; then
    fail_line "grok function does not call grok-with-focus-filter.sh"
  fi
fi

if (( fail == 0 )); then
  note "healthy: wezdeck-env.env + wezdeck:shell-env.d + grok function"
  exit 0
fi
if (( advisory )); then
  exit 0
fi
exit 1
