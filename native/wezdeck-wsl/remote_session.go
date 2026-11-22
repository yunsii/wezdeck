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

// deskIdle: a phone write waits this long after the last input at the desk
// (tmux client_activity: keys, mouse, focus) so it never lands in the middle
// of someone typing there. 30 s blocked the phone for half a minute after
// merely answering a prompt at the desk; the phone now counts down and
// resends on its own ("retry in Ns").
const deskIdle = 10 * time.Second

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

type recentEntry struct {
	attentionEntry
	LastStatus string `json:"last_status"`
	ArchivedTS int64  `json:"archived_ts"`
}

func readAttentionDoc() (map[string]attentionEntry, []recentEntry, error) {
	data, err := os.ReadFile(attentionFile())
	if err != nil {
		return nil, nil, err
	}
	var doc struct {
		Entries map[string]attentionEntry `json:"entries"`
		Recent  []recentEntry             `json:"recent"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, nil, err
	}
	return doc.Entries, doc.Recent, nil
}

// agentCommands: what an agent TUI pane runs (pane_current_command).
var agentCommands = map[string]bool{"claude": true, "codex": true, "grok": true, "grok.real": true}

// liveSessions merges the live entries with archived ones (recent[]) whose
// pane still runs an agent: an acknowledged or idle-for-30-min session drops
// out of .entries but is still open and takes input. Archived ones get
// status "idle"; per pane only the newest session id counts (/clear makes a
// new one).
func liveSessions() (map[string]attentionEntry, error) {
	entries, recent, err := readAttentionDoc()
	if err != nil {
		return nil, err
	}
	out := map[string]attentionEntry{}
	panes := map[string]bool{}
	for id, e := range entries {
		out[id] = e
		panes[e.TmuxSocket+"|"+e.TmuxPane] = true
	}
	sort.Slice(recent, func(i, j int) bool { return recent[i].ArchivedTS > recent[j].ArchivedTS })
	for _, r := range recent {
		key := r.TmuxSocket + "|" + r.TmuxPane
		if r.SessionID == "" || r.TmuxPane == "" || panes[key] {
			continue
		}
		panes[key] = true
		if _, _, cmd, alive := paneState(r.attentionEntry); !alive || !agentCommands[cmd] {
			continue
		}
		e := r.attentionEntry
		e.Status = "idle"
		e.WaitingKind = ""
		e.RunningKind = ""
		e.TS = r.ArchivedTS
		out[r.SessionID] = e
	}
	return out, nil
}

func tmuxCmd(socket string, args ...string) *exec.Cmd {
	full := args
	if socket != "" {
		full = append([]string{"-S", socket}, args...)
	}
	return exec.Command("tmux", full...)
}

// paneState: the pane's id, cwd, current command, and whether it exists.
func paneState(e attentionEntry) (id, cwd, cmd string, alive bool) {
	out, err := tmuxCmd(e.TmuxSocket, "display-message", "-p", "-t", e.TmuxPane, "#{pane_id}\t#{pane_current_path}\t#{pane_current_command}").Output()
	if err != nil {
		return "", "", "", false
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), "\t", 3)
	if len(parts) != 3 || parts[0] != e.TmuxPane {
		return "", "", "", false
	}
	return parts[0], parts[1], parts[2], true
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
	_, cwd, _, alive = paneState(e)
	return cwd, alive
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

// findTranscript locates a session's conversation file and its agent:
// Claude ~/.claude/projects/*/<id>.jsonl, Grok
// ~/.grok/sessions/*/<id>/chat_history.jsonl, Codex
// ~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl.
func findTranscript(sessionID string) (path, agent string) {
	if !sessionIDPattern.MatchString(sessionID) {
		return "", ""
	}
	home, _ := os.UserHomeDir()
	for _, c := range []struct{ agent, pattern string }{
		{"claude", filepath.Join(home, ".claude", "projects", "*", sessionID+".jsonl")},
		{"grok", filepath.Join(home, ".grok", "sessions", "*", sessionID, "chat_history.jsonl")},
		{"codex", filepath.Join(home, ".codex", "sessions", "*", "*", "*", "rollout-*-"+sessionID+".jsonl")},
	} {
		if matches, _ := filepath.Glob(c.pattern); len(matches) > 0 {
			return matches[0], c.agent
		}
	}
	return "", ""
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
	entries, err := liveSessions()
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
		// Activity = when the conversation last moved. A transcript (Claude,
		// Grok, Codex) is written only by real turns (messages, tool calls), so
		// it alone is the clock; the status ts (bumped for background-only sessions) and
		// tmux window_activity (any pane in the window, TUI redraws) would
		// reorder idle sessions. Agents without a transcript fall back to them.
		if path, agent := findTranscript(e.SessionID); path != "" {
			card.Agent = agent
			card.Transcript = true
			if info, err := os.Stat(path); err == nil {
				card.TS = info.ModTime().UnixMilli()
			}
		} else if act := windowActivity(e); act > card.TS {
			card.TS = act
		}
		if act := deskActivity(e); act > 0 {
			card.DeskIdleS = now - act
		} else {
			card.DeskIdleS = -1
		}
		cards = append(cards, card)
	}
	// newest conversation activity first
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
	Role   string `json:"role"` // user | assistant | tool
	Text   string `json:"text"`
	TS     string `json:"ts,omitempty"`
	Tool   string `json:"tool,omitempty"`   // tool name (role=tool)
	Body   string `json:"body,omitempty"`   // what the tool was asked to do: diff, file preview, command
	Result string `json:"result,omitempty"` // what came back (clipped)
	// Pending: the call has gone out and no result came back yet (the phone
	// shows it as running while the session is busy)
	Pending bool `json:"pending,omitempty"`
	// File / Added / Removed: what a file tool touched, counted on the full
	// input (Body is clipped for the phone).
	File    string `json:"file,omitempty"`
	Added   int    `json:"added,omitempty"`
	Removed int    `json:"removed,omitempty"`
}

func lineCount(s string) int {
	if s == "" {
		return 0
	}
	return strings.Count(strings.TrimRight(s, "\n"), "\n") + 1
}

func inputString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func toolFile(input map[string]any) string {
	return inputString(input, "file_path", "target_file", "path", "filename")
}

func editPairs(input map[string]any) [][2]string {
	if o, n := inputString(input, "old_string", "old_str"), inputString(input, "new_string", "new_str"); o != "" || n != "" {
		return [][2]string{{o, n}}
	}
	var out [][2]string
	edits, _ := input["edits"].([]any)
	for _, e := range edits {
		m, _ := e.(map[string]any)
		out = append(out, [2]string{inputString(m, "old_string", "old_str"), inputString(m, "new_string", "new_str")})
	}
	return out
}

// writes: a whole-file write (Claude Write, Grok write/create_file, …).
func writeContent(name string, input map[string]any) (string, bool) {
	content := inputString(input, "content", "contents", "file_text")
	lower := strings.ToLower(name)
	if content == "" || toolFile(input) == "" || !(strings.Contains(lower, "write") || strings.Contains(lower, "create")) {
		return "", false
	}
	return content, true
}

// toolStats: file and changed-line counts, judged by the input's shape so
// Claude, Grok and Codex tools count alike (old/new strings = edit,
// content + write/create = whole-file write).
func toolStats(name string, input map[string]any) (file string, added, removed int) {
	file = toolFile(input)
	if pairs := editPairs(input); len(pairs) > 0 && file != "" {
		for _, p := range pairs {
			removed += lineCount(p[0])
			added += lineCount(p[1])
		}
		return file, added, removed
	}
	if content, ok := writeContent(name, input); ok {
		return file, lineCount(content), 0
	}
	return file, 0, 0
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

func clipLines(s string, lines int) string {
	parts := strings.Split(s, "\n")
	if len(parts) <= lines {
		return s
	}
	return strings.Join(parts[:lines], "\n") + fmt.Sprintf("\n… (+%d lines)", len(parts)-lines)
}

// toolBody: the part of a tool call a reviewer wants to see on a phone.
func toolBody(name string, input map[string]any) string {
	diff := func(oldText, newText string) string {
		var b strings.Builder
		for _, l := range strings.Split(oldText, "\n") {
			b.WriteString("- " + l + "\n")
		}
		for _, l := range strings.Split(newText, "\n") {
			b.WriteString("+ " + l + "\n")
		}
		return strings.TrimRight(b.String(), "\n")
	}
	if pairs := editPairs(input); len(pairs) > 0 {
		var parts []string
		for _, p := range pairs {
			parts = append(parts, diff(p[0], p[1]))
		}
		return clipLines(strings.Join(parts, "\n…\n"), 120)
	}
	if content, ok := writeContent(name, input); ok {
		return clipLines(content, 40)
	}
	if cmd := inputString(input, "command", "cmd"); cmd != "" {
		return clip(cmd, 2000)
	}
	if list, ok := input["command"].([]any); ok { // codex shell: ["bash","-lc","…"]
		var words []string
		for _, w := range list {
			if v, ok := w.(string); ok {
				words = append(words, v)
			}
		}
		return clip(strings.Join(words, " "), 2000)
	}
	return ""
}

func toolSummary(name string, input map[string]any) string {
	if v := inputString(input, "file_path", "target_file", "path", "description", "command", "cmd", "pattern", "query", "url", "prompt"); v != "" {
		return clip(name+" "+v, 160)
	}
	return name
}

// transcript: a session file (Claude / Grok / Codex) parsed incrementally — only bytes
// appended since the last read are parsed, so a 30 MB transcript is read
// once and each poll costs the new lines.
type transcript struct {
	format   string // claude | grok | codex
	offset   int64
	size     int64
	messages []chatMessage
	tools    map[string]int // tool_use_id → index in messages
	usage    sessionUsage
	lastMsg  string // message id whose usage was counted (one reply spans several lines)
}

// sessionUsage: what the session has spent, from each reply's `usage`.
// Context = the last reply's full input (fresh + cache read + cache write).
type sessionUsage struct {
	Model        string `json:"model,omitempty"`
	Context      int    `json:"context"`
	ContextLimit int    `json:"context_limit"`
	Turns        int    `json:"turns"`
	Output       int    `json:"output"`
	Input        int    `json:"input"`      // fresh + cache write
	CacheRead    int    `json:"cache_read"` // served from cache
}

var (
	transcriptsMu sync.Mutex
	transcripts   = map[string]*transcript{}
)

func (t *transcript) feed(data []byte) {
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 1<<20), 64<<20)
	for scanner.Scan() {
		switch t.format {
		case "grok":
			t.feedGrok(scanner.Bytes())
		case "codex":
			t.feedCodex(scanner.Bytes())
		default:
			t.feedLine(scanner.Bytes())
		}
	}
}

func (t *transcript) feedLine(raw []byte) {
	var line struct {
		Type      string `json:"type"`
		Timestamp string `json:"timestamp"`
		IsMeta    bool   `json:"isMeta"`
		Message   struct {
			ID      string          `json:"id"`
			Model   string          `json:"model"`
			Content json.RawMessage `json:"content"`
			Usage   *struct {
				Input       int `json:"input_tokens"`
				CacheWrite  int `json:"cache_creation_input_tokens"`
				CacheRead   int `json:"cache_read_input_tokens"`
				OutputCount int `json:"output_tokens"`
			} `json:"usage"`
		} `json:"message"`
		Attachment struct {
			Type        string `json:"type"`
			Prompt      string `json:"prompt"`
			CommandMode string `json:"commandMode"`
			Origin      struct {
				Kind string `json:"kind"`
			} `json:"origin"`
		} `json:"attachment"`
	}
	if json.Unmarshal(raw, &line) != nil || line.IsMeta {
		return
	}
	// A message typed (or sent from the phone) while Claude is mid-turn is
	// queued and lands as an attachment, not a user line. Keep the human
	// ones; task notifications, subagent hand-backs and auto-continuations
	// are harness traffic.
	if a := line.Attachment; line.Type == "attachment" && a.Type == "queued_command" && a.CommandMode == "prompt" {
		human := a.Origin.Kind == "human" || (a.Origin.Kind == "" && !strings.HasPrefix(strings.TrimSpace(a.Prompt), "<"))
		if human && strings.TrimSpace(a.Prompt) != "" {
			t.messages = append(t.messages, chatMessage{Role: "user", Text: clip(a.Prompt, 8000), TS: line.Timestamp})
		}
		return
	}
	if line.Type != "user" && line.Type != "assistant" {
		return
	}
	if u := line.Message.Usage; line.Type == "assistant" && u != nil && line.Message.ID != t.lastMsg {
		t.lastMsg = line.Message.ID
		if line.Message.Model != "" && !strings.HasPrefix(line.Message.Model, "<") {
			t.usage.Model = line.Message.Model
		}
		t.usage.Context = u.Input + u.CacheWrite + u.CacheRead
		t.usage.Turns++
		t.usage.Output += u.OutputCount
		t.usage.Input += u.Input + u.CacheWrite
		t.usage.CacheRead += u.CacheRead
	}
	var text string
	if json.Unmarshal(line.Message.Content, &text) == nil {
		if line.Type == "user" && !strings.HasPrefix(strings.TrimSpace(text), "<") {
			t.messages = append(t.messages, chatMessage{Role: "user", Text: clip(text, 8000), TS: line.Timestamp})
		}
		return
	}
	var blocks []struct {
		Type      string          `json:"type"`
		Text      string          `json:"text"`
		ID        string          `json:"id"`
		Name      string          `json:"name"`
		Input     json.RawMessage `json:"input"`
		ToolUseID string          `json:"tool_use_id"`
		Content   json.RawMessage `json:"content"`
	}
	if json.Unmarshal(line.Message.Content, &blocks) != nil {
		return
	}
	for _, b := range blocks {
		switch {
		case b.Type == "text" && strings.TrimSpace(b.Text) != "":
			if line.Type == "user" && strings.HasPrefix(strings.TrimSpace(b.Text), "<") {
				continue
			}
			t.messages = append(t.messages, chatMessage{Role: line.Type, Text: clip(b.Text, 8000), TS: line.Timestamp})
		case b.Type == "tool_use":
			var input map[string]any
			_ = json.Unmarshal(b.Input, &input)
			file, added, removed := toolStats(b.Name, input)
			t.messages = append(t.messages, chatMessage{Role: "tool", Tool: b.Name, Text: toolSummary(b.Name, input),
				Body: toolBody(b.Name, input), TS: line.Timestamp, File: file, Added: added, Removed: removed})
			if b.ID != "" {
				t.tools[b.ID] = len(t.messages) - 1
				t.messages[len(t.messages)-1].Pending = true
			}
		case b.Type == "tool_result":
			idx, ok := t.tools[b.ToolUseID]
			if !ok {
				continue
			}
			var out string
			if json.Unmarshal(b.Content, &out) != nil {
				var parts []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				}
				_ = json.Unmarshal(b.Content, &parts)
				for _, p := range parts {
					if p.Type == "text" {
						out += p.Text + "\n"
					}
				}
			}
			t.messages[idx].Result = clipLines(clip(out, 3000), 40)
			t.messages[idx].Pending = false
			delete(t.tools, b.ToolUseID)
		}
	}
}

var (
	catalogMu    sync.Mutex
	catalogLimit map[string]int
	catalogAt    time.Time
)

// contextLimit: the model's max input tokens from Claude Code's local model
// catalog (~/.claude/cache/model-catalog), 200k when unknown.
func contextLimit(model string) int {
	catalogMu.Lock()
	defer catalogMu.Unlock()
	if catalogLimit == nil || time.Since(catalogAt) > 10*time.Minute {
		catalogLimit = map[string]int{}
		catalogAt = time.Now()
		home, _ := os.UserHomeDir()
		files, _ := filepath.Glob(filepath.Join(home, ".claude", "cache", "model-catalog", "*.json"))
		for _, f := range files {
			data, err := os.ReadFile(f)
			if err != nil {
				continue
			}
			var doc struct {
				Catalog struct {
					Config struct {
						Models []struct {
							ID      string `json:"id"`
							Runtime struct {
								MaxInput int `json:"max_input_tokens"`
							} `json:"runtime"`
						} `json:"models"`
					} `json:"config"`
				} `json:"catalog"`
			}
			if json.Unmarshal(data, &doc) != nil {
				continue
			}
			for _, m := range doc.Catalog.Config.Models {
				if m.Runtime.MaxInput > 0 {
					catalogLimit[m.ID] = m.Runtime.MaxInput
				}
			}
		}
	}
	if v, ok := catalogLimit[strings.TrimSuffix(model, "[1m]")]; ok {
		return v
	}
	return 200000
}

func (t *transcript) addTool(id, name, argsJSON, ts string) {
	var input map[string]any
	if json.Unmarshal([]byte(argsJSON), &input) != nil {
		input = map[string]any{"command": argsJSON}
	}
	file, added, removed := toolStats(name, input)
	t.messages = append(t.messages, chatMessage{Role: "tool", Tool: name, Text: toolSummary(name, input),
		Body: toolBody(name, input), TS: ts, File: file, Added: added, Removed: removed})
	if id != "" {
		t.tools[id] = len(t.messages) - 1
		t.messages[len(t.messages)-1].Pending = true
	}
}

func (t *transcript) setResult(id, out string) {
	if idx, ok := t.tools[id]; ok {
		t.messages[idx].Result = clipLines(clip(out, 3000), 40)
		t.messages[idx].Pending = false
		delete(t.tools, id)
	}
}

// userText: what the person typed; harness-injected context (<user_info>,
// <system-reminder>…) is dropped, a <user_query> wrapper is unwrapped.
func userText(text string) string {
	if i := strings.Index(text, "<user_query>"); i >= 0 {
		rest := text[i+len("<user_query>"):]
		if j := strings.Index(rest, "</user_query>"); j >= 0 {
			rest = rest[:j]
		}
		return strings.TrimSpace(rest)
	}
	if strings.HasPrefix(strings.TrimSpace(text), "<") {
		return ""
	}
	return text
}

// feedGrok: ~/.grok/sessions/…/chat_history.jsonl lines
// {type:user|assistant|tool_result|reasoning|system}.
func (t *transcript) feedGrok(raw []byte) {
	var line struct {
		Type       string          `json:"type"`
		Content    json.RawMessage `json:"content"`
		ModelID    string          `json:"model_id"`
		ToolCallID string          `json:"tool_call_id"`
		ToolCalls  []struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"tool_calls"`
	}
	if json.Unmarshal(raw, &line) != nil {
		return
	}
	text := func() string {
		var s string
		if json.Unmarshal(line.Content, &s) == nil {
			return s
		}
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		_ = json.Unmarshal(line.Content, &blocks)
		var parts []string
		for _, b := range blocks {
			if b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n")
	}
	switch line.Type {
	case "user":
		if u := userText(text()); u != "" {
			t.messages = append(t.messages, chatMessage{Role: "user", Text: clip(u, 8000)})
		}
	case "assistant":
		if line.ModelID != "" {
			t.usage.Model = line.ModelID
		}
		t.usage.Turns++
		if body := strings.TrimSpace(text()); body != "" {
			t.messages = append(t.messages, chatMessage{Role: "assistant", Text: clip(body, 8000)})
		}
		for _, c := range line.ToolCalls {
			t.addTool(c.ID, c.Name, c.Arguments, "")
		}
	case "tool_result":
		t.setResult(line.ToolCallID, text())
	}
}

// feedCodex: ~/.codex/sessions/…/rollout-*.jsonl lines
// {type:response_item|event_msg|…, payload}.
func (t *transcript) feedCodex(raw []byte) {
	var line struct {
		Type      string `json:"type"`
		Timestamp string `json:"timestamp"`
		Payload   struct {
			Type    string `json:"type"`
			Role    string `json:"role"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
			Name      string          `json:"name"`
			Arguments string          `json:"arguments"`
			Input     string          `json:"input"`
			CallID    string          `json:"call_id"`
			Output    json.RawMessage `json:"output"`
			Model     string          `json:"model"`
			Settings  struct {
				Model string `json:"model"`
			} `json:"thread_settings"`
			Info *struct {
				Last struct {
					Input  int `json:"input_tokens"`
					Cached int `json:"cached_input_tokens"`
					Output int `json:"output_tokens"`
				} `json:"last_token_usage"`
				Total struct {
					Input  int `json:"input_tokens"`
					Cached int `json:"cached_input_tokens"`
					Output int `json:"output_tokens"`
				} `json:"total_token_usage"`
				Window int `json:"model_context_window"`
			} `json:"info"`
		} `json:"payload"`
	}
	if json.Unmarshal(raw, &line) != nil {
		return
	}
	p := line.Payload
	switch {
	case line.Type == "response_item" && p.Type == "message" && (p.Role == "user" || p.Role == "assistant"):
		var parts []string
		for _, c := range p.Content {
			if c.Text != "" {
				parts = append(parts, c.Text)
			}
		}
		text := strings.Join(parts, "\n")
		if p.Role == "user" {
			text = userText(text)
		}
		if strings.TrimSpace(text) != "" {
			t.messages = append(t.messages, chatMessage{Role: p.Role, Text: clip(text, 8000), TS: line.Timestamp})
		}
	case line.Type == "response_item" && (p.Type == "function_call" || p.Type == "custom_tool_call"):
		args := p.Arguments
		if args == "" {
			args = p.Input
		}
		t.addTool(p.CallID, p.Name, args, line.Timestamp)
	case line.Type == "response_item" && (p.Type == "function_call_output" || p.Type == "custom_tool_call_output"):
		var out string
		if json.Unmarshal(p.Output, &out) != nil {
			var obj struct {
				Content string `json:"content"`
				Output  string `json:"output"`
			}
			_ = json.Unmarshal(p.Output, &obj)
			out = obj.Content + obj.Output
		}
		t.setResult(p.CallID, out)
	case line.Type == "event_msg" && p.Type == "thread_settings_applied" && p.Settings.Model != "":
		t.usage.Model = p.Settings.Model
	case line.Type == "turn_context" && p.Model != "":
		t.usage.Model = p.Model
	case line.Type == "event_msg" && p.Type == "token_count" && p.Info != nil:
		t.usage.Turns++
		t.usage.Context = p.Info.Last.Input
		t.usage.ContextLimit = p.Info.Window
		t.usage.Output = p.Info.Total.Output
		t.usage.CacheRead = p.Info.Total.Cached
		t.usage.Input = p.Info.Total.Input - p.Info.Total.Cached
	}
}

// loadTranscript returns the parsed transcript, reading only what was
// appended since last time (a shrunk file is re-read from the start).
func loadTranscript(path, format string) (*transcript, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	transcriptsMu.Lock()
	defer transcriptsMu.Unlock()
	t := transcripts[path]
	if t == nil || info.Size() < t.size {
		t = &transcript{format: format, tools: map[string]int{}}
		transcripts[path] = t
	}
	if info.Size() == t.offset {
		return t, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, info.Size()-t.offset)
	n, err := f.ReadAt(buf, t.offset)
	if err != nil && n == 0 {
		return nil, err
	}
	buf = buf[:n]
	end := bytes.LastIndexByte(buf, '\n')
	if end < 0 {
		return t, nil // partial line: wait for the rest
	}
	t.feed(buf[:end+1])
	t.offset += int64(end + 1)
	t.size = info.Size()
	return t, nil
}

// parseClaudeTranscript parses a whole transcript (tests and one-off use).
func parseClaudeTranscript(data []byte, limit int) []chatMessage {
	t := &transcript{format: "claude", tools: map[string]int{}}
	t.feed(data)
	if len(t.messages) > limit {
		return t.messages[len(t.messages)-limit:]
	}
	return t.messages
}

func sessionDetail(args json.RawMessage) (any, error) {
	var a struct {
		ID    string `json:"id"`
		Limit int    `json:"limit"`
	}
	if json.Unmarshal(args, &a) != nil || !sessionIDPattern.MatchString(a.ID) {
		return nil, errors.New("invalid session id")
	}
	if a.Limit <= 0 {
		a.Limit = 60
	}
	if a.Limit > 5000 {
		a.Limit = 5000
	}
	entries, err := liveSessions()
	if err != nil {
		return nil, err
	}
	e, ok := entries[a.ID]
	if !ok {
		return nil, errors.New("session not found (ended or not tracked)")
	}
	out := map[string]any{"v": 1, "ok": true, "id": a.ID, "status": e.Status, "waiting_kind": e.WaitingKind,
		"running_kind": e.RunningKind, "background": backgroundOf(e), "agent": "agent"}
	if path, agent := findTranscript(e.SessionID); path != "" {
		out["agent"] = agent
		t, err := loadTranscript(path, agent)
		if err != nil {
			return nil, err
		}
		transcriptsMu.Lock()
		total := len(t.messages)
		start := total - a.Limit
		if start < 0 {
			start = 0
		}
		out["messages"] = append([]chatMessage(nil), t.messages[start:]...)
		transcriptsMu.Unlock()
		out["total"] = total
		out["start"] = start
		usage := t.usage
		if usage.ContextLimit == 0 {
			usage.ContextLimit = contextLimit(usage.Model)
		}
		out["usage"] = usage
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
