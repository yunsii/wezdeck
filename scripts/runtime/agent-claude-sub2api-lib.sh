#!/usr/bin/env bash
# agent-claude-sub2api-lib.sh — gateway auth + CLAUDE_CONFIG_DIR isolation
# for the claude-sub2api profile. Sourced by agent-launcher.sh and
# scripts/runtime/cli/claude-sub2api.
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
# Override:     CLAUDE_SUB2API_HOME
prepare_claude_sub2api_home() {
  local home_dir="${CLAUDE_SUB2API_HOME:-$HOME/.config/claude-profiles/home}"
  local main_claude="${HOME}/.claude"
  local name
  local main_json="${HOME}/.claude.json"
  local home_json="$home_dir/.claude.json"

  mkdir -p "$home_dir"

  # Never carry team OAuth into the gateway home.
  if [[ -e "$home_dir/.credentials.json" || -L "$home_dir/.credentials.json" ]]; then
    rm -f "$home_dir/.credentials.json"
  fi

  # Reuse local settings (hooks / permissions) from the main home when
  # present. Prefer symlink so hook path edits stay in one place.
  if [[ -f "$main_claude/settings.json" && ! -e "$home_dir/settings.json" ]]; then
    ln -s "$main_claude/settings.json" "$home_dir/settings.json"
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

# Load sub2api (or any Anthropic-compatible gateway) credentials from a
# dedicated file — never from shell-env.d auto-glob. Override path with
# CLAUDE_SUB2API_ENV.
load_claude_sub2api_env() {
  local env_file="${CLAUDE_SUB2API_ENV:-$HOME/.config/claude-profiles/sub2api.env}"
  local repo_root
  repo_root="$(runtime_env_repo_root)"

  if [[ ! -r "$env_file" ]]; then
    printf 'agent-launcher: claude-sub2api env file missing or unreadable:\n' >&2
    printf '  %s\n' "$env_file" >&2
    printf 'Create it (mode 600) from:\n' >&2
    printf '  %s/wezterm-x/local.example/claude-profiles/sub2api.env\n' "$repo_root" >&2
    printf 'Or point CLAUDE_SUB2API_ENV at an alternate path.\n' >&2
    exit 1
  fi

  clear_anthropic_gateway_env
  runtime_env_load_shell "$env_file"
  prepare_claude_sub2api_home

  if [[ -z "${ANTHROPIC_AUTH_TOKEN:-}" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
    printf 'agent-launcher: %s must set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY\n' \
      "$env_file" >&2
    exit 1
  fi
  if [[ -z "${ANTHROPIC_BASE_URL:-}" ]]; then
    printf 'agent-launcher: %s must set ANTHROPIC_BASE_URL\n' "$env_file" >&2
    exit 1
  fi
}

