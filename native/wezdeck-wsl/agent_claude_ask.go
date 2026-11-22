package main

// Claude's AskUserQuestion for the phone, as structured questions like Grok's
// (agent_grok.go): the newest AskUserQuestion tool_use in the transcript tail
// with no tool_result yet. With several questions the TUI ends on a review
// page ("Submit answers") that waits for Enter; review tells the phone so it
// can say "submit" instead of leaving the agent waiting.

import (
	"bytes"
	"encoding/json"
	"strings"
)

func pendingClaudeElicitation(path string) *elicitation {
	data, err := readTailFile(path, 2<<20)
	if err != nil {
		return nil
	}
	var pendingID string
	var pendingInput json.RawMessage
	answered := map[string]bool{}
	for _, line := range bytes.Split(data, []byte("\n")) {
		if !bytes.Contains(line, []byte(`"AskUserQuestion"`)) && !bytes.Contains(line, []byte(`"tool_result"`)) {
			continue
		}
		var row struct {
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(bytes.TrimSpace(line), &row) != nil {
			continue
		}
		var blocks []struct {
			Type      string          `json:"type"`
			ID        string          `json:"id"`
			Name      string          `json:"name"`
			Input     json.RawMessage `json:"input"`
			ToolUseID string          `json:"tool_use_id"`
		}
		if json.Unmarshal(row.Message.Content, &blocks) != nil {
			continue
		}
		for _, b := range blocks {
			switch {
			case b.Type == "tool_use" && b.Name == "AskUserQuestion" && b.ID != "":
				pendingID, pendingInput = b.ID, b.Input
			case b.Type == "tool_result" && b.ToolUseID != "":
				answered[b.ToolUseID] = true
			}
		}
	}
	if pendingID == "" || answered[pendingID] {
		return nil
	}
	return parseAskQuestions(pendingID, pendingInput)
}

// askReviewing: the pane shows the multi-question review page.
func askReviewing(screen string) bool {
	tail := screen
	if lines := strings.Split(screen, "\n"); len(lines) > 25 {
		tail = strings.Join(lines[len(lines)-25:], "\n")
	}
	return strings.Contains(tail, "Submit answers")
}
