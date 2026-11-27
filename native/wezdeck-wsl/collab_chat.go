package main

// `collab.run_chat {run, ticket?, limit?, since?, before?}` (read):
// Parse any headless ticket run (child, Mode 3, research, verify) into the
// same `chatMessage[]` shape `session` returns so the web console renders
// ticket execution natively with `ChatThread`.
//
// Resolution order:
//   1. Native CLI transcript via `findTranscript(sessionID)` (preserves full
//      Claude `structuredPatch`, thinking, tool_result, etc.).
//   2. Fallback to `_data/<ticket>/runs/<run>.stream.jsonl` (Claude stream-json
//      or Codex `--json` stream), covering live in-flight runs and runs whose
//      native transcript was cleaned up or lives outside standard dirs.
//   3. Final fallback to `_data/<ticket>/runs/<run>.final.txt` when neither
//      transcript nor stream has messages.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	collabRunIDRe    = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)
	collabTicketIDRe = regexp.MustCompile(`^req-[A-Za-z0-9_-]{1,64}$`)
)

func ticketsRootDir() string {
	if raw := strings.TrimSpace(os.Getenv("TICKETS_ROOT")); raw != "" {
		return raw
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".agent", "tickets")
}

var (
	runTicketCacheMu sync.Mutex
	runTicketCache   = map[string]string{}
)

func resolveRunTicketDir(runID, ticketHint string) (ticketID, runsDir string, err error) {
	root := filepath.Join(ticketsRootDir(), "_data")
	if ticketHint != "" {
		if !collabTicketIDRe.MatchString(ticketHint) {
			return "", "", errors.New("invalid ticket id")
		}
		dir := filepath.Join(root, ticketHint, "runs")
		if runFilesExist(dir, runID) {
			return ticketHint, dir, nil
		}
		return "", "", errors.New("run not found under ticket")
	}

	runTicketCacheMu.Lock()
	cached := runTicketCache[runID]
	runTicketCacheMu.Unlock()
	if cached != "" {
		dir := filepath.Join(root, cached, "runs")
		if runFilesExist(dir, runID) {
			return cached, dir, nil
		}
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return "", "", errors.New("tickets directory unavailable")
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "req-") {
			continue
		}
		dir := filepath.Join(root, entry.Name(), "runs")
		if runFilesExist(dir, runID) {
			runTicketCacheMu.Lock()
			runTicketCache[runID] = entry.Name()
			runTicketCacheMu.Unlock()
			return entry.Name(), dir, nil
		}
	}
	return "", "", errors.New("run not found")
}

func runFilesExist(runsDir, runID string) bool {
	for _, ext := range []string{".json", ".launch.json", ".stream.jsonl", ".final.txt"} {
		if st, err := os.Stat(filepath.Join(runsDir, runID+ext)); err == nil && !st.IsDir() {
			return true
		}
	}
	return false
}

type runRecordMeta struct {
	Run       string `json:"run"`
	Backend   string `json:"backend"`
	Model     string `json:"model"`
	Phase     string `json:"phase"`
	Role      string `json:"role"`
	StartedAt string `json:"started_at"`
	EndedAt   string `json:"ended_at"`
	Exit      *int   `json:"exit"`
	Session   struct {
		ID    string `json:"id"`
		Reuse string `json:"reuse"`
		From  string `json:"from"`
	} `json:"session"`
	CLIInit struct {
		SessionID string `json:"session_id"`
		Model     string `json:"model"`
	} `json:"cli_init"`
}

type runLaunchMeta struct {
	Run        string `json:"run"`
	TS         string `json:"ts"`
	Phase      string `json:"phase"`
	Role       string `json:"role"`
	Invocation struct {
		Backend string `json:"backend"`
		Model   string `json:"model"`
		Cwd     string `json:"cwd"`
		BaseSHA string `json:"base_sha"`
	} `json:"invocation"`
	Session struct {
		ID    string `json:"id"`
		Reuse string `json:"reuse"`
		From  string `json:"from"`
	} `json:"session"`
}

func readJSONFile(path string, dst any) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return json.Unmarshal(data, dst) == nil
}

