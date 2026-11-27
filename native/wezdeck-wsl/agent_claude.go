package main

// Claude Code adapter: transcript lines (~/.claude/projects/*/<id>.jsonl),
// ai-title, and the model catalog for the context limit.

import (
	"encoding/json"
	"fmt"
	"html"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// lastClaudeAITitle: the session's display title. A /rename (`custom-title`,
// re-appended every turn) wins over the generated `ai-title`; Claude stops
// generating ai-title once a custom title exists, so reading ai-title alone
// left such sessions untitled. Unlike Claude, the web drops a custom title
// inherited across /clear (/new): Claude writes it as the new transcript's
// first line, and on a page that shows titles a previous conversation's name
// misleads — the card falls back to the worktree / cwd basename until the
// session is renamed to something else (the terminal keeps the old name).
func lastClaudeAITitle(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return ""
	}
	const window = 512 << 10
	start := info.Size() - window
	if start < 0 {
		start = 0
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return ""
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return ""
	}
	text := string(data)
	if start > 0 {
		if i := strings.IndexByte(text, '\n'); i >= 0 {
			text = text[i+1:]
		}
	}
	lines := strings.Split(text, "\n")
	inherited := inheritedClaudeTitle(f)
	aiTitle := ""
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" || !strings.Contains(line, "-title\"") {
			continue
		}
		var row struct {
			Type        string `json:"type"`
			AITitle     string `json:"aiTitle"`
			CustomTitle string `json:"customTitle"`
		}
		if json.Unmarshal([]byte(line), &row) != nil {
			continue
		}
		if row.Type == "custom-title" && row.CustomTitle != "" {
			if row.CustomTitle == inherited {
				continue
			}
			return row.CustomTitle
		}
		if row.Type == "ai-title" && row.AITitle != "" && aiTitle == "" {
			aiTitle = row.AITitle
		}
	}
	return aiTitle
}

// inheritedClaudeTitle: the custom title carried in from the previous
// conversation by /clear — the transcript's first line when it is a
// custom-title row (a session renamed later never starts with one).
func inheritedClaudeTitle(f *os.File) string {
	head := make([]byte, 64<<10)
	n, _ := f.ReadAt(head, 0)
	line := head[:n]
	if i := strings.IndexByte(string(line), '\n'); i >= 0 {
		line = line[:i]
	}
	var row struct {
		Type        string `json:"type"`
		CustomTitle string `json:"customTitle"`
	}
	if json.Unmarshal(line, &row) != nil || row.Type != "custom-title" {
		return ""
	}
	return row.CustomTitle
}

// pastedTag: Claude Code wraps a multi-line paste — every phone message with
// an attachment block arrives by paste-buffer — in
// <pasted_content id="…">…</pasted_content id="…">. Without unwrapping, the
// "starts with <" harness filter dropped those messages and the phone kept
// them in its send queue forever.
var pastedTag = regexp.MustCompile(`</?pasted_content(?: id="[^"]*")?>`)

// unwrapPasted strips paste wrappers and surrounding blank lines.
func unwrapPasted(s string) string {
	return strings.TrimSpace(pastedTag.ReplaceAllString(s, ""))
}

