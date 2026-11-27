package main

// tmux pane helpers shared by sessions / writes / handoff: cwd, command,
// index, managed agent profile, alive.

import (
	"fmt"
	"os"
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

// A managed Agy pane may report its launcher shell while agy runs below it.
func paneHasProcess(e attentionEntry, name string) bool {
	return paneHasDescendant(e.TmuxSocket, e.TmuxPane, func(comm string) bool { return comm == name })
}

func paneHasAgentProcess(socket, pane string) bool {
	return paneHasDescendant(socket, pane, func(comm string) bool { return agentCommands[comm] })
}

// paneHasLauncherProcess reports whether a pane is still booting a managed
// agent through primary-pane-wrapper / agent-launcher / agent-resume (before
// the agent binary execs). Keeps a fresh pending-* card alive during respawn.
func paneHasLauncherProcess(e attentionEntry) bool {
	if e.TmuxPane == "" {
		return false
	}
	return paneDescendantArgs(e.TmuxSocket, e.TmuxPane, func(comm string) bool {
		return comm == "bash" || comm == "sh"
	}) != nil && paneHasLauncherArg(e.TmuxSocket, e.TmuxPane)
}

func paneHasLauncherArg(socket, pane string) bool {
	out, err := tmuxCmd(socket, "display-message", "-p", "-t", pane, "#{pane_pid}").Output()
	if err != nil {
		return false
	}
	root, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || root <= 0 {
		return false
	}
	pids := []int{root}
	for i := 0; i < len(pids) && i < 64; i++ {
		pid := pids[i]
		if raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid)); err == nil {
			cmd := strings.ReplaceAll(string(raw), "\x00", " ")
			if strings.Contains(cmd, "agent-launcher.sh") ||
				strings.Contains(cmd, "agent-resume.sh") ||
				strings.Contains(cmd, "primary-pane-wrapper.sh") {
				return true
			}
		}
		children, err := os.ReadFile(fmt.Sprintf("/proc/%d/task/%d/children", pid, pid))
		if err != nil {
			continue
		}
		for _, child := range strings.Fields(string(children)) {
			if next, err := strconv.Atoi(child); err == nil && next > 0 {
				pids = append(pids, next)
			}
		}
	}
	return false
}

// isAgentPane: true when the pane still hosts an agent TUI. Grok is started
// under grok-focus-filter.py, so pane_current_command is often "python3"
// while grok.real is the child; managed Agy panes often report "bash" while
// agy runs below it.
func isAgentPane(cmd string, e attentionEntry) bool {
	if agentCommands[cmd] {
		return true
	}
	if cmd == "bash" || cmd == "zsh" || cmd == "sh" {
		return paneHasProcess(e, "agy")
	}
	if cmd != "python3" {
		return false
	}
	if strings.EqualFold(e.AgentName, "grok") {
		return true
	}
	if _, agent := findTranscript(e.SessionID); agent == "grok" {
		return true
	}
	return false
}

// recentPaneMeta collects the newest non-empty tmux/git metadata per pane from
// recent[] so a newer phantom cleared_to stub keeps TmuxSession/WindowName/Branch.
func recentPaneMeta(recent []recentEntry) map[string]attentionEntry {
	meta := map[string]attentionEntry{}
	for _, r := range recent {
		key := r.TmuxSocket + "|" + r.TmuxPane
		if r.TmuxPane == "" || r.TmuxSession == "" {
			continue
		}
		if _, ok := meta[key]; !ok {
			meta[key] = r.attentionEntry
		}
	}
	return meta
}

func backfillRecentPaneMeta(e *attentionEntry, meta map[string]attentionEntry, key string) {
	m, ok := meta[key]
	if !ok {
		return
	}
	if e.TmuxSession == "" {
		e.TmuxSession = m.TmuxSession
	}
	if e.WindowName == "" {
		e.WindowName = m.WindowName
	}
	if e.GitBranch == "" {
		e.GitBranch = m.GitBranch
	}
}

// paneAgentFamily resolves the live agent family from pane command, managed
// profile, or wrapped Agy descendant process.
func paneAgentFamily(e attentionEntry, cmd, profile string) string {
	if agentCommands[cmd] {
		return profileFamily(strings.TrimSuffix(cmd, ".real"))
	}
	if fam := profileFamily(profile); agentCommands[fam] {
		return fam
	}
	if (cmd == "bash" || cmd == "zsh" || cmd == "sh") && paneHasProcess(e, "agy") {
		return "agy"
	}
	return ""
}

// sessionAgentFamily identifies a session's agent family from its transcript,
// live pane process/profile, or attention agent_name fallback.
func sessionAgentFamily(e attentionEntry) string {
	if _, agent := findTranscript(e.SessionID); agent != "" {
		return agent
	}
	if _, _, cmd, _, profile, alive := paneState(e); alive {
		if fam := paneAgentFamily(e, cmd, profile); fam != "" {
			return fam
		}
	}
	if fam := profileFamily(strings.ToLower(strings.TrimSpace(e.AgentName))); agentCommands[fam] {
		return fam
	}
	return ""
}

func paneHasDescendant(socket, pane string, match func(string) bool) bool {
	return paneDescendantArgs(socket, pane, match) != nil
}

// paneDescendantArgs walks processes inside pane and returns the argv of the
// first matching process (from /proc/<pid>/cmdline), or nil if none matched.
func paneDescendantArgs(socket, pane string, match func(string) bool) []string {
	out, err := tmuxCmd(socket, "display-message", "-p", "-t", pane, "#{pane_pid}").Output()
	if err != nil {
		return nil
	}
	root, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || root <= 0 {
		return nil
	}
	pids := []int{root}
	for i := 0; i < len(pids) && i < 64; i++ {
		pid := pids[i]
		comm, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
		if err == nil && match(strings.TrimSpace(string(comm))) {
			raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
			if err != nil {
				return []string{}
			}
			var argv []string
			for _, part := range strings.Split(string(raw), "\x00") {
				if part != "" {
					argv = append(argv, part)
				}
			}
			return argv
		}
		children, err := os.ReadFile(fmt.Sprintf("/proc/%d/task/%d/children", pid, pid))
		if err != nil {
			continue
		}
		for _, child := range strings.Fields(string(children)) {
			if next, err := strconv.Atoi(child); err == nil && next > 0 {
				pids = append(pids, next)
			}
		}
	}
	return nil
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
	for _, fam := range []string{"claude", "codex", "grok", "agy"} {
		if profile == fam || strings.HasPrefix(profile, fam+"_") {
			return fam
		}
	}
	return profile
}

// paneOwnsSessionAgent rejects an archived transcript from a different agent
// after a fresh cross-agent respawn. Unknown families fail open.
func paneOwnsSessionAgent(cmd, profile, archived string) bool {
	current := profileFamily(cmd)
	if !agentCommands[cmd] {
		current = profileFamily(profile)
	}
	archived = profileFamily(archived)
	return current == "" || archived == "" || !agentCommands[archived] || current == archived
}

// attachedTmuxSessions reads all attachment states with one call per socket.
// A nil map means unknown; callers must not mark those sessions detached.
func attachedTmuxSessions(socket string) map[string]bool {
	out, err := tmuxCmd(socket, "list-sessions", "-F", "#{session_name}\t#{session_attached}").Output()
	if err != nil {
		return nil
	}
	states := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.Split(line, "\t")
		if len(parts) == 2 {
			states[parts[0]] = parts[1] != "0"
		}
	}
	return states
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