func collabRunChat(args json.RawMessage) (any, error) {
	started := time.Now()
	var a struct {
		Run    string `json:"run"`
		Ticket string `json:"ticket"`
		Limit  int    `json:"limit"`
		Since  *int   `json:"since"`
		Before *int   `json:"before"`
	}
	if json.Unmarshal(args, &a) != nil || !collabRunIDRe.MatchString(a.Run) {
		return nil, errors.New("invalid run id")
	}

	ticketID, runsDir, err := resolveRunTicketDir(a.Run, a.Ticket)
	if err != nil {
		return nil, err
	}

	var rec runRecordMeta
	hasRec := readJSONFile(filepath.Join(runsDir, a.Run+".json"), &rec)
	var launch runLaunchMeta
	readJSONFile(filepath.Join(runsDir, a.Run+".launch.json"), &launch)

	backend := firstNonEmpty(rec.Backend, launch.Invocation.Backend)
	model := firstNonEmpty(rec.Model, rec.CLIInit.Model, launch.Invocation.Model)
	phase := firstNonEmpty(rec.Phase, launch.Phase)
	role := firstNonEmpty(rec.Role, launch.Role)
	sessionID := firstNonEmpty(rec.Session.ID, rec.CLIInit.SessionID, launch.Session.ID)
	running := !hasRec
	streamPath := filepath.Join(runsDir, a.Run+".stream.jsonl")

	// Extract session_id from stream head while run is still in flight.
	if sessionID == "" {
		sessionID = peekStreamSessionID(streamPath)
	}

	var msgs []chatMessage
	source := "empty"

	// 1. Prefer native CLI transcript when available (richest diffs & thinking).
	if sessionID != "" {
		if tPath, agent := findTranscript(sessionID); tPath != "" {
			if tr, loadErr := loadTranscript(tPath, agent); loadErr == nil && len(tr.messages) > 0 {
				msgs = tr.messages
				source = "transcript"
				if backend == "" {
					backend = agent
				}
			}
		}
	}

	// 2. Fallback to per-run `.stream.jsonl` (Claude stream-json / Codex --json).
	if len(msgs) == 0 {
		if streamMsgs := parseRunStream(streamPath, backend); len(streamMsgs) > 0 {
			msgs = streamMsgs
			source = "stream"
		}
	}

	// 3. Final fallback to `.final.txt`.
	if len(msgs) == 0 {
		if raw, rerr := os.ReadFile(filepath.Join(runsDir, a.Run+".final.txt")); rerr == nil {
			if txt := strings.TrimSpace(string(raw)); txt != "" {
				msgs = []chatMessage{{Role: "assistant", Text: txt, TS: firstNonEmpty(rec.EndedAt, rec.StartedAt, launch.TS)}}
				source = "final"
			}
		}
	}

	if a.Limit <= 0 {
		a.Limit = 80
	}
	start, end, span := sessionWindow(msgs, sessionArgs{
		ID:     a.Run,
		Limit:  a.Limit,
		Since:  a.Since,
		Before: a.Before,
	})
	page := msgs[start:end]
	if page == nil {
		page = []chatMessage{}
	}

	relayLogf("collab_run_chat", "run=%s ticket=%s backend=%s source=%s total=%d running=%t ms=%d",
		a.Run, ticketID, backend, source, len(msgs), running, time.Since(started).Milliseconds())

	return map[string]any{
		"v":          1,
		"ok":         true,
		"run":        a.Run,
		"ticket":     ticketID,
		"backend":    backend,
		"model":      model,
		"phase":      phase,
		"role":       role,
		"running":    running,
		"source":     source,
		"session_id": sessionID,
		"messages":   page,
		"total":      len(msgs),
		"start":      start,
		"span":       span,
	}, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

func peekStreamSessionID(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 2<<20)
	for i := 0; i < 8 && sc.Scan(); i++ {
		var row struct {
			SessionID string `json:"session_id"`
			ThreadID  string `json:"thread_id"`
		}
		if json.Unmarshal(sc.Bytes(), &row) == nil {
			if id := firstNonEmpty(row.SessionID, row.ThreadID); id != "" {
				return id
			}
		}
	}
	return ""
}

func parseRunStream(path, backend string) []chatMessage {
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return nil
	}
	kind := detectStreamFormat(data, backend)
	if kind == "codex" {
		return parseCodexRunStream(data)
	}
	// Claude stream-json shares the exact line shapes claudeAdapter handles.
	t := &transcript{format: "claude", tools: map[string]int{}}
	t.feed(data)
	return t.messages
}

func detectStreamFormat(data []byte, backend string) string {
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 64<<10), 2<<20)
	for i := 0; i < 6 && sc.Scan(); i++ {
		var probe struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(sc.Bytes(), &probe) != nil {
			continue
		}
		switch probe.Type {
		case "thread.started", "turn.started", "item.started", "item.updated", "item.completed", "turn.completed":
			return "codex"
		case "system", "assistant", "user":
			return "claude"
		}
	}
	if strings.EqualFold(backend, "codex") {
		return "codex"
	}
	return "claude"
}

