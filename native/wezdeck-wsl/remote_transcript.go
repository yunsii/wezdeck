package main

// Agent transcripts for the web console (split out of remote_session.go,
// 2026-11-24): the chat message shape, tool-call summaries and diffs, and
// the incremental transcript parser behind `session` (Claude, Codex and
// Grok formats, cached per file).

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
)

type chatMessage struct {
	Role   string `json:"role"` // user | assistant | tool | system (Kind "compact": context compaction marker, Body = summary)
	Text   string `json:"text"`
	TS     string `json:"ts,omitempty"`
	Tool   string `json:"tool,omitempty"`   // tool name (role=tool)
	Body   string `json:"body,omitempty"`   // what the tool was asked to do: diff, file preview, command
	Result string `json:"result,omitempty"` // what came back (clipped)
	// Pending: the call has gone out and no result came back yet (the phone
	// shows it as running while the session is busy)
	Pending bool `json:"pending,omitempty"`
	// Background: the call asked to run in the background
	// (run_in_background) — a pending foreground Bash / Agent call is what
	// the phone offers to move there (Claude Code's Ctrl+B)
	Background bool `json:"background,omitempty"`
	// Kind: the shared tool kind (agent_adapter.go toolKind*), so the phone
	// summarises a run without knowing each agent's tool names.
	Kind string `json:"kind,omitempty"`
	// File / Added / Removed: what a file tool touched, counted on the full
	// input (Body is clipped for the phone).
	File    string `json:"file,omitempty"`
	Added   int    `json:"added,omitempty"`
	Removed int    `json:"removed,omitempty"`
	// Images: refs ("<line byte offset>.<nth image in that line>") to images
	// embedded base64 in the transcript — pasted at the desk, or returned by a
	// tool; the phone fetches them with session.image (remote_image.go).
	Images []string `json:"images,omitempty"`
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
	// the plan Claude asks to leave plan mode with (permission.go)
	if name == "ExitPlanMode" {
		if plan := inputString(input, "plan"); plan != "" {
			return clip(plan, 20000)
		}
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
	agents   map[string]int // Claude subagent id → its Agent call's index (hand-back reports)
	tasks    map[string]int // background task id (Monitor, Bash run_in_background) → its call's index
	usage    sessionUsage
	mode     string // Claude's permission mode, from the newest user line
	// task notifications already shown (a queued one can be delivered too)
	seenNotes map[string]bool
	lastMsg     string             // message id whose usage was counted (one reply spans several lines)
	outputs     []outputMark       // per reply: when, how many output tokens (turnOutput)
	stepStartMS int64              // trigger timestamp for next reply's step-rate window
	pendingAgy  *pendingStepOutput // open Agy PLANNER_RESPONSE waiting on next step's created_at
	stepRates   []stepRateMark     // per-step (outputTokens, durationMS) fallback rates
	lineOff     int64              // file offset of the line being fed
	skills      []skillInfo        // the skills the agent was shown (session_skills.go)
}

// markCompact appends a context-compaction marker (role system, kind compact;
// Text = what triggered it: auto | manual).
func (t *transcript) markCompact(trigger, ts string) {
	if trigger == "" {
		trigger = "auto"
	}
	t.messages = append(t.messages, chatMessage{Role: "system", Kind: "compact", Text: trigger, TS: ts})
	t.usage.Context = 0
	t.usage.ContextPending = true
}

// attachCompactSummary puts the summary the agent continues from on the
// latest compact marker (it follows the boundary line).
func (t *transcript) attachCompactSummary(summary string) {
	for i := len(t.messages) - 1; i >= 0; i-- {
		if t.messages[i].Kind == "compact" {
			if t.messages[i].Body == "" {
				t.messages[i].Body = clip(summary, 6000)
			}
			return
		}
	}
}

// compactions: how many times the context was compacted and the index of the
// latest marker (-1 when never).
func (t *transcript) compactions() (count, last int) {
	last = -1
	for i, m := range t.messages {
		if m.Kind == "compact" {
			count++
			last = i
		}
	}
	return count, last
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
	// ContextPending: compacted since the last reply. Context comes from the
	// newest reply's usage, which still counts the pre-compaction history
	// (a 92% that only drops after the next reply), so it is withheld until
	// a reply arrives.
	ContextPending bool `json:"context_pending,omitempty"`
}

var (
	transcriptsMu sync.Mutex
	transcripts   = map[string]*transcript{}
)

func (t *transcript) feed(data []byte) {
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 1<<20), 64<<20)
	adapter := adapterFor(t.format)
	if adapter == nil {
		adapter = claudeAdapter{}
	}
	// lineOff: where the line being fed starts in the file (image refs)
	t.lineOff = t.offset
	for scanner.Scan() {
		line := scanner.Bytes()
		adapter.Feed(t, line)
		t.lineOff += int64(len(line)) + 1
	}
}

// toolKind asks this transcript's adapter for the shared kind of a tool call.
func (t *transcript) toolKind(name string, input map[string]any) string {
	if a := adapterFor(t.format); a != nil {
		return a.ToolKind(name, input)
	}
	return toolKindByName(nil, name, input)
}

func (t *transcript) addTool(id, name, argsJSON, ts string) {
	var input map[string]any
	if json.Unmarshal([]byte(argsJSON), &input) != nil {
		input = map[string]any{"command": argsJSON}
	}
	file, added, removed := toolStats(name, input)
	t.messages = append(t.messages, chatMessage{Role: "tool", Tool: name, Text: toolSummary(name, input),
		Body: toolBody(name, input), TS: ts, File: file, Added: added, Removed: removed,
		Kind: t.toolKind(name, input)})
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
