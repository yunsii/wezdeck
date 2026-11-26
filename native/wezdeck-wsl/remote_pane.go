package main

// tmux pane helpers shared by sessions / writes / handoff: cwd, command,
// index, managed agent profile, alive.

import (
	"os/exec"
	"strconv"
	"strings"
)

func tmuxCmd(socket string, args ...string) *exec.Cmd {
	full := args
	if socket != "" {
		full = append([]string{"-S", socket}, args...)
	}
	return exec.Command("tmux", full...)
}

// paneState: the pane's id, cwd, current command, index, managed profile, and
// whether it exists. Profile comes from @wezterm_agent_profile (pane), else
// @wezterm_window_agent_profile (window sticky after handoff).
func paneState(e attentionEntry) (id, cwd, cmd string, index int, profile string, alive bool) {
	if e.TmuxPane == "" {
		return "", "", "", 0, "", false
	}
	out, err := tmuxCmd(e.TmuxSocket, "display-message", "-p", "-t", e.TmuxPane,
		"#{pane_id}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_index}\t#{@wezterm_agent_profile}\t#{@wezterm_window_agent_profile}").Output()
	if err != nil {
		return "", "", "", 0, "", false
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), "\t", 6)
	if len(parts) < 4 || parts[0] != e.TmuxPane {
		return "", "", "", 0, "", false
	}
	index, _ = strconv.Atoi(parts[3])
	if len(parts) > 4 {
		profile = normalizeAgentProfile(parts[4])
	}
	if profile == "" && len(parts) > 5 {
		profile = normalizeAgentProfile(parts[5])
	}
	return parts[0], parts[1], parts[2], index, profile, true
}

func normalizeAgentProfile(raw string) string {
	raw = strings.TrimSpace(strings.ToLower(raw))
	raw = strings.TrimSuffix(strings.TrimSuffix(raw, "-resume"), "_resume")
	raw = strings.ReplaceAll(raw, "-", "_")
	if raw == "" || raw == "default" {
		return ""
	}
	return raw
}

// windowActivity: last output in the session's tmux window (unix ms), 0 if unknown.
func windowActivity(e attentionEntry) int64 {
	out, err := tmuxCmd(e.TmuxSocket, "display-message", "-p", "-t", e.TmuxPane, "#{window_activity}").Output()
	if err != nil {
		return 0
	}
	v, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return 0
	}
	return v * 1000
}

// paneInfo: cwd and whether the pane still exists.
func paneInfo(e attentionEntry) (cwd string, alive bool) {
	_, cwd, _, _, _, alive = paneState(e)
	return cwd, alive
}

