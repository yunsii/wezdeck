package main

// Writes into a session (split out of remote_session.go, 2026-11-24): the
// guards (guardSession), pasting a message into the agent's own TUI, the
// keys a web console may press, and ticket replies / attach through the
// ticket CLI. Every write is signed (remote_device_keys.go) and logged.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

func guardSession(id string) (attentionEntry, error) {
	if !sessionIDPattern.MatchString(id) {
		return attentionEntry{}, errors.New("invalid session id")
	}
	entries, err := liveSessions()
	if err != nil {
		return attentionEntry{}, err
	}
	e, ok := entries[id]
	if !ok {
		return attentionEntry{}, errors.New("session not found (ended or not tracked)")
	}
	if _, alive := paneInfo(e); !alive {
		return attentionEntry{}, errors.New("the session's tmux pane is gone")
	}
	if act := deskActivity(e); act > 0 && time.Since(time.Unix(act, 0)) < deskIdle {
		ago := time.Since(time.Unix(act, 0))
		// "retry in Ns" is parsed by the phone, which counts down and resends
		return attentionEntry{}, fmt.Errorf("someone typed at the desk %ds ago; retry in %ds",
			int(ago.Seconds()), int((deskIdle-ago).Seconds())+1)
	}
	return e, nil
}

func sendToSession(args json.RawMessage) (any, error) {
	var a struct {
		ID          string   `json:"id"`
		Text        string   `json:"text"`
		Attachments []string `json:"attachments"`
	}
	if json.Unmarshal(args, &a) != nil || len(a.Text) > 20000 ||
		(strings.TrimSpace(a.Text) == "" && len(a.Attachments) == 0) {
		return nil, errors.New("message must be 1–20000 characters")
	}
	note, err := attachmentNote(a.Attachments)
	if err != nil {
		return nil, err
	}
	if note != "" {
		a.Text = strings.TrimSpace(strings.TrimSpace(a.Text) + "\n\n" + note)
	}
	e, err := guardSession(a.ID)
	if err != nil {
		return nil, err
	}
	// No busy guard: every agent TUI we host takes input mid-turn. Claude Code
	// queues it and schedules it itself, Grok queues a follow-up for after the
	// turn (`[ui].follow_up_behavior`, default "queue"), Codex steers the
	// active turn with it. Only a pending confirmation blocks free text.
	if e.WaitingKind != "" {
		return nil, errors.New("the agent is asking for a confirmation; answer it with the keys first")
	}
	if err := pasteToPane(e.TmuxSocket, e.TmuxPane, a.Text); err != nil {
		return nil, err
	}
	_ = tmuxCmd(e.TmuxSocket, "display-message", "-d", "4000", "-t", e.TmuxPane, "网页端发来一条消息").Run()
	return map[string]any{"v": 1, "ok": true, "sent": len([]rune(a.Text))}, nil
}

