package main

// Top-level Ticket Manager Session bridge (`collab_manager.go`):
//   - `collab.manager.chat {id, limit?, since?, before?}` (read):
//     Reads a ticket's Manager Session conversation whether live OR parked
//     (no 3-minute archive expiry), backfilling `manager_session.id` when a
//     live attention entry reports the real agent session id on its pane.
//   - `ticket.manager.start {id, profile?}` (write):
//     Starts or resumes the repo-neutral Manager Session via `manager.py`.
//   - `ticket.manager.park {id, force?}` (write):
//     Safely parks an idle Manager Session via `manager.py`.
//   - `ticket.manager.send {id, text, attachments?}` (write):
//     Auto-wakes a parked Manager Session if needed, then pastes text cleanly
//     into its tmux pane.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type managerSessionMeta struct {
	Backend     string `json:"backend"`
	Profile     string `json:"profile"`
	ID          string `json:"id"`
	Cwd         string `json:"cwd"`
	TmuxSession string `json:"tmux_session"`
	TmuxWindow  string `json:"tmux_window"`
	TmuxPane    string `json:"tmux_pane"`
	State       string `json:"state"` // live | parked
	UpdatedAt   string `json:"updated_at"`
}

func ticketIDFromCwd(cwd string) string {
	if cwd == "" {
		return ""
	}
	wsRoot := filepath.Clean(filepath.Join(ticketsRootDir(), "workspaces")) + string(filepath.Separator)
	clean := filepath.Clean(cwd)
	if !strings.HasPrefix(clean, wsRoot) {
		return ""
	}
	rest := strings.TrimPrefix(clean, wsRoot)
	seg := strings.SplitN(rest, string(filepath.Separator), 2)[0]
	if collabTicketIDRe.MatchString(seg) {
		return seg
	}
	return ""
}

func ticketIDForSession(e attentionEntry, cwd string) string {
	if id := ticketIDFromCwd(cwd); id != "" {
		return id
	}
	if e.TmuxPane != "" && e.TmuxSession == "wezterm_collab_tickets" {
		if out, err := tmuxCmd(e.TmuxSocket, "display-message", "-p", "-t", e.TmuxPane, "#{@wezdeck_ticket_id}").Output(); err == nil {
			val := strings.TrimSpace(string(out))
			if collabTicketIDRe.MatchString(val) {
				return val
			}
		}
	}
	return ""
}

