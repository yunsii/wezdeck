package main

// Grok adapter: chat_history.jsonl lines, summary.json title, and the
// pending Ask / plan-review state from updates.jsonl.

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func grokSessionTitle(chatHistoryPath string) string {
	summaryPath := filepath.Join(filepath.Dir(chatHistoryPath), "summary.json")
	data, err := os.ReadFile(summaryPath)
	if err != nil {
		return ""
	}
	var doc struct {
		GeneratedTitle string `json:"generated_title"`
		SessionSummary string `json:"session_summary"`
	}
	if json.Unmarshal(data, &doc) != nil {
		return ""
	}
	if doc.GeneratedTitle != "" {
		return doc.GeneratedTitle
	}
	return doc.SessionSummary
}

type elicitOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type elicitQuestion struct {
	Question    string         `json:"question"`
	Options     []elicitOption `json:"options"`
	MultiSelect bool           `json:"multi_select,omitempty"`
}

type elicitation struct {
	ToolCallID string           `json:"tool_call_id,omitempty"`
	Questions  []elicitQuestion `json:"questions"`
}

// readTailFile reads the last window bytes of path (for huge updates.jsonl).
func readTailFile(path string, window int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	start := info.Size() - window
	if start < 0 {
		start = 0
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}
	if start > 0 {
		if i := bytes.IndexByte(data, '\n'); i >= 0 {
			data = data[i+1:]
		}
	}
	return data, nil
}

// pendingGrokElicitation finds the newest unanswered ask_user_question in updates.jsonl.
func pendingGrokElicitation(chatHistoryPath string) *elicitation {
	updatesPath := filepath.Join(filepath.Dir(chatHistoryPath), "updates.jsonl")
	data, err := readTailFile(updatesPath, 2<<20)
	if err != nil {
		return nil
	}
	completed := map[string]bool{}
	var pendingID string
	var pendingRaw json.RawMessage
	for _, line := range bytes.Split(data, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var row struct {
			Params struct {
				Update struct {
					SessionUpdate string          `json:"sessionUpdate"`
					ToolCallID    string          `json:"toolCallId"`
					Status        string          `json:"status"`
					Title         string          `json:"title"`
					RawInput      json.RawMessage `json:"rawInput"`
				} `json:"update"`
			} `json:"params"`
		}
		if json.Unmarshal(line, &row) != nil {
			continue
		}
		u := row.Params.Update
		switch u.SessionUpdate {
		case "tool_call":
			if u.Title == "ask_user_question" && len(u.RawInput) > 0 {
				pendingID = u.ToolCallID
				pendingRaw = u.RawInput
			}
		case "tool_call_update":
			if u.Status == "completed" && u.ToolCallID != "" {
				completed[u.ToolCallID] = true
			}
			// Some builds only put AskUserQuestion on the update row.
			if len(u.RawInput) > 0 && bytes.Contains(u.RawInput, []byte(`"AskUserQuestion"`)) {
				pendingID = u.ToolCallID
				pendingRaw = u.RawInput
			}
		}
	}
	if pendingID == "" || completed[pendingID] || len(pendingRaw) == 0 {
		return nil
	}
	var raw struct {
		Questions []struct {
			Question    string `json:"question"`
			MultiSelect *bool  `json:"multiSelect"`
			Options     []struct {
				Label       string `json:"label"`
				Description string `json:"description"`
			} `json:"options"`
		} `json:"questions"`
	}
	if json.Unmarshal(pendingRaw, &raw) != nil || len(raw.Questions) == 0 {
		return nil
	}
	out := &elicitation{ToolCallID: pendingID}
	for _, q := range raw.Questions {
		eq := elicitQuestion{Question: q.Question}
		if q.MultiSelect != nil {
			eq.MultiSelect = *q.MultiSelect
		}
		for _, o := range q.Options {
			eq.Options = append(eq.Options, elicitOption{Label: o.Label, Description: o.Description})
		}
		out.Questions = append(out.Questions, eq)
	}
	return out
}

// grokPlanExcerpt returns a short plan.md preview when present next to the transcript.
func grokPlanExcerpt(chatHistoryPath string, limit int) string {
	planPath := filepath.Join(filepath.Dir(chatHistoryPath), "plan.md")
	data, err := os.ReadFile(planPath)
	if err != nil || len(data) == 0 {
		return ""
	}
	text := strings.TrimSpace(string(data))
	if limit > 0 && len(text) > limit {
		// avoid cutting mid-rune
		r := []rune(text)
		if len(r) > limit {
			text = string(r[:limit]) + "…"
		}
	}
	return text
}

// pendingGrokPlanApproval: exit_plan_mode opened the TUI review and has not completed.
func pendingGrokPlanApproval(chatHistoryPath string) bool {
	updatesPath := filepath.Join(filepath.Dir(chatHistoryPath), "updates.jsonl")
	data, err := readTailFile(updatesPath, 2<<20)
	if err != nil {
		return false
	}
	completed := map[string]bool{}
	var pendingID string
	for _, line := range bytes.Split(data, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var row struct {
			Params struct {
				Update struct {
					SessionUpdate string `json:"sessionUpdate"`
					ToolCallID    string `json:"toolCallId"`
					Status        string `json:"status"`
					Title         string `json:"title"`
				} `json:"update"`
			} `json:"params"`
		}
		if json.Unmarshal(line, &row) != nil {
			continue
		}
		u := row.Params.Update
		switch u.SessionUpdate {
		case "tool_call":
			if u.Title == "exit_plan_mode" {
				pendingID = u.ToolCallID
			}
		case "tool_call_update":
			if u.Status == "completed" && u.ToolCallID != "" {
				completed[u.ToolCallID] = true
			}
			// Some builds title the update "Plan mode exited" / similar after approve.
			if u.Title == "exit_plan_mode" && u.ToolCallID != "" && u.Status == "" {
				pendingID = u.ToolCallID
			}
		}
	}
	return pendingID != "" && !completed[pendingID]
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
