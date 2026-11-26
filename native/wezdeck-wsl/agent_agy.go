package main

// Antigravity CLI writes one JSONL step per user input, model response and
// tool phase under brain/<conversation-id>/.system_generated/logs/.

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type agyAdapter struct{}

func (agyAdapter) Name() string { return "agy" }
func (agyAdapter) Locate(home, id string) string {
	path := filepath.Join(home, ".gemini", "antigravity-cli", "brain", id,
		".system_generated", "logs", "transcript_full.jsonl")
	if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
		return path
	}
	return ""
}
func (agyAdapter) Feed(t *transcript, raw []byte) { t.feedAgy(raw) }
func (agyAdapter) ToolKind(name string, input map[string]any) string {
	return toolKindByName(agyToolKinds, name, input)
}
func (agyAdapter) Capabilities() agentCaps {
	return agentCaps{Usage: "transcript", MidTurnInput: "queue", Title: true}
}

var agyToolKinds = map[string]string{
	"run_command": toolKindCommand, "view_file": toolKindRead, "read_file": toolKindRead,
	"write_to_file": toolKindWrite, "replace_file_content": toolKindEdit,
	"multi_replace_file_content": toolKindEdit, "grep_search": toolKindSearch,
	"find_by_name": toolKindSearch, "list_dir": toolKindSearch,
	"search_web": toolKindWeb, "read_url_content": toolKindWeb,
	"invoke_subagent": toolKindTask, "ask_question": toolKindAsk,
}

func (agyAdapter) Title(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 16<<10), 1<<20)
	for scanner.Scan() {
		var row struct {
			Type    string `json:"type"`
			Content string `json:"content"`
		}
		if json.Unmarshal(scanner.Bytes(), &row) == nil && row.Type == "USER_INPUT" {
			return clip(row.Content, 80)
		}
	}
	return ""
}

func (t *transcript) feedAgy(raw []byte) {
	var row struct {
		Type            string `json:"type"`
		Content         string `json:"content"`
		CreatedAt       string `json:"created_at"`
		Model           string `json:"model"`
		InputTokens     int    `json:"input_tokens"`
		CacheReadTokens int    `json:"cache_read_tokens"`
		OutputTokens    int    `json:"output_tokens"`
		ToolCalls       []struct {
			Name string         `json:"name"`
			Args map[string]any `json:"args"`
		} `json:"tool_calls"`
	}
	if json.Unmarshal(raw, &row) != nil {
		return
	}
	t.advanceAgyStep(row.Type, row.CreatedAt)
	switch row.Type {
	case "USER_INPUT":
		if text := strings.TrimSpace(row.Content); text != "" {
			t.messages = append(t.messages, chatMessage{Role: "user", Text: clip(text, 8000), TS: row.CreatedAt})
		}
	case "PLANNER_RESPONSE":
		if text := strings.TrimSpace(row.Content); text != "" {
			t.messages = append(t.messages, chatMessage{Role: "assistant", Text: clip(text, 8000), TS: row.CreatedAt})
		}
		for _, call := range row.ToolCalls {
			args, err := json.Marshal(call.Args)
			if err == nil {
				t.addTool("", call.Name, string(args), row.CreatedAt)
			}
		}
		if row.Model != "" {
			t.usage.Model = row.Model
		}
		t.usage.Turns++
		t.usage.Context = row.InputTokens + row.CacheReadTokens
		t.usage.Input += row.InputTokens
		t.usage.CacheRead += row.CacheReadTokens
		t.usage.Output += row.OutputTokens
		t.markAgyStepOpen(row.CreatedAt, row.OutputTokens, len(row.ToolCalls))
	}
}

func handoffDigestAgy(raw []byte, users *[]string, files map[string]struct{}, lastAssist *string) {
	var row struct {
		Type      string `json:"type"`
		Content   string `json:"content"`
		ToolCalls []struct {
			Args map[string]any `json:"args"`
		} `json:"tool_calls"`
	}
	if json.Unmarshal(raw, &row) != nil {
		return
	}
	switch row.Type {
	case "USER_INPUT":
		if row.Content != "" {
			*users = append(*users, row.Content)
		}
	case "PLANNER_RESPONSE":
		if row.Content != "" {
			*lastAssist = clip(row.Content, 1200)
		}
		for _, call := range row.ToolCalls {
			if path := inputString(call.Args, "path", "AbsolutePath", "TargetFile", "file_path"); path != "" {
				files[path] = struct{}{}
			}
		}
	}
}
