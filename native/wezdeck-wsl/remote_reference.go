package main

// A session reference for agents (the phone's 复制引用 on a session page):
// a short block another agent can act on without asking — which agent and
// session, where its transcript is (read the conversation), where it runs
// (cwd / branch), and its tmux pane (capture-pane to see the screen,
// send-keys / paste-buffer to type into it).

import (
	"fmt"
	"os"
	"strings"
)

func sessionReference(e attentionEntry, transcript, agent string) string {
	_, cwd, _, _, _, _ := paneState(e)
	return sessionReferenceWithCwd(e, transcript, agent, cwd)
}

func sessionReferenceWithCwd(e attentionEntry, transcript, agent, cwd string) string {
	home, _ := os.UserHomeDir()
	short := func(p string) string {
		if home != "" && strings.HasPrefix(p, home+"/") {
			return "~" + p[len(home):]
		}
		return p
	}
	name := e.AgentName
	if title := resolveSessionTitle(e.SessionID, transcript, agent); title != "" {
		name = title
	}
	if name == "" {
		name = e.WindowName
	}
	if agent == "" {
		agent = "agent"
	}
	lines := []string{fmt.Sprintf("[wezdeck 会话] %s（%s）", name, agent),
		"session_id: " + e.SessionID}
	if transcript != "" {
		lines = append(lines, "transcript: "+short(transcript))
	}
	if cwd != "" {
		where := "cwd: " + short(cwd)
		if e.GitBranch != "" {
			where += "（分支 " + e.GitBranch + "）"
		}
		lines = append(lines, where)
	}
	if e.TmuxPane != "" {
		pane := "tmux: "
		if e.TmuxSocket != "" {
			pane += "-S " + e.TmuxSocket + " "
		}
		pane += "-t " + e.TmuxPane
		if e.TmuxSession != "" {
			pane += "（会话 " + e.TmuxSession + "）"
		}
		lines = append(lines, pane)
	}
	return strings.Join(lines, "\n")
}