func readManagerMeta(tid string) (*managerSessionMeta, error) {
	p := filepath.Join(ticketsRootDir(), "_data", tid, "meta.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var doc struct {
		ManagerSession *managerSessionMeta `json:"manager_session"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	return doc.ManagerSession, nil
}

func backfillManagerSessionID(tid, sessionID string) {
	if tid == "" || sessionID == "" || !sessionIDPattern.MatchString(sessionID) {
		return
	}
	p := filepath.Join(ticketsRootDir(), "_data", tid, "meta.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		return
	}
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return
	}
	ms, _ := doc["manager_session"].(map[string]any)
	if ms == nil || ms["id"] == sessionID {
		return
	}
	ms["id"] = sessionID
	ms["updated_at"] = time.Now().UTC().Format(time.RFC3339)
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return
	}
	tmp := p + ".tmp"
	if os.WriteFile(tmp, append(out, '\n'), 0o644) == nil {
		_ = os.Rename(tmp, p)
	}
}

func collabManagerChat(args json.RawMessage) (any, error) {
	started := time.Now()
	var a struct {
		ID     string `json:"id"`
		Limit  int    `json:"limit"`
		Since  *int   `json:"since"`
		Before *int   `json:"before"`
	}
	if json.Unmarshal(args, &a) != nil || !collabTicketIDRe.MatchString(a.ID) {
		return nil, errors.New("invalid ticket id")
	}

	ms, err := readManagerMeta(a.ID)
	if err != nil {
		return nil, errors.New("ticket not found")
	}
	if ms == nil {
		return map[string]any{
			"v":        1,
			"ok":       true,
			"id":       a.ID,
			"state":    "none",
			"messages": []chatMessage{},
			"total":    0,
			"start":    0,
			"span":     "full",
		}, nil
	}

	sessionID := ms.ID
	status := "parked"
	waitingKind := ""
	runningKind := ""
	state := ms.State
	if state == "" {
		state = "parked"
	} else if state == "live" && !managerPaneActive(a.ID, ms) {
		state = "parked"
	}

	// Cross-reference live attention entries by tmux_pane or cwd to get live status & session_id.
	if state == "live" {
		live, lerr := liveSessions()
		if lerr == nil {
			for sid, e := range live {
				if ms.TmuxPane != "" && e.TmuxPane == ms.TmuxPane {
					sessionID = sid
					status = e.Status
					waitingKind = e.WaitingKind
					runningKind = e.RunningKind
					state = "live"
					if ms.ID != sid {
						backfillManagerSessionID(a.ID, sid)
					}
					break
				}
			}
		}
	}

	var msgs []chatMessage
	backend := ms.Backend
	if sessionID != "" {
		if path, agent := findTranscript(sessionID); path != "" {
			if tr, loadErr := loadTranscript(path, agent); loadErr == nil {
				msgs = tr.messages
				if backend == "" {
					backend = agent
				}
			}
		}
	}

	if a.Limit <= 0 {
		a.Limit = 80
	}
	start, end, span := sessionWindow(msgs, sessionArgs{
		ID:     a.ID,
		Limit:  a.Limit,
		Since:  a.Since,
		Before: a.Before,
	})
	page := msgs[start:end]
	if page == nil {
		page = []chatMessage{}
	}

	relayLogf("collab_manager_chat", "id=%s state=%s status=%s total=%d ms=%d",
		a.ID, state, status, len(msgs), time.Since(started).Milliseconds())

	return map[string]any{
		"v":            1,
		"ok":           true,
		"id":           a.ID,
		"state":        state,
		"backend":      backend,
		"profile":      ms.Profile,
		"session_id":   sessionID,
		"status":       status,
		"waiting_kind": waitingKind,
		"running_kind": runningKind,
		"tmux_session": ms.TmuxSession,
		"tmux_pane":    ms.TmuxPane,
		"cwd":          ms.Cwd,
		"messages":     page,
		"total":        len(msgs),
		"start":        start,
		"span":         span,
	}, nil
}

func runManagerCLI(subcmd string, extraArgs ...string) (map[string]any, error) {
	root := repoRoot()
	if root == "" {
		return nil, errors.New("repo root is empty")
	}
	script := filepath.Join(root, "skills", "agent-collab", "lib", "manager.py")
	if _, err := os.Stat(script); err != nil {
		return nil, fmt.Errorf("manager.py missing: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmdArgs := append([]string{script, subcmd}, extraArgs...)
	cmd := exec.CommandContext(ctx, "python3", cmdArgs...)
	cmd.Env = append(os.Environ(), "TICKET_RUNTIME_LOG=0", "WEZDECK_REPO="+root)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = strings.TrimSpace(stdout.String())
		}
		if detail == "" {
			detail = err.Error()
		}
		return nil, errors.New(detail)
	}
	var res map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &res); err != nil {
		return nil, err
	}
	return res, nil
}

func managerPaneActive(id string, ms *managerSessionMeta) bool {
	if ms == nil || ms.State != "live" || ms.TmuxPane == "" {
		return false
	}
	out, err := tmuxCmd("", "display-message", "-p", "-t", ms.TmuxPane,
		"#{@wezdeck_ticket_id}\t#{pane_current_command}").Output()
	if err != nil {
		return false
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), "\t", 2)
	return len(parts) == 2 && parts[0] == id &&
		(agentCommands[parts[1]] || paneHasAgentProcess("", ms.TmuxPane))
}

func resolveManagerProfile(requested string) (string, error) {
	profile := requested
	if profile == "" {
		profile = activeAgentProfile()
	}
	if !collabValue.MatchString(profile) || !registeredAgentProfile(profile) {
		return "", errors.New("invalid manager agent profile")
	}
	disabled, err := agentProfileDisabled(profile)
	if err != nil {
		return "", errors.New("cannot read manager agent settings")
	}
	if disabled {
		return "", fmt.Errorf("manager agent %s is disabled", profile)
	}
	return profile, nil
}

func startManagerAndWait(id, profile, sub string) (any, error) {
	res, err := runManagerCLI(sub, "--id", id, "--profile", profile)
	if err != nil {
		return nil, err
	}
	ms, err := readManagerMeta(id)
	if err != nil || ms == nil || ms.TmuxPane == "" {
		return nil, errors.New("manager session did not create a pane")
	}
	info, readyErr := waitAgentReadyDetailed("", ms.TmuxPane, 30*time.Second)
	if readyErr == nil && info.HasAgent && managerPaneActive(id, ms) {
		return res, nil
	}
	_, _ = runManagerCLI("park", "--id", id, "--force")
	if readyErr != nil {
		return nil, fmt.Errorf("manager agent failed to start: %w", readyErr)
	}
	return nil, errors.New("manager agent failed to start")
}

func startTicketManager(args json.RawMessage) (any, error) {
	var a struct {
		ID      string `json:"id"`
		Profile string `json:"profile"`
		Resume  bool   `json:"resume"`
	}
	if json.Unmarshal(args, &a) != nil || !collabTicketIDRe.MatchString(a.ID) {
		return nil, errors.New("invalid ticket id")
	}
	profile, err := resolveManagerProfile(a.Profile)
	if err != nil {
		return nil, err
	}
	if ms, err := readManagerMeta(a.ID); err == nil && ms != nil && ms.State == "live" {
		if managerPaneActive(a.ID, ms) {
			return map[string]any{"ok": true, "id": a.ID, "action": "already_live", "manager_session": ms}, nil
		}
		if _, err := runManagerCLI("park", "--id", a.ID, "--force"); err != nil {
			return nil, err
		}
	}
	sub := "start"
	if a.Resume {
		sub = "resume"
	} else if ms, err := readManagerMeta(a.ID); err == nil && ms != nil && ms.State == "parked" {
		sub = "resume"
	}
	return startManagerAndWait(a.ID, profile, sub)
}

func parkTicketManager(args json.RawMessage) (any, error) {
	var a struct {
		ID    string `json:"id"`
		Force bool   `json:"force"`
	}
	if json.Unmarshal(args, &a) != nil || !collabTicketIDRe.MatchString(a.ID) {
		return nil, errors.New("invalid ticket id")
	}
	cliArgs := []string{"--id", a.ID}
	if a.Force {
		cliArgs = append(cliArgs, "--force")
	}
	return runManagerCLI("park", cliArgs...)
}

func sendTicketManager(args json.RawMessage) (any, error) {
	var a struct {
		ID          string   `json:"id"`
		Text        string   `json:"text"`
		Attachments []string `json:"attachments"`
		Profile     string   `json:"profile"`
	}
	if json.Unmarshal(args, &a) != nil || !collabTicketIDRe.MatchString(a.ID) {
		return nil, errors.New("invalid ticket id")
	}
	text := strings.TrimSpace(a.Text)
	if text == "" && len(a.Attachments) == 0 {
		return nil, errors.New("message text is empty")
	}
	ms, err := readManagerMeta(a.ID)
	if err != nil {
		return nil, errors.New("ticket not found")
	}
	woke := false
	if !managerPaneActive(a.ID, ms) {
		profile, err := resolveManagerProfile(a.Profile)
		if err != nil {
			return nil, err
		}
		if ms != nil && ms.State == "live" {
			if _, err := runManagerCLI("park", "--id", a.ID, "--force"); err != nil {
				return nil, err
			}
		}
		sub := "start"
		if ms != nil {
			sub = "resume"
		}
		if _, err := startManagerAndWait(a.ID, profile, sub); err != nil {
			return nil, err
		}
		woke = true
		ms, err = readManagerMeta(a.ID)
		if err != nil || ms == nil || ms.TmuxPane == "" {
			return nil, errors.New("manager session failed to expose tmux pane")
		}
	}

	payloadText := text
	if len(a.Attachments) > 0 {
		var lines []string
		for i, name := range a.Attachments {
			if p, ok := resolveUploadPath(name); ok {
				lines = append(lines, fmt.Sprintf("图片%d: %s", i+1, p))
			}
		}
		if len(lines) > 0 {
			note := "[网页附件]\n" + strings.Join(lines, "\n")
			if payloadText != "" {
				payloadText += "\n\n" + note
			} else {
				payloadText = note
			}
		}
	}

	bufName := fmt.Sprintf("wd-mgr-%d", time.Now().UnixNano())
	load := tmuxCmd("", "load-buffer", "-b", bufName, "-")
	load.Stdin = strings.NewReader(payloadText)
	if out, err := load.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("tmux load-buffer: %s", strings.TrimSpace(string(out)))
	}
	defer func() { _ = tmuxCmd("", "delete-buffer", "-b", bufName).Run() }()
	if !managerPaneActive(a.ID, ms) {
		return nil, errors.New("manager agent exited before the message was sent")
	}
	if out, err := tmuxCmd("", "paste-buffer", "-p", "-b", bufName, "-t", ms.TmuxPane).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("tmux paste-buffer: %s", strings.TrimSpace(string(out)))
	}
	if out, err := tmuxCmd("", "send-keys", "-t", ms.TmuxPane, "Enter").CombinedOutput(); err != nil {
		return nil, fmt.Errorf("tmux send-keys: %s", strings.TrimSpace(string(out)))
	}

	return map[string]any{
		"ok":        true,
		"id":        a.ID,
		"tmux_pane": ms.TmuxPane,
		"woke":      woke,
	}, nil
}

func resolveUploadPath(name string) (string, bool) {
	if name == "" || strings.Contains(name, "/") || strings.Contains(name, "..") {
		return "", false
	}
	p := filepath.Join(uploadDir(), name)
	if st, err := os.Stat(p); err == nil && !st.IsDir() {
		return p, true
	}
	return "", false
}