// pasteToPane pastes text into a pane as one bracketed paste, then Enter —
// how the phone's messages reach an agent TUI (also a new session's first
// message, session_new.go).
func pasteToPane(socket, pane, text string) error {
	text = pasteSafe(text)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// one buffer per send: two sends in flight (two tabs, two sessions) used
	// to share "wezdeck-remote", so load(X) load(Y) paste→X could put Y's text
	// into X's pane
	buffer := "wezdeck-remote-" + newDiagID()
	load := exec.CommandContext(ctx, "tmux")
	if socket != "" {
		load.Args = append(load.Args, "-S", socket)
	}
	load.Args = append(load.Args, "load-buffer", "-b", buffer, "-")
	load.Stdin = strings.NewReader(text)
	if out, err := load.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux load-buffer: %s", strings.TrimSpace(string(out)))
	}
	if out, err := tmuxCmd(socket, "paste-buffer", "-p", "-d", "-b", buffer, "-t", pane).CombinedOutput(); err != nil {
		return fmt.Errorf("tmux paste-buffer: %s", strings.TrimSpace(string(out)))
	}
	time.Sleep(150 * time.Millisecond)
	if out, err := tmuxCmd(socket, "send-keys", "-t", pane, "Enter").CombinedOutput(); err != nil {
		return fmt.Errorf("tmux send-keys: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

func socketArgs(e attentionEntry) []string {
	if e.TmuxSocket == "" {
		return nil
	}
	return []string{"-S", e.TmuxSocket}
}

// Keys a phone may press: dialog digits, nav, interrupt (C-c — Grok and many
// TUIs only stop on Ctrl+C), Claude Code's C-b (move the running command to
// the background; send-keys bypasses tmux's C-b prefix, so one is enough),
// and Grok plan-review letters (a=approve, s=request changes, q=quit plan,
// y=copy — see Grok plan mode docs).
var allowedKeys = map[string]bool{
	"Enter": true, "Escape": true, "Up": true, "Down": true, "Tab": true,
	"1": true, "2": true, "3": true, "4": true, "C-c": true, "C-b": true,
	"a": true, "s": true, "q": true, "y": true,
}

func keyToSession(args json.RawMessage) (any, error) {
	var a struct {
		ID  string `json:"id"`
		Key string `json:"key"`
	}
	if json.Unmarshal(args, &a) != nil || !allowedKeys[a.Key] {
		return nil, errors.New("key not allowed")
	}
	e, err := guardSession(a.ID)
	if err != nil {
		return nil, err
	}
	if out, err := tmuxCmd(e.TmuxSocket, "send-keys", "-t", e.TmuxPane, a.Key).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("tmux send-keys: %s", strings.TrimSpace(string(out)))
	}
	return map[string]any{"v": 1, "ok": true}, nil
}

var ticketIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,96}$`)

var proposalIDPattern = regexp.MustCompile(`^p[0-9]{1,4}$`)

type ticketReply struct {
	ID       string `json:"id"`
	Text     string `json:"text"`
	Continue bool   `json:"continue"`
	// a fan-out split proposal on a parent (skills/agent-collab/lib/split.py):
	// the user's tap is the confirmation the CLI waits for. Riding on `reply`
	// keeps the Runtime's write allowlist (C#) unchanged; native/wezdeck-wsl
	// is the only side that maps it (web/src/features/ticket-proposals.tsx).
	Proposal string `json:"proposal"`
	Verdict  string `json:"verdict"` // approve | reject (Text = the reason)
}

// replyArgv maps a reply write to the ticket CLI argv.
func replyArgv(a ticketReply) ([]string, error) {
	if !ticketIDPattern.MatchString(a.ID) || len(a.Text) > 20000 {
		return nil, errors.New("invalid reply")
	}
	if a.Proposal != "" {
		if !proposalIDPattern.MatchString(a.Proposal) {
			return nil, errors.New("invalid proposal")
		}
		switch a.Verdict {
		case "approve":
			// the console's button is 确认并开始: approving also starts the scheduler
			return []string{"fanout", "approve", "--parent", a.ID, "--proposal", a.Proposal, "--run"}, nil
		case "reject":
			if strings.TrimSpace(a.Text) == "" {
				return nil, errors.New("rejecting a proposal needs a reason")
			}
			return []string{"fanout", "reject", "--parent", a.ID, "--proposal", a.Proposal, "--reason", a.Text}, nil
		}
		return nil, errors.New("verdict must be approve or reject")
	}
	if strings.TrimSpace(a.Text) == "" {
		return nil, errors.New("invalid reply")
	}
	argv := []string{"reply", "--id", a.ID, "--decision", a.Text}
	if a.Continue {
		argv = append(argv, "--continue")
	}
	return argv, nil
}

// replyTicket runs `ticket reply` (or a proposal verdict) as the phone's owner (via=mobile).
func replyTicket(args json.RawMessage) (any, error) {
	var a ticketReply
	if json.Unmarshal(args, &a) != nil {
		return nil, errors.New("invalid reply")
	}
	argv, err := replyArgv(a)
	if err != nil {
		return nil, err
	}
	return runTicketCLI("ticket "+argv[0], argv)
}

// attachTicket opens the ticket's agent session in a tmux window of the
// target repo (`ticket attach`, skills/agent-collab/lib/attach.py): the
// escape hatch when a tappable answer is not enough.
func attachTicket(args json.RawMessage) (any, error) {
	var a struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(args, &a) != nil || !ticketIDPattern.MatchString(a.ID) {
		return nil, errors.New("invalid attach")
	}
	return runTicketCLI("ticket attach", []string{"attach", "--id", a.ID})
}

// runTicketCLI runs skills/agent-collab/ticket and returns its last JSON line.
func runTicketCLI(label string, args []string) (any, error) {
	argv := append([]string{filepath.Join(repoRoot(), "skills", "agent-collab", "ticket")}, args...)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = append(os.Environ(), "TICKET_TRIGGER_SOURCE=mobile")
	out, err := cmd.CombinedOutput()
	last := strings.TrimSpace(string(out))
	if i := strings.LastIndexByte(last, '\n'); i >= 0 {
		last = last[i+1:]
	}
	if err != nil {
		// attach prints {"ok":false,"error":…} on stdout; surface just the reason
		var failed struct {
			Error string `json:"error"`
		}
		if json.Unmarshal([]byte(last), &failed) == nil && failed.Error != "" {
			last = failed.Error
		}
		return nil, fmt.Errorf("%s: %s", label, clip(last, 300))
	}
	var result any
	if json.Unmarshal([]byte(last), &result) != nil {
		result = map[string]any{"v": 1, "ok": true}
	}
	return result, nil
}
