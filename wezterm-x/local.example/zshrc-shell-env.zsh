# Source ~/.config/shell-env.d/*.env for interactive zsh.
#
# Install (once), after any installer PATH blocks such as the grok
# installer (those prepend ~/.grok/bin; this snippet must run later so a
# shell function can shadow that PATH entry):
#
#   MARKER='wezdeck:shell-env.d'
#   SNIPPET=/absolute/path/to/wezterm-config/wezterm-x/local.example/zshrc-shell-env.zsh
#   grep -q "$MARKER" ~/.zshrc || printf '\n%s\n' "$(cat "$SNIPPET")" >> ~/.zshrc
#
# The runtime loader (scripts/runtime/runtime-env-lib.sh) already globs
# this directory for managed agents. This snippet is the interactive
# counterpart. Missing directory is a no-op.
#
# shellcheck disable=SC1090
# wezdeck:shell-env.d
# Retired wezterm-env.env / wezterm-fn.env are skipped. Rename them to
# wezdeck-env.env / wezdeck-fn.env; the runtime loader logs the same skip.
if [[ -d "${SHELL_ENV_DIR:-$HOME/.config/shell-env.d}" ]]; then
  setopt local_options nullglob
  for __wez_shell_env in "${SHELL_ENV_DIR:-$HOME/.config/shell-env.d}"/*.env; do
    __wez_shell_env_base="${__wez_shell_env:t}"
    case "$__wez_shell_env_base" in
      wezterm-env.env|wezterm-fn.env)
        print -u2 "wezdeck: skip retired ${__wez_shell_env_base}; rename to wezdeck-${__wez_shell_env_base#wezterm-}"
        ;;
      *)
        [[ -r "$__wez_shell_env" ]] && source "$__wez_shell_env"
        ;;
    esac
  done
  unset __wez_shell_env __wez_shell_env_base
fi