// parseCodexRunStream parses `codex exec --json` JSONL stream events into
// standard chatMessage rows (assistant messages, reasoning thoughts, shell
// commands, file changes, and tool calls).
func parseCodexRunStream(data []byte) []chatMessage {
	t := &transcript{format: "codex", tools: map[string]int{}}
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 1<<20), 32<<20)
	for sc.Scan() {
		var ev struct {
			Type string `json:"type"`
			Item struct {
				ID               string `json:"id"`
				Type             string `json:"type"`
				Text             string `json:"text"`
				Message          string `json:"message"`
				Command          string `json:"command"`
				AggregatedOutput string `json:"aggregated_output"`
				Status           string `json:"status"`
				ExitCode         *int   `json:"exit_code"`
				Query            string `json:"query"`
				Tool             string `json:"tool"`
				Server           string `json:"server"`
				Changes          []struct {
					Path string `json:"path"`
					Kind string `json:"kind"`
				} `json:"changes"`
			} `json:"item"`
		}
		if json.Unmarshal(sc.Bytes(), &ev) != nil {
			continue
		}
		if ev.Type != "item.started" && ev.Type != "item.updated" && ev.Type != "item.completed" {
			continue
		}
		item := ev.Item
		completed := ev.Type == "item.completed"
		switch item.Type {
		case "agent_message":
			if completed && strings.TrimSpace(item.Text) != "" {
				t.messages = append(t.messages, chatMessage{
					Role: "assistant",
					Text: strings.TrimSpace(item.Text),
				})
			}
		case "reasoning":
			if completed && strings.TrimSpace(item.Text) != "" {
				t.messages = append(t.messages, chatMessage{
					Role: "system",
					Kind: "thought",
					Text: clip(item.Text, 4000),
				})
			}
		case "command_execution":
			idx, exists := t.tools[item.ID]
			if !exists {
				t.messages = append(t.messages, chatMessage{
					Role:    "tool",
					Tool:    "shell",
					Kind:    toolKindCommand,
					Text:    clip("shell "+firstLine(item.Command), 160),
					Body:    clip(item.Command, 2000),
					Pending: !completed,
				})
				idx = len(t.messages) - 1
				if item.ID != "" {
					t.tools[item.ID] = idx
				}
			}
			if completed {
				out := strings.TrimSpace(item.AggregatedOutput)
				if out == "" && item.ExitCode != nil {
					if *item.ExitCode == 0 {
						out = "exit 0"
					} else {
						out = "exit non-zero"
					}
				}
				t.messages[idx].Result = clipLines(clip(out, 3000), 40)
				t.messages[idx].Pending = false
			}
		case "file_change":
			if completed && len(item.Changes) > 0 {
				var lines []string
				for _, ch := range item.Changes {
					lines = append(lines, strings.TrimSpace(ch.Kind+" "+ch.Path))
				}
				file := item.Changes[0].Path
				t.messages = append(t.messages, chatMessage{
					Role: "tool",
					Tool: "apply_patch",
					Kind: toolKindEdit,
					File: file,
					Text: clip("Edit "+file, 160),
					Body: clipLines(strings.Join(lines, "\n"), 40),
				})
			}
		case "mcp_tool_call":
			name := firstNonEmpty(item.Tool, "mcp")
			if item.Server != "" {
				name = item.Server + "/" + name
			}
			idx, exists := t.tools[item.ID]
			if !exists {
				t.messages = append(t.messages, chatMessage{
					Role:    "tool",
					Tool:    name,
					Kind:    toolKindOther,
					Text:    clip(name, 160),
					Pending: !completed,
				})
				idx = len(t.messages) - 1
				if item.ID != "" {
					t.tools[item.ID] = idx
				}
			}
			if completed {
				t.messages[idx].Pending = false
				if item.Status != "" {
					t.messages[idx].Result = item.Status
				}
			}
		case "web_search":
			if completed && item.Query != "" {
				t.messages = append(t.messages, chatMessage{
					Role: "tool",
					Tool: "web_search",
					Kind: toolKindWeb,
					Text: clip("web_search "+item.Query, 160),
				})
			}
		case "error":
			msg := strings.TrimSpace(item.Message)
			// Skip harmless Codex config deprecation warnings printed on startup.
			if completed && msg != "" && !strings.Contains(msg, "ignoring") {
				t.messages = append(t.messages, chatMessage{
					Role: "system",
					Kind: "error",
					Text: clip(msg, 500),
				})
			}
		}
	}
	return t.messages
}
