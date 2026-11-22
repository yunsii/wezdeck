package main

// Remote interaction with agent sessions (docs/remote-access.md "Sessions"):
// read the live agents from attention.json, render a Claude transcript (or
// a tmux screen tail), and write into a session under guards:
//
//   - one writer: a tmux-hosted session only ever receives a paste into its
//     own TUI (never a second process resuming the same session id);
//   - mid-turn only for Claude Code (it queues input itself); other agents
//     once the turn is over or only background tasks are left;
//   - not while someone typed at the desk in the last DeskIdle seconds;
//   - every write is signed by an approved device key (ECDSA P-256, the
//     private key never leaves the phone) — Cloudflare cannot forge one;
//   - every write is logged (category=relay event=write).

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const deskIdle = 30 * time.Second

type attentionEntry struct {
	SessionID      string `json:"session_id"`
	TmuxSocket     string `json:"tmux_socket"`
	TmuxSession    string `json:"tmux_session"`
	TmuxPane       string `json:"tmux_pane"`
	Status         string `json:"status"`
	WaitingKind    string `json:"waiting_kind"`
	Reason         string `json:"reason"`
	GitBranch      string `json:"git_branch"`
	TS             int64  `json:"ts"`
	LastUserPrompt string `json:"last_user_prompt"`
	AgentName      string `json:"agent_name"`
	WindowName     string `json:"tmux_window_name"`
	// running_kind=background: the turn ended but harness background tasks
	// (bg.tasks) are still alive — the TUI takes input (agent-attention.md
	// "Background running substate").
	RunningKind string `json:"running_kind"`
	Bg          struct {
		Tasks []bgTask `json:"tasks"`
	} `json:"bg"`
}

type bgTask struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Summary string `json:"summary"`
}

// busy: the agent is mid-turn (not just waiting on background tasks).
func (e attentionEntry) busy() bool {
	return e.Status == "running" && e.RunningKind != "background"
}

