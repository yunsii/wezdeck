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
// whether it exists. The display profile prefers the most specific of:
// pane role (agent-cli:claude_kimi), window sticky (@wezterm_window_agent_profile),
// and pane pin (@wezterm_agent_profile). The pane pin is often the bare family
// (claude) after agent-session-resolve normalizes; the window/role keep the
// variant (claude_kimi) the web avatar badge needs.
func paneState(e attentionEntry) (id, cwd, cmd string, index int, profile string, alive bool) {
	if e.TmuxPane == "" {
		return "", "", "", 0, "", false
	}
	out, err := tmuxCmd(e.TmuxSocket, "display-message", "-p", "-t", e.TmuxPane,
		"#{pane_id}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_index}\t#{@wezterm_agent_profile}\t#{@wezterm_window_agent_profile}\t#{@wezterm_pane_role}").Output()
	if err != nil {
		return "", "", "", 0, "", false
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), "\t", 7)
	if len(parts) < 4 || parts[0] != e.TmuxPane {
		return "", "", "", 0, "", false
	}
	index, _ = strconv.Atoi(parts[3])
	paneProfile, windowProfile, paneRole := "", "", ""
	if len(parts) > 4 {
		paneProfile = normalizeAgentProfile(parts[4])
	}
	if len(parts) > 5 {
		windowProfile = normalizeAgentProfile(parts[5])
	}
	if len(parts) > 6 {
		paneRole = parts[6]
	}
	profile = pickManagedAgentProfile(paneProfile, windowProfile, paneRole)
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

func profileFamily(profile string) string {
	for _, fam := range []string{"claude", "codex", "grok"} {
		if profile == fam || strings.HasPrefix(profile, fam+"_") {
			return fam
		}
	}
	return profile
}

// pickManagedAgentProfile: among pane pin, window sticky, and agent-cli role,
// keep the most specific id in the same family (claude_kimi over claude).
func pickManagedAgentProfile(paneProfile, windowProfile, paneRole string) string {
	roleProfile := ""
	if strings.HasPrefix(paneRole, "agent-cli:") {
		roleProfile = normalizeAgentProfile(strings.TrimPrefix(paneRole, "agent-cli:"))
	}
	best := ""
	for _, cand := range []string{roleProfile, windowProfile, paneProfile} {
		if cand == "" {
			continue
		}
		if best == "" {
			best = cand
			continue
		}
		if profileFamily(cand) != profileFamily(best) {
			continue
		}
		if len(cand) > len(best) {
			best = cand
		}
	}
	return best
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

