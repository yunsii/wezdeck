package main

// Claude Code adapter: transcript lines (~/.claude/projects/*/<id>.jsonl),
// ai-title, and the model catalog for the context limit.

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

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
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		var row struct {
			Type    string `json:"type"`
			AITitle string `json:"aiTitle"`
		}
		if json.Unmarshal([]byte(line), &row) == nil && row.Type == "ai-title" && row.AITitle != "" {
			return row.AITitle
		}
	}
	return ""
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