func attentionFile() string {
	if p := os.Getenv("WEZDECK_ATTENTION_FILE"); p != "" {
		return p
	}
	matches, _ := filepath.Glob("/mnt/c/Users/*/AppData/Local/wezterm-runtime/state/agent-attention/attention.json")
	if len(matches) > 0 {
		return matches[0]
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local/state/wezterm-runtime/state/agent-attention/attention.json")
}

func readAttention() (map[string]attentionEntry, error) {
	data, err := os.ReadFile(attentionFile())
	if err != nil {
		return nil, err
	}
	var doc struct {
		Entries map[string]attentionEntry `json:"entries"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, err
	}
	return doc.Entries, nil
}

func tmuxCmd(socket string, args ...string) *exec.Cmd {
	full := args
	if socket != "" {
		full = append([]string{"-S", socket}, args...)
	}
	return exec.Command("tmux", full...)
}

// paneInfo: cwd and whether the pane still exists.
func paneInfo(e attentionEntry) (cwd string, alive bool) {
	out, err := tmuxCmd(e.TmuxSocket, "display-message", "-p", "-t", e.TmuxPane, "#{pane_id}\t#{pane_current_path}").Output()
	if err != nil {
		return "", false
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), "\t", 2)
	if len(parts) != 2 || parts[0] != e.TmuxPane {
		return "", false
	}
	return parts[1], true
}

// deskActivity: newest keyboard activity of any client attached to the
// session (unix seconds), 0 when none is attached.
func deskActivity(e attentionEntry) int64 {
	out, err := tmuxCmd(e.TmuxSocket, "list-clients", "-t", e.TmuxSession, "-F", "#{client_activity}").Output()
	if err != nil {
		return 0
	}
	var newest int64
	for _, line := range strings.Fields(string(out)) {
		if v, err := strconv.ParseInt(line, 10, 64); err == nil && v > newest {
			newest = v
		}
	}
	return newest
}

func claudeTranscript(sessionID string) string {
	home, _ := os.UserHomeDir()
	matches, _ := filepath.Glob(filepath.Join(home, ".claude", "projects", "*", sessionID+".jsonl"))
	if len(matches) == 0 {
		return ""
	}
	return matches[0]
}

type sessionCard struct {
	ID          string   `json:"id"`
	Agent       string   `json:"agent"`
	Name        string   `json:"name"`
	Window      string   `json:"window"`
	Cwd         string   `json:"cwd"`
	Branch      string   `json:"branch"`
	Status      string   `json:"status"`
	WaitingKind string   `json:"waiting_kind,omitempty"`
	LastPrompt  string   `json:"last_prompt"`
	TS          int64    `json:"ts"`
	Transcript  bool     `json:"transcript"`
	DeskIdleS   int64    `json:"desk_idle_s"`
	RunningKind string   `json:"running_kind,omitempty"`
	Background  []bgTask `json:"background"`
}

var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

func listSessions() (any, error) {
	entries, err := readAttention()
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	cards := []sessionCard{}
	for id, e := range entries {
		if e.TmuxPane == "" {
			continue
		}
		cwd, alive := paneInfo(e)
		if !alive {
			continue
		}
		card := sessionCard{ID: id, Name: e.AgentName, Window: e.WindowName, Cwd: cwd, Branch: e.GitBranch,
			Status: e.Status, WaitingKind: e.WaitingKind, LastPrompt: e.LastUserPrompt, TS: e.TS, Agent: "agent",
			RunningKind: e.RunningKind, Background: backgroundOf(e)}
		if claudeTranscript(e.SessionID) != "" {
			card.Agent = "claude"
			card.Transcript = true
		}
		if act := deskActivity(e); act > 0 {
			card.DeskIdleS = now - act
		} else {
			card.DeskIdleS = -1
		}
		cards = append(cards, card)
	}
	sort.Slice(cards, func(i, j int) bool { return cards[i].TS > cards[j].TS })
	return map[string]any{"v": 1, "ok": true, "sessions": cards}, nil
}

func backgroundOf(e attentionEntry) []bgTask {
	if e.RunningKind != "background" || e.Bg.Tasks == nil {
		return []bgTask{}
	}
	out := make([]bgTask, 0, len(e.Bg.Tasks))
	for _, t := range e.Bg.Tasks {
		out = append(out, bgTask{ID: t.ID, Type: t.Type, Summary: clip(t.Summary, 120)})
	}
	return out
}

type chatMessage struct {
	Role string `json:"role"` // user | assistant | tool
	Text string `json:"text"`
	TS   string `json:"ts,omitempty"`
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

// parseClaudeTranscript keeps what a reader on a phone needs: user prompts,
// assistant text, and one line per tool call; tool results are dropped.
func parseClaudeTranscript(data []byte, limit int) []chatMessage {
	messages := []chatMessage{}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 1<<20), 32<<20)
	for scanner.Scan() {
		var line struct {
			Type      string `json:"type"`
			Timestamp string `json:"timestamp"`
			IsMeta    bool   `json:"isMeta"`
			Message   struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(scanner.Bytes(), &line) != nil || line.IsMeta {
			continue
		}
		if line.Type != "user" && line.Type != "assistant" {
			continue
		}
		var text string
		if json.Unmarshal(line.Message.Content, &text) == nil {
			if line.Type == "user" && !strings.HasPrefix(strings.TrimSpace(text), "<") {
				messages = append(messages, chatMessage{Role: "user", Text: clip(text, 4000), TS: line.Timestamp})
			}
			continue
		}
		var blocks []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		}
		if json.Unmarshal(line.Message.Content, &blocks) != nil {
			continue
		}
		for _, b := range blocks {
			switch {
			case b.Type == "text" && strings.TrimSpace(b.Text) != "":
				role := line.Type
				if role == "user" && strings.HasPrefix(strings.TrimSpace(b.Text), "<") {
					continue
				}
				messages = append(messages, chatMessage{Role: role, Text: clip(b.Text, 4000), TS: line.Timestamp})
			case b.Type == "tool_use":
				var input map[string]any
				_ = json.Unmarshal(b.Input, &input)
				detail := ""
				for _, key := range []string{"command", "description", "file_path", "pattern", "url", "prompt"} {
					if v, ok := input[key].(string); ok && v != "" {
						detail = v
						break
					}
				}
				messages = append(messages, chatMessage{Role: "tool", Text: clip(b.Name+" "+detail, 160), TS: line.Timestamp})
			}
		}
	}
	if len(messages) > limit {
		messages = messages[len(messages)-limit:]
	}
	return messages
}

func tailFile(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	start := info.Size() - max
	if start < 0 {
		start = 0
	}
	buf := make([]byte, info.Size()-start)
	if _, err := f.ReadAt(buf, start); err != nil {
		return nil, err
	}
	if start > 0 {
		if i := bytes.IndexByte(buf, '\n'); i >= 0 {
			buf = buf[i+1:]
		}
	}
	return buf, nil
}

func sessionDetail(args json.RawMessage) (any, error) {
	var a struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(args, &a) != nil || !sessionIDPattern.MatchString(a.ID) {
		return nil, errors.New("invalid session id")
	}
	entries, err := readAttention()
	if err != nil {
		return nil, err
	}
	e, ok := entries[a.ID]
	if !ok {
		return nil, errors.New("session not found (ended or not tracked)")
	}
	out := map[string]any{"v": 1, "ok": true, "id": a.ID, "status": e.Status, "waiting_kind": e.WaitingKind,
		"running_kind": e.RunningKind, "background": backgroundOf(e), "agent": "agent"}
	if path := claudeTranscript(e.SessionID); path != "" {
		out["agent"] = "claude"
		data, err := tailFile(path, 4<<20)
		if err != nil {
			return nil, err
		}
		out["messages"] = parseClaudeTranscript(data, 80)
	}
	screen, err := tmuxCmd(e.TmuxSocket, "capture-pane", "-p", "-J", "-t", e.TmuxPane, "-S", "-60").Output()
	if err == nil {
		out["screen"] = strings.TrimRight(string(screen), "\n ")
	}
	return out, nil
}

// ------------------------------------------------------------- device keys

type deviceRecord struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	PublicKey string `json:"public_key"` // base64url, uncompressed P-256 point
	At        string `json:"at"`
}

type deviceStore struct {
	Approved []deviceRecord `json:"approved"`
	Pending  []deviceRecord `json:"pending"`
}

var deviceMu sync.Mutex

func deviceFile() string {
	if p := os.Getenv("WEZDECK_REMOTE_DEVICES"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "wezdeck", "remote-devices.json")
}

func loadDevices() deviceStore {
	var s deviceStore
	if data, err := os.ReadFile(deviceFile()); err == nil {
		_ = json.Unmarshal(data, &s)
	}
	return s
}

func saveDevices(s deviceStore) error {
	// empty lists stay [] (not null) so other readers can iterate them
	if s.Approved == nil {
		s.Approved = []deviceRecord{}
	}
	if s.Pending == nil {
		s.Pending = []deviceRecord{}
	}
	_ = os.MkdirAll(filepath.Dir(deviceFile()), 0o700)
	data, _ := json.MarshalIndent(s, "", "  ")
	return os.WriteFile(deviceFile(), data, 0o600)
}

func deviceID(pub []byte) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:8])
}

func parsePublicKey(b64 string) (*ecdsa.PublicKey, []byte, error) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(b64, "="))
	if err != nil || len(raw) != 65 || raw[0] != 4 {
		return nil, nil, errors.New("public key must be an uncompressed P-256 point")
	}
	x := new(big.Int).SetBytes(raw[1:33])
	y := new(big.Int).SetBytes(raw[33:])
	if !elliptic.P256().IsOnCurve(x, y) {
		return nil, nil, errors.New("public key is not on P-256")
	}
	return &ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, raw, nil
}

// registerDevice records a pending key; approval happens on the host
// (install-remote-relay.sh --approve).
func registerDevice(args json.RawMessage) (any, error) {
	var a struct {
		PublicKey string `json:"public_key"`
		Name      string `json:"name"`
	}
	if json.Unmarshal(args, &a) != nil {
		return nil, errors.New("invalid payload")
	}
	_, raw, err := parsePublicKey(a.PublicKey)
	if err != nil {
		return nil, err
	}
	id := deviceID(raw)
	deviceMu.Lock()
	defer deviceMu.Unlock()
	s := loadDevices()
	for _, d := range s.Approved {
		if d.ID == id {
			return map[string]any{"v": 1, "ok": true, "id": id, "state": "approved"}, nil
		}
	}
	for _, d := range s.Pending {
		if d.ID == id {
			return map[string]any{"v": 1, "ok": true, "id": id, "state": "pending"}, nil
		}
	}
	if len(s.Pending) >= 5 {
		s.Pending = s.Pending[1:]
	}
	s.Pending = append(s.Pending, deviceRecord{ID: id, Name: clip(a.Name, 40), PublicKey: a.PublicKey, At: time.Now().Format(time.RFC3339)})
	if err := saveDevices(s); err != nil {
		return nil, err
	}
	return map[string]any{"v": 1, "ok": true, "id": id, "state": "pending"}, nil
}

var (
	nonceMu   sync.Mutex
	nonceSeen = map[string]time.Time{}
)

type signedWrite struct {
	Action string          `json:"action"`
	Args   json.RawMessage `json:"args"`
	TS     int64           `json:"ts"`
	Nonce  string          `json:"nonce"`
}

// verifyWrite checks the frame's signature over its exact payload text and
// returns the signed action and args (unsigned frame fields are ignored).
func verifyWrite(frameAction string, args json.RawMessage) (*signedWrite, string, error) {
	var env struct {
		Device  string `json:"device"`
		Payload string `json:"payload"`
		Sig     string `json:"sig"`
	}
	if json.Unmarshal(args, &env) != nil || env.Payload == "" || env.Sig == "" {
		return nil, "", errors.New("write is not signed: enable writing on this device first")
	}
	s := loadDevices()
	var pub *ecdsa.PublicKey
	for _, d := range s.Approved {
		if d.ID == env.Device {
			pub, _, _ = parsePublicKey(d.PublicKey)
		}
	}
	if pub == nil {
		return nil, "", errors.New("device not approved: run install-remote-relay.sh --approve on the host")
	}
	sig, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(env.Sig, "="))
	if err != nil || len(sig) != 64 {
		return nil, "", errors.New("bad signature encoding")
	}
	digest := sha256.Sum256([]byte(env.Payload))
	if !ecdsa.Verify(pub, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		return nil, "", errors.New("signature does not verify")
	}
	var w signedWrite
	if json.Unmarshal([]byte(env.Payload), &w) != nil || w.Action != frameAction {
		return nil, "", errors.New("signed payload does not match the request")
	}
	skew := time.Since(time.UnixMilli(w.TS))
	if skew > 2*time.Minute || skew < -2*time.Minute {
		return nil, "", errors.New("request expired: check the phone's clock")
	}
	nonceMu.Lock()
	defer nonceMu.Unlock()
	for k, at := range nonceSeen {
		if time.Since(at) > 5*time.Minute {
			delete(nonceSeen, k)
		}
	}
	if _, dup := nonceSeen[w.Nonce]; dup || w.Nonce == "" {
		return nil, "", errors.New("replayed request")
	}
	nonceSeen[w.Nonce] = time.Now()
	return &w, env.Device, nil
}

// ----------------------------------------------------------------- writes

func guardSession(id string) (attentionEntry, error) {
	if !sessionIDPattern.MatchString(id) {
		return attentionEntry{}, errors.New("invalid session id")
	}
	entries, err := readAttention()
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
		return attentionEntry{}, fmt.Errorf("someone typed at the desk %ds ago; try again shortly", int(time.Since(time.Unix(act, 0)).Seconds()))
	}
	return e, nil
}

func sendToSession(args json.RawMessage) (any, error) {
	var a struct {
		ID   string `json:"id"`
		Text string `json:"text"`
	}
	if json.Unmarshal(args, &a) != nil || strings.TrimSpace(a.Text) == "" || len(a.Text) > 20000 {
		return nil, errors.New("message must be 1–20000 characters")
	}
	e, err := guardSession(a.ID)
	if err != nil {
		return nil, err
	}
	// Claude Code queues input typed mid-turn and schedules it itself; other
	// agents only take input once the turn is over (or only background is left).
	if e.busy() && claudeTranscript(e.SessionID) == "" {
		return nil, errors.New("the agent is still working; send when it stops")
	}
	if e.WaitingKind != "" {
		return nil, errors.New("the agent is asking for a confirmation; answer it with the keys first")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	buffer := "wezdeck-remote"
	load := exec.CommandContext(ctx, "tmux")
	load.Args = append(load.Args, socketArgs(e)...)
	load.Args = append(load.Args, "load-buffer", "-b", buffer, "-")
	load.Stdin = strings.NewReader(a.Text)
	if out, err := load.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("tmux load-buffer: %s", strings.TrimSpace(string(out)))
	}
	if out, err := tmuxCmd(e.TmuxSocket, "paste-buffer", "-p", "-d", "-b", buffer, "-t", e.TmuxPane).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("tmux paste-buffer: %s", strings.TrimSpace(string(out)))
	}
	time.Sleep(150 * time.Millisecond)
	if out, err := tmuxCmd(e.TmuxSocket, "send-keys", "-t", e.TmuxPane, "Enter").CombinedOutput(); err != nil {
		return nil, fmt.Errorf("tmux send-keys: %s", strings.TrimSpace(string(out)))
	}
	_ = tmuxCmd(e.TmuxSocket, "display-message", "-d", "4000", "-t", e.TmuxPane, "手机发来一条消息").Run()
	return map[string]any{"v": 1, "ok": true, "sent": len([]rune(a.Text))}, nil
}

func socketArgs(e attentionEntry) []string {
	if e.TmuxSocket == "" {
		return nil
	}
	return []string{"-S", e.TmuxSocket}
}

// Keys a phone may press: enough to answer a permission / choice dialog.
var allowedKeys = map[string]bool{"Enter": true, "Escape": true, "Up": true, "Down": true, "Tab": true, "1": true, "2": true, "3": true, "4": true}

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

// replyTicket runs `ticket reply` as the phone's owner (via=mobile).
func replyTicket(args json.RawMessage) (any, error) {
	var a struct {
		ID       string `json:"id"`
		Text     string `json:"text"`
		Continue bool   `json:"continue"`
	}
	if json.Unmarshal(args, &a) != nil || !ticketIDPattern.MatchString(a.ID) || strings.TrimSpace(a.Text) == "" || len(a.Text) > 20000 {
		return nil, errors.New("invalid reply")
	}
	root := repoRoot()
	argv := []string{filepath.Join(root, "skills", "agent-collab", "ticket"), "reply", "--id", a.ID, "--decision", a.Text}
	if a.Continue {
		argv = append(argv, "--continue")
	}
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
		return nil, fmt.Errorf("ticket reply: %s", clip(last, 300))
	}
	var result any
	if json.Unmarshal([]byte(last), &result) != nil {
		result = map[string]any{"v": 1, "ok": true}
	}
	return result, nil
}