// claudeMessageText pulls plain text out of a Claude message content field
// (string or [{type:text,text}…] blocks).
func claudeMessageText(content json.RawMessage) string {
	var s string
	if json.Unmarshal(content, &s) == nil {
		return strings.TrimSpace(s)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(content, &blocks) != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

// claudeAPIErrorText: Claude's synthetic API Error row (isApiErrorMessage),
// same text the TUI prints. Empty when the line is not an API error.
func claudeAPIErrorText(isAPIError bool, model, contentText string) string {
	text := strings.TrimSpace(contentText)
	if isAPIError && text != "" {
		return text
	}
	// Older / partial rows: synthetic model + "API Error:" prefix.
	if strings.HasPrefix(model, "<") && strings.HasPrefix(text, "API Error:") {
		return text
	}
	return ""
}

func (t *transcript) feedLine(raw []byte) {
	var line struct {
		Type             string          `json:"type"`
		Subtype          string          `json:"subtype"`
		Timestamp        string          `json:"timestamp"`
		Content          json.RawMessage `json:"content"` // system lines (local_command)
		IsMeta           bool            `json:"isMeta"`
		IsCompactSummary bool            `json:"isCompactSummary"`
		IsAPIErrorMessage bool           `json:"isApiErrorMessage"`
		// on each user line: auto | plan | bypassPermissions | default …
		PermissionMode  string `json:"permissionMode"`
		CompactMetadata struct {
			Trigger string `json:"trigger"`
		} `json:"compactMetadata"`
		Message struct {
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
			// skill_listing: content (string), names ([]string), isInitial —
			// raw, since other attachment types use these keys differently
			Content   json.RawMessage `json:"content"`
			Names     json.RawMessage `json:"names"`
			IsInitial bool            `json:"isInitial"`
			Origin    struct {
				Kind string `json:"kind"`
				From string `json:"from"`
				Body string `json:"body"`
			} `json:"origin"`
		} `json:"attachment"`
		// the Agent tool's own result: since the hand-back protocol the
		// tool_result text is only a pointer ("delivered to you as a
		// message"), the report itself rides here and in a peer message
		ToolUseResult struct {
			AgentID        string `json:"agentId"`
			HandbackReport struct {
				Text string `json:"text"`
			} `json:"handbackReport"`
			// Edit / Write: the real hunks with line numbers (the call's
			// input only has old / new strings)
			StructuredPatch []patchHunk `json:"structuredPatch"`
		} `json:"toolUseResult"`
	}
	if json.Unmarshal(raw, &line) != nil || line.IsMeta {
		return
	}
	// API Error (500 / verification_required / …): the TUI prints it and
	// returns to the prompt; Stop often never fires. Surface as system
	// kind=error so the phone matches the terminal, not an assistant bubble.
	if line.Type == "assistant" {
		if errText := claudeAPIErrorText(line.IsAPIErrorMessage, line.Message.Model, claudeMessageText(line.Message.Content)); errText != "" {
			t.messages = append(t.messages, chatMessage{
				Role: "system", Kind: "error", Text: clip(errText, 4000), TS: line.Timestamp,
			})
			return
		}
	}
	// the newest mode wins: the web status bar shows it like Claude's own
	if line.PermissionMode != "" {
		t.mode = line.PermissionMode
	}
	// A message typed (or sent from the phone) while Claude is mid-turn is
	// queued and lands as an attachment, not a user line. Keep the human
	// ones; task notifications, subagent hand-backs and auto-continuations
	// are harness traffic.
	// A background task's notification (a Monitor event, a background
	// command or a Monitor ending): onto the call that started it
	if a := line.Attachment; line.Type == "attachment" && a.Type == "skill_listing" {
		var content string
		var names []string
		_ = json.Unmarshal(a.Content, &content)
		_ = json.Unmarshal(a.Names, &names)
		t.feedClaudeSkillListing(content, names, a.IsInitial)
		return
	}
	if a := line.Attachment; line.Type == "attachment" && a.Type == "queued_command" && a.CommandMode == "task-notification" {
		t.taskNotification(a.Prompt, line.Timestamp)
		return
	}
	if a := line.Attachment; line.Type == "attachment" && a.Type == "queued_command" && a.CommandMode == "prompt" {
		prompt := unwrapPasted(a.Prompt)
		// a subagent's hand-back (background ones report only this way):
		// show the report as its Agent call's result
		if a.Origin.Kind == "peer" {
			if idx, ok := t.agents[a.Origin.From]; ok {
				if report := handbackReport(a.Origin.Body); report != "" {
					t.messages[idx].Result = clipLines(clip(report, 3000), 40)
					t.messages[idx].Pending = false
				}
			}
			return
		}
		human := a.Origin.Kind == "human" || (a.Origin.Kind == "" && !strings.HasPrefix(prompt, "<"))
		if human && prompt != "" {
			t.messages = append(t.messages, chatMessage{Role: "user", Text: clip(prompt, 8000), TS: line.Timestamp})
		}
		return
	}
	// Context compaction: a boundary line, then a user line carrying the
	// summary. The boundary becomes a compact marker (the phone draws a
	// divider and stops "load earlier" there); the summary rides on it
	// instead of showing up as something the human typed.
	if line.Type == "system" && line.Subtype == "compact_boundary" {
		t.markCompact(line.CompactMetadata.Trigger, line.Timestamp)
		return
	}
	if line.Type == "user" && line.IsCompactSummary {
		var summary string
		if json.Unmarshal(line.Message.Content, &summary) != nil {
			var blocks []struct {
				Text string `json:"text"`
			}
			_ = json.Unmarshal(line.Message.Content, &blocks)
			for _, b := range blocks {
				summary += b.Text
			}
		}
		t.attachCompactSummary(summary)
		return
	}
	// slash commands and their output (claude_command.go): /model, /compact,
	// /resume … as a user line or a system local_command line
	if t.feedCommand(line.Type, line.Subtype, line.Content, line.Message.Content, line.Timestamp) {
		return
	}
	if line.Type != "user" && line.Type != "assistant" {
		return
	}
	if line.Type == "user" {
		t.markStepStart(line.Timestamp)
	}
	if u := line.Message.Usage; line.Type == "assistant" && u != nil && line.Message.ID != t.lastMsg {
		t.lastMsg = line.Message.ID
		if line.Message.Model != "" && !strings.HasPrefix(line.Message.Model, "<") {
			t.usage.Model = line.Message.Model
		}
		t.usage.Context = u.Input + u.CacheWrite + u.CacheRead
		t.usage.ContextPending = false
		t.usage.Turns++
		t.usage.Output += u.OutputCount
		t.markOutput(line.Timestamp, u.OutputCount)
		t.usage.Input += u.Input + u.CacheWrite
		t.usage.CacheRead += u.CacheRead
	}
	var text string
	if json.Unmarshal(line.Message.Content, &text) == nil {
		// an idle session gets its task notification as a user line (it
		// starts the next turn): the same as a queued one
		if line.Type == "user" && strings.HasPrefix(strings.TrimSpace(text), "<task-notification>") {
			t.taskNotification(text, line.Timestamp)
			return
		}
		if text = unwrapPasted(text); line.Type == "user" && text != "" && !strings.HasPrefix(text, "<") {
			t.messages = append(t.messages, chatMessage{Role: "user", Text: clip(text, 8000), TS: line.Timestamp})
		}
		return
	}
	// images in this line, numbered in walk order (direct blocks and
	// tool_result parts alike) — transcriptImage walks the same way
	nImage := 0
	nextRef := func() string {
		ref := fmt.Sprintf("%d.%d", t.lineOff, nImage)
		nImage++
		return ref
	}
	var pasted []string
	userAt := -1
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
			text := b.Text
			if line.Type == "user" {
				if text = unwrapPasted(text); strings.HasPrefix(text, "<") {
					continue
				}
			}
			t.messages = append(t.messages, chatMessage{Role: line.Type, Text: clip(text, 8000), TS: line.Timestamp})
			if line.Type == "user" {
				userAt = len(t.messages) - 1
			}
		case b.Type == "image":
			pasted = append(pasted, nextRef())
		case b.Type == "tool_use":
			var input map[string]any
			_ = json.Unmarshal(b.Input, &input)
			file, added, removed := toolStats(b.Name, input)
			t.messages = append(t.messages, chatMessage{Role: "tool", Tool: b.Name, Text: toolSummary(b.Name, input),
				Body: toolBody(b.Name, input), TS: line.Timestamp, File: file, Added: added, Removed: removed,
				Kind: claudeAdapter{}.ToolKind(b.Name, input), Background: input["run_in_background"] == true})
			if b.ID != "" {
				t.tools[b.ID] = len(t.messages) - 1
				t.messages[len(t.messages)-1].Pending = true
				t.messages[len(t.messages)-1].rawInput = input
			}
		case b.Type == "tool_result":
			idx, ok := t.tools[b.ToolUseID]
			if !ok {
				nImage += countImages(b.Content)
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
					switch p.Type {
					case "text":
						out += p.Text + "\n"
					case "image":
						t.messages[idx].Images = append(t.messages[idx].Images, nextRef())
					}
				}
			}
			if report := strings.TrimSpace(line.ToolUseResult.HandbackReport.Text); report != "" {
				out = report
			}
			if id := line.ToolUseResult.AgentID; id != "" {
				if t.agents == nil {
					t.agents = map[string]int{}
				}
				t.agents[id] = idx
			}
			t.messages[idx].Result = clipLines(clip(out, 3000), 40)
			t.messages[idx].Pending = false
			t.messages[idx].rawInput = nil
			t.trackTask(idx, out)
			if body := patchBody(line.ToolUseResult.StructuredPatch); body != "" {
				t.messages[idx].Body = body
			}
			delete(t.tools, b.ToolUseID)
		}
	}
	if len(pasted) > 0 && line.Type == "user" {
		if userAt < 0 {
			t.messages = append(t.messages, chatMessage{Role: "user", TS: line.Timestamp})
			userAt = len(t.messages) - 1
		}
		t.messages[userAt].Images = append(t.messages[userAt].Images, pasted...)
	}
}

