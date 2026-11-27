package main

// Writes into a session (split out of remote_session.go, 2026-11-24): the
// guards (guardSession), pasting a message into the agent's own TUI, the
// keys a web console may press, and ticket replies / attach through the
// ticket CLI. Every write is signed (remote_device_keys.go) and logged.

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
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
	_, _, cmd, _, _, alive := paneState(e)
	if !alive {
		return attentionEntry{}, errors.New("the session's tmux pane is gone")
	}
	if strings.EqualFold(e.AgentName, "codex") && cmd != "codex" {
		relayLogf("codex_pane", "outcome=unavailable id=%s pane=%s", id, e.TmuxPane)
		return attentionEntry{}, errors.New("the session's Codex pane is unavailable")
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
	return sendToSessionWithMeta(args, "", "", "")
}

func sendToSessionWithMeta(args json.RawMessage, via, device, clientOp string) (any, error) {
	var a struct {
		ID          string   `json:"id"`
		Text        string   `json:"text"`
		Attachments []string `json:"attachments"`
		ClientOp    string   `json:"client_op"`
	}
	if json.Unmarshal(args, &a) != nil || len(a.Text) > 20000 ||
		(strings.TrimSpace(a.Text) == "" && len(a.Attachments) == 0) {
		return nil, errors.New("message must be 1–20000 characters")
	}
	if clientOp == "" && clientOpPattern.MatchString(a.ClientOp) {
		clientOp = a.ClientOp
	}
	rawText := strings.TrimSpace(a.Text)
	rawAttachments := append([]string(nil), a.Attachments...)
	note, err := attachmentNote(a.Attachments)
	if err != nil {
		return nil, err
	}
	if note != "" {
		a.Text = strings.TrimSpace(rawText + "\n\n" + note)
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
	trimmed := strings.TrimSpace(a.Text)
	var sentID string
	if !isSlashCommand(rawText) {
		repoKey, repoLabel, worktree := sessionRepoMeta(e)
		rec, deduped := outboxRecordStart(sentRecord{
			ClientOp:            clientOp,
			Kind:                "message",
			SessionID:           a.ID,
			RepoKey:             repoKey,
			RepoLabel:           repoLabel,
			Worktree:            worktree,
			Agent:               sessionAgentFamily(e),
			Pane:                e.TmuxPane,
			Text:                rawText,
			Attachments:         rawAttachments,
			Via:                 via,
			Device:              device,
			Status:              "pasting",
			TranscriptEndAtSend: sessionTranscriptLen(e),
		})
		if deduped {
			relayLogf("outbox_record", "id=%s op_id=%s session=%s kind=message chars=%d attachments=%d status=%s deduped=true",
				rec.ID, clientOp, a.ID, len([]rune(rawText)), len(rawAttachments), rec.Status)
			return map[string]any{"v": 1, "ok": true, "sent": len([]rune(a.Text)), "deduped": true, "sent_id": rec.ID}, nil
		}
		sentID = rec.ID
	}
	if err := pasteToPane(e.TmuxSocket, e.TmuxPane, a.Text); err != nil {
		if sentID != "" {
			_, _ = outboxUpdate(sentID, func(r *sentRecord) {
				r.Status = "failed"
				r.Error = clip(err.Error(), 300)
			})
			relayLogf("outbox_record", "id=%s op_id=%s session=%s kind=message chars=%d attachments=%d status=failed deduped=false",
				sentID, clientOp, a.ID, len([]rune(rawText)), len(rawAttachments))
		}
		return nil, err
	}
	if sentID != "" {
		_, _ = outboxUpdate(sentID, func(r *sentRecord) {
			r.Status = "pending"
		})
		relayLogf("outbox_record", "id=%s op_id=%s session=%s kind=message chars=%d attachments=%d status=pending deduped=false",
			sentID, clientOp, a.ID, len([]rune(rawText)), len(rawAttachments))
	}
	if renamed, ok := strings.CutPrefix(trimmed, "/rename "); ok {
		if renamed = strings.TrimSpace(renamed); renamed != "" {
			lockSessionTitle(a.ID, e.AgentName, renamed)
		}
	}
	reply := map[string]any{"v": 1, "ok": true, "sent": len([]rune(a.Text))}
	if sentID != "" {
		reply["sent_id"] = sentID
	}
	if strings.EqualFold(trimmed, "/new") && sessionAgentFamily(e) == "agy" {
		if pendingID := markAgyNewConversation(e); pendingID != "" {
			reply["session_id"] = pendingID
			relayLogf("session_new_conv", "id=%s agent=agy pane=%s pending=%s", a.ID, e.TmuxPane, pendingID)
		}
	}
	_ = tmuxCmd(e.TmuxSocket, "display-message", "-d", "4000", "-t", e.TmuxPane, "网页端发来一条消息").Run()
	return reply, nil
}

func newUUIDv4() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return newDiagID()
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// markAgyNewConversation unpins typed resume and marks the pane's archived
// attention row cleared_to a temporary pending-<uuid> id right after `/new`.
// Agy only allocates a real conversationId and fires SessionStart when the
// first user prompt is submitted, so without this placeholder the web console
// stays stuck on the previous conversation until a message is sent.
func markAgyNewConversation(e attentionEntry) string {
	if e.TmuxPane == "" {
		return ""
	}
	resolveScript := filepath.Join(repoRoot(), "scripts", "runtime", "agent-session-resolve.sh")
	stateScript := filepath.Join(repoRoot(), "scripts", "runtime", "attention-state-lib.sh")
	if _, err := os.Stat(stateScript); err != nil {
		return ""
	}
	pendingID := "pending-" + newUUIDv4()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "bash", "-c", `
		resolve_lib="$1"; state_lib="$2"; sock="$3"; sess="$4"; pane="$5"; pending="$6"; old_sid="$7"
		if [[ -f "$resolve_lib" ]]; then
			source "$resolve_lib" 2>/dev/null || true
			prev_sid="$(agent_session_resolve_for_pane "$pane" 2>/dev/null || true)"
			agent_session_unpin_pane "$pane" "" 2>/dev/null || true
			if [[ -n "$prev_sid" ]]; then
				tmux set-option -p -t "$pane" -q @wezterm_agent_discarded_session_id "$prev_sid" 2>/dev/null || true
			fi
		fi
		if [[ -z "$sess" && -n "$pane" ]]; then
			sess="$(tmux display-message -p -t "$pane" '#{session_name}' 2>/dev/null || true)"
		fi
		source "$state_lib"
		attention_state_evict_session "$sock" "$sess" "$pending" "$pane" 2>/dev/null || true
		attention_mark_cleared "$sock" "$pane" "$pending" "$old_sid" "$sess" 2>/dev/null || true
	`, "agy-new-conv", resolveScript, stateScript, e.TmuxSocket, e.TmuxSession, e.TmuxPane, pendingID, e.SessionID)
	cmd.Env = os.Environ()
	if e.TmuxSocket != "" {
		cmd.Env = append(cmd.Env, "TMUX="+e.TmuxSocket+",0,0")
	}
	if p := os.Getenv("WEZDECK_ATTENTION_FILE"); p != "" {
		cmd.Env = append(cmd.Env, "WEZDECK_ATTENTION_STATE_PATH="+p, "WEZTERM_ATTENTION_LOCK_FILE="+p+".lock")
	}
	if err := cmd.Run(); err != nil {
		return ""
	}
	return pendingID
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

// Keys a phone may press: dialog digits (Grok has up to nine, plus Space to
// toggle options beyond those shortcuts), nav, interrupt (C-c — Grok and many
// TUIs only stop on Ctrl+C), Claude Code's C-b (move the running command to
// the background; send-keys bypasses tmux's C-b prefix, so one is enough),
// and Grok plan-review letters (a=approve, s=request changes, q=quit plan,
// y=copy — see Grok plan mode docs).
var allowedKeys = map[string]bool{
	"Enter": true, "Escape": true, "Space": true, "Up": true, "Down": true, "Tab": true,
	"1": true, "2": true, "3": true, "4": true, "5": true, "6": true,
	"7": true, "8": true, "9": true, "C-c": true, "C-b": true,
	"a": true, "s": true, "q": true, "y": true,
}

func keyToSession(args json.RawMessage) (any, error) {
	var a struct {
		ID        string `json:"id"`
		Key       string `json:"key"`
		Interrupt bool   `json:"interrupt"`
	}
	if json.Unmarshal(args, &a) != nil || !allowedKeys[a.Key] {
		return nil, errors.New("key not allowed")
	}
	e, err := guardSession(a.ID)
	if err != nil {
		return nil, err
	}
	if a.Key == "C-c" && a.Interrupt {
		return interruptSession(e)
	}
	return sendSessionKey(e, a.Key)
}

func sendSessionKey(e attentionEntry, key string) (any, error) {
	if out, err := tmuxCmd(e.TmuxSocket, "send-keys", "-t", e.TmuxPane, key).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("tmux send-keys: %s", strings.TrimSpace(string(out)))
	}
	return map[string]any{"v": 1, "ok": true}, nil
}

var ticketIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,96}$`)

var proposalIDPattern = regexp.MustCompile(`^p[0-9]{1,4}$`)
var proposalKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
var allowedProposalBackends = map[string]bool{"claude": true, "codex": true, "grok": true}

type ticketReply struct {
	ID       string `json:"id"`
	Text     string `json:"text"`
	Continue bool   `json:"continue"`
	// a fan-out split proposal on a parent (skills/agent-collab/lib/split.py):
	// the user's tap is the confirmation the CLI waits for. Riding on `reply`
	// keeps the Runtime's write allowlist (C#) unchanged; native/wezdeck-wsl
	// is the only side that maps it (web/src/features/ticket-proposals.tsx).
	Proposal string            `json:"proposal"`
	Verdict  string            `json:"verdict"`  // approve | reject (Text = the reason)
	Backends map[string]string `json:"backends"` // optional per-item backend override (key -> claude|codex|grok)
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
			argv := []string{"fanout", "approve", "--parent", a.ID, "--proposal", a.Proposal, "--run"}
			if len(a.Backends) > 0 {
				var pairs []string
				for k, v := range a.Backends {
					if !proposalKeyPattern.MatchString(k) || !allowedProposalBackends[v] {
						return nil, errors.New("invalid proposal backend override")
					}
					pairs = append(pairs, k+"="+v)
				}
				sort.Strings(pairs)
				argv = append(argv, "--backends", strings.Join(pairs, ","))
			}
			return argv, nil
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
