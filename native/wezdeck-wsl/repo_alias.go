package main

// Repo display names, the same as the desk: WEZDECK_REPO_ALIASES
// (`basename=label,…`, wezterm-x/local/shared.env; tmux-status-lib.sh
// tmux_status_repo_display_label and workspace/runtime.lua alias_title read
// it too). The relay runs under systemd without that env, so it reads the
// repo's shared.env; none|off|0|empty shows raw basenames.

import (
	"os"
	"path/filepath"
	"strings"
)

const defaultRepoAliases = "wezterm-config=wezdeck"

func repoAliasSpec() string {
	if v, ok := os.LookupEnv("WEZDECK_REPO_ALIASES"); ok {
		return v
	}
	if root := repoRoot(); root != "" {
		if b, err := os.ReadFile(filepath.Join(root, "wezterm-x", "local", "shared.env")); err == nil {
			for _, line := range strings.Split(string(b), "\n") {
				line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "export "))
				if v, ok := strings.CutPrefix(line, "WEZDECK_REPO_ALIASES="); ok {
					return strings.Trim(v, `'"`)
				}
			}
		}
	}
	return defaultRepoAliases
}

// parseRepoAliases: basename → label; nil when aliases are off.
func parseRepoAliases(spec string) map[string]string {
	switch strings.TrimSpace(spec) {
	case "", "none", "off", "0":
		return nil
	}
	out := map[string]string{}
	for _, entry := range strings.Split(spec, ",") {
		key, value, ok := strings.Cut(entry, "=")
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		if ok && key != "" && value != "" {
			out[key] = value
		}
	}
	return out
}