// countImages: image parts inside a tool_result content (string content has none).
func countImages(content json.RawMessage) int {
	var parts []struct {
		Type string `json:"type"`
	}
	n := 0
	if json.Unmarshal(content, &parts) == nil {
		for _, p := range parts {
			if p.Type == "image" {
				n++
			}
		}
	}
	return n
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
	if strings.HasPrefix(strings.ToLower(model), "gemini-") {
		return 1000000
	}
	return 200000
}

// handbackReport: the report inside a "[Subagent hand-back]" peer message —
// after the frame's "The report follows:" line, each line indented two
// spaces by the harness.
func handbackReport(body string) string {
	const marker = "The report follows:"
	i := strings.Index(body, marker)
	if !strings.HasPrefix(strings.TrimSpace(body), "[Subagent hand-back]") || i < 0 {
		return ""
	}
	lines := strings.Split(strings.TrimPrefix(body[i+len(marker):], "\n"), "\n")
	for j, l := range lines {
		lines[j] = strings.TrimPrefix(l, "  ")
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

// Background tasks (Monitor, Bash run_in_background): the call's result names
// the task; its events and its end arrive later as task-notification
// attachments, which used to be dropped as harness traffic — a Monitor showed
// as a call that never said anything, a background command never finished.
var (
	// only the start of the starting call's own result: a command whose
	// output merely quotes such a line (a grep of a transcript) is no task
	taskIDPattern = regexp.MustCompile(`^(?:Monitor started \(task |Command running in background with ID: )([A-Za-z0-9_-]+)`)
	taskTag       = func(name string) *regexp.Regexp {
		return regexp.MustCompile(`(?s)<` + name + `>(.*?)</` + name + `>`)
	}
	taskIDTag      = taskTag("task-id")
	taskEventTag   = taskTag("event")
	taskStatusTag  = taskTag("status")
	taskSummaryTag = taskTag("summary")
)

// monitorEventsKept: a Monitor's result keeps its newest events
const monitorEventsKept = 40

func (t *transcript) trackTask(idx int, out string) {
	if msg := t.messages[idx]; msg.Tool != "Monitor" && !msg.Background {
		return
	}
	m := taskIDPattern.FindStringSubmatch(strings.TrimSpace(out))
	if m == nil {
		return
	}
	if t.tasks == nil {
		t.tasks = map[string]int{}
	}
	t.tasks[m[1]] = idx
	if t.messages[idx].Tool == "Monitor" {
		// live until its stream ends; its events become the result
		t.messages[idx].Result = ""
		t.messages[idx].Pending = true
	}
}

// taskNotification: a Monitor event, a Monitor ending or a background
// command's end. It shows in the thread where it arrived, as the terminal
// prints it (a quiet system row, kind "task": text = the summary, body =
// the event's lines), and lands on the call that started the task (its
// result) when that call is known.
func (t *transcript) taskNotification(prompt, ts string) {
	if t.seenNotes == nil {
		t.seenNotes = map[string]bool{}
	}
	if t.seenNotes[prompt] {
		return // queued and then delivered: one row
	}
	t.seenNotes[prompt] = true
	summary := strings.TrimSpace(html.UnescapeString(firstGroup(taskSummaryTag, prompt)))
	eventText := strings.TrimSpace(html.UnescapeString(firstGroup(taskEventTag, prompt)))
	if summary != "" || eventText != "" {
		t.messages = append(t.messages, chatMessage{Role: "system", Kind: "task",
			Text: clip(summary, 300), Body: clipLines(clip(eventText, 3000), 20), TS: ts})
	}
	t.attachTaskNote(prompt)
}

// attachTaskNote: the notification onto the call that started the task.
func (t *transcript) attachTaskNote(prompt string) {
	id := firstGroup(taskIDTag, prompt)
	idx, ok := t.tasks[id]
	if !ok || idx >= len(t.messages) {
		return
	}
	msg := &t.messages[idx]
	if event := strings.TrimSpace(firstGroup(taskEventTag, prompt)); event != "" {
		lines := strings.Split(strings.TrimRight(msg.Result+event, "\n"), "\n")
		if len(lines) > monitorEventsKept {
			lines = lines[len(lines)-monitorEventsKept:]
		}
		msg.Result = clip(strings.Join(lines, "\n"), 3000) + "\n"
		return
	}
	if status := firstGroup(taskStatusTag, prompt); status != "" {
		msg.Pending = false
		if summary := strings.TrimSpace(firstGroup(taskSummaryTag, prompt)); summary != "" {
			msg.Result = strings.TrimRight(msg.Result, "\n")
			if msg.Result != "" {
				msg.Result += "\n"
			}
			msg.Result += "— " + summary
		}
		delete(t.tasks, id)
	}
}

func firstGroup(re *regexp.Regexp, s string) string {
	if m := re.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return ""
}
