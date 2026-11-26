#!/usr/bin/env bash
# agent-claude-sub2api-lib.sh — Anthropic-compatible gateway auth and
# CLAUDE_CONFIG_DIR isolation. Sourced by agent-launcher.sh and the gateway
# profile wrappers.
#
# shellcheck shell=bash

# Drop gateway overrides so the stock `claude` profile stays on OAuth /
# subscription auth. Claude Code prefers ANTHROPIC_API_KEY /
# ANTHROPIC_AUTH_TOKEN over a logged-in team session when either is set.
clear_anthropic_gateway_env() {
  unset ANTHROPIC_API_KEY \
    ANTHROPIC_AUTH_TOKEN \
    ANTHROPIC_BASE_URL \
    ANTHROPIC_CUSTOM_HEADERS \
    2>/dev/null || true
}

# Isolate Claude Code's config home for gateway auth.
#
# Why: ~/.claude holds the team OAuth session. When ANTHROPIC_AUTH_TOKEN is
# also set, Claude Code enters a hybrid "API keys + Max/Team" path. After the
# team 5h limit, that path tries Anthropic "extra usage" billing against
# platform.claude.com and fails with:
#   "You're logged in with API keys, but haven't purchased any extra usage"
# even though the gateway itself is healthy. A separate CLAUDE_CONFIG_DIR
# without .credentials.json forces pure gateway auth (AUTH_TOKEN + BASE_URL).
#
# Default home: ~/.config/claude-profiles/home
# Override:     CLAUDE_SUB2API_HOME / CLAUDE_KIMI_HOME
prepare_claude_sub2api_home() {
  local home_dir="${CLAUDE_GATEWAY_HOME:-${CLAUDE_SUB2API_HOME:-$HOME/.config/claude-profiles/home}}"
  local main_claude="${HOME}/.claude"
  local name
  local main_json="${HOME}/.claude.json"
  local home_json="$home_dir/.claude.json"

  mkdir -p "$home_dir"

  # Never carry team OAuth into the gateway home.
  if [[ -e "$home_dir/.credentials.json" || -L "$home_dir/.credentials.json" ]]; then
    rm -f "$home_dir/.credentials.json"
  fi

  # Copy local settings (hooks / permissions), but strip endpoint, credential,
  # model, and effort overrides. Claude Code gives settings.json env entries
  # precedence over the process environment, which can otherwise silently
  # defeat this profile.
  if [[ -f "$main_claude/settings.json" && ! -e "$home_dir/settings.json" ]]; then
    if command -v python3 >/dev/null 2>&1; then
      python3 - "$main_claude/settings.json" "$home_dir/settings.json" <<'PY'
import json, os, sys

source, target = sys.argv[1], sys.argv[2]
with open(source, encoding="utf-8") as f:
    data = json.load(f)
env = data.get("env")
if isinstance(env, dict):
    blocked = {
        "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME", "ENABLE_TOOL_SEARCH",
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_EFFORT_LEVEL",
    }
    data["env"] = {key: value for key, value in env.items() if key not in blocked}
with open(target, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
    else
      cp "$main_claude/settings.json" "$home_dir/settings.json"
    fi
  fi

  # User-level AGENTS / topic docs (same as main ~/.claude).
  if [[ -d "$main_claude" ]]; then
    for name in CLAUDE.md \
      automation.md documentation.md implementation.md permissions.md \
      permissions-claude.md platform-actions.md preferences.md \
      refactor.md reporting.md secrets.md validation.md \
      repo-bootstrap.md tool-use.md vcs.md; do
      if [[ -e "$main_claude/$name" && ! -e "$home_dir/$name" ]]; then
        ln -s "$main_claude/$name" "$home_dir/$name"
      fi
    done
  fi

  # Merge workspace trust into $CLAUDE_CONFIG_DIR/.claude.json.
  # Claude rewrites this file on first launch (migration fields), so we
  # always merge rather than only seeding an empty file. Source of truth
  # for prior trusts: ~/.claude.json (main home).
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$main_json" "$home_json" "${PWD:-}" <<'PY'
import json, os, sys

main_path, home_path, cwd = sys.argv[1], sys.argv[2], sys.argv[3]

def load(p):
    try:
        with open(p) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}

main = load(main_path)
home = load(home_path)
projects = home.get("projects")
if not isinstance(projects, dict):
    projects = {}
home["projects"] = projects

# Copy trust flags from the main login home.
main_projects = main.get("projects")
if isinstance(main_projects, dict):
    for path, meta in main_projects.items():
        if isinstance(meta, dict) and meta.get("hasTrustDialogAccepted"):
            entry = projects.get(path) if isinstance(projects.get(path), dict) else {}
            entry["hasTrustDialogAccepted"] = True
            projects[path] = entry

# Always trust the launch cwd.
if cwd:
    entry = projects.get(cwd) if isinstance(projects.get(cwd), dict) else {}
    entry["hasTrustDialogAccepted"] = True
    projects[cwd] = entry

tmp = home_path + ".tmp"
with open(tmp, "w") as f:
    json.dump(home, f, indent=2)
    f.write("\n")
os.replace(tmp, home_path)
PY
  fi

  export CLAUDE_CONFIG_DIR="$home_dir"
}

# Load an Anthropic-compatible gateway profile from a dedicated file — never
# from shell-env.d auto-glob. Arguments: profile label, env-file variable,
# default env file, home variable, default home.
load_claude_gateway_env() {
  local profile="$1"
  local env_var="$2"
  local default_env="$3"
  local home_var="$4"
  local default_home="$5"
  local env_file="${!env_var:-$default_env}"
  local repo_root
  repo_root="$(runtime_env_repo_root)"

  if [[ ! -r "$env_file" ]]; then
    printf 'agent-launcher: %s env file missing or unreadable:\n' "$profile" >&2
    printf '  %s\n' "$env_file" >&2
    printf 'Create it (mode 600) from:\n' >&2
    printf '  %s/wezterm-x/local.example/claude-profiles/%s.env\n' "$repo_root" "$profile" >&2
    printf 'Or point %s at an alternate path.\n' "$env_var" >&2
    exit 1
  fi

  clear_anthropic_gateway_env
  runtime_env_load_shell "$env_file"
  CLAUDE_GATEWAY_HOME="${!home_var:-$default_home}"
  export CLAUDE_GATEWAY_HOME
  prepare_claude_sub2api_home

  if [[ -z "${ANTHROPIC_AUTH_TOKEN:-}" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
    printf 'agent-launcher: %s must set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY\n' "$env_file" >&2
    exit 1
  fi
  if [[ -z "${ANTHROPIC_BASE_URL:-}" ]]; then
    printf 'agent-launcher: %s must set ANTHROPIC_BASE_URL\n' "$env_file" >&2
    exit 1
  fi
}

load_claude_sub2api_env() {
  load_claude_gateway_env sub2api CLAUDE_SUB2API_ENV \
    "$HOME/.config/claude-profiles/sub2api.env" \
    CLAUDE_SUB2API_HOME "$HOME/.config/claude-profiles/home"
}

load_claude_kimi_env() {
  load_claude_gateway_env kimi CLAUDE_KIMI_ENV \
    "$HOME/.config/claude-profiles/kimi.env" \
    CLAUDE_KIMI_HOME "$HOME/.config/claude-profiles/kimi-home"
}

