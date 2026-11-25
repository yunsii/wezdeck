package main

// Codex adapter: rollout-*.jsonl lines (messages, tool calls, token_count).

import (
	"encoding/json"
	"strings"
)

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
	case line.Type == "response_item" && p.Type == "message" && p.Role == "developer":
		for _, c := range p.Content {
			if t.feedCodexSkills(c.Text) {
				break
			}
		}
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
