package main

import (
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func canRecoverCodex(e attentionEntry, p tmuxPaneSnap) bool {
	return sessionIDPattern.MatchString(e.SessionID) && !isPendingSessionID(e.SessionID) &&
		p.id != "" && p.pid > 0 && p.session == e.TmuxSession &&
		p.agentSessionID == e.SessionID && shells[p.cmd] && !paneHasLauncherArgFromPID(p.pid)
}

// Only the tracked, pinned shell is eligible. The tmux conditional checks
// the shell again in the same command queue that replaces it.
func recoverCodexSession(id string) (any, error) {
	active, recent, err := readAttentionDoc()
	if err != nil {
		return nil, err
	}
	entries, snap, closed := liveSessionsWithContext(active, recent)
	e := entries[id]
	pane := snap[e.TmuxSocket+"|"+e.TmuxPane]
	if closed[id] || !canRecoverCodex(e, pane) {
		return nil, errors.New("the original Codex pane is unavailable for recovery")
	}
	unlock, err := lockSessionWorktree(pane.cwd)
	if err != nil {
		return nil, err
	}
	defer unlock()
	if _, agent := findTranscript(id); agent != "codex" {
		return nil, errors.New("the original Codex transcript is unavailable")
	}
	if act := deskActivity(e); act > 0 && time.Since(time.Unix(act, 0)) < deskIdle {
		return nil, errors.New("someone just used this terminal; try again in a moment")
	}

	runtime := filepath.Join(repoRoot(), "scripts", "runtime")
	condition := fmt.Sprintf("#{&&:#{==:#{pane_pid},%d},#{&&:#{==:#{pane_current_command},%s},#{==:#{@wezterm_agent_session_id},%s}}}", pane.pid, pane.cmd, id)
	command := fmt.Sprintf("respawn-pane -k -t %s -e %s -e WEZDECK_FORCE_FRESH_SESSION=0 bash %s bash %s codex",
		pane.id, strconv.Quote("WEZDECK_RESUME_SESSION_ID="+id),
		strconv.Quote(filepath.Join(runtime, "primary-pane-wrapper.sh")),
		strconv.Quote(filepath.Join(runtime, "agent-launcher.sh")))
	out, err := tmuxCmd(e.TmuxSocket, "if-shell", "-F", "-t", pane.id, condition,
		command, "display-message -p recovery_target_changed").CombinedOutput()
	if err != nil || strings.Contains(string(out), "recovery_target_changed") {
		relayLogf("session_recover", "id=%s pane=%s outcome=target_unavailable", id, pane.id)
		return nil, errors.New("the terminal changed before recovery could start")
	}
	relayLogf("session_recover", "id=%s pane=%s outcome=launched", id, pane.id)
	ready, readyErr := waitAgentReadyDetailed(e.TmuxSocket, pane.id, 8*time.Second)
	_, _, cmd, _, _, alive := paneState(e)
	if readyErr == nil && ready.Reason == "tui_ready" && ready.HasAgent &&
		alive && cmd == "codex" {
		relayLogf("session_recover", "id=%s pane=%s outcome=ready duration_ms=%d",
			id, pane.id, ready.Duration.Milliseconds())
		return map[string]any{"v": 1, "ok": true, "id": id}, nil
	}
	relayLogf("session_recover", "id=%s pane=%s outcome=unconfirmed command=%s reason=%s duration_ms=%d",
		id, pane.id, cmd, ready.Reason, ready.Duration.Milliseconds())
	return nil, errors.New("Codex did not become ready in the original terminal")
}
