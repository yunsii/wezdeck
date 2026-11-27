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
	Header      string         `json:"header,omitempty"` // short chip label (Claude)
	Question    string         `json:"question"`
	Options     []elicitOption `json:"options"`
	MultiSelect bool           `json:"multi_select,omitempty"`
}

type elicitation struct {
	ToolCallID string           `json:"tool_call_id,omitempty"`
	Questions  []elicitQuestion `json:"questions"`
	// CurrentStep: 1-based active question index read from the TUI pane (Agy
	// "Question X/Y:"), so multi-question cards stay synced with the terminal.
	CurrentStep int `json:"current_step,omitempty"`
	// Review: every question is answered and the TUI waits on its "Submit
	// answers" page (Claude, read from the pane) — Enter sends them
	Review bool `json:"review,omitempty"`
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

// toolCallSettled: the call finished or was aborted — web must not keep the
// Ask / plan-review card. Ctrl+C mid-turn often never writes "completed"
// (see turn_completed stop_reason=cancelled); failed / rejected land here too.
func toolCallSettled(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed", "failed", "cancelled", "canceled", "error", "rejected":
		return true
	default:
		return false
	}
}

// pendingGrokElicitation finds the newest unanswered ask_user_question in updates.jsonl.
func pendingGrokElicitation(chatHistoryPath string) *elicitation {
	updatesPath := filepath.Join(filepath.Dir(chatHistoryPath), "updates.jsonl")
	data, err := readTailFile(updatesPath, 2<<20)
	if err != nil {
		return nil
	}
	settled := map[string]bool{}
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
			if toolCallSettled(u.Status) && u.ToolCallID != "" {
				settled[u.ToolCallID] = true
			}
			// Some builds only put AskUserQuestion on the update row.
			if len(u.RawInput) > 0 && bytes.Contains(u.RawInput, []byte(`"AskUserQuestion"`)) {
				pendingID = u.ToolCallID
				pendingRaw = u.RawInput
			}
		case "turn_completed":
			// Ctrl+C / Esc abort: Ask stays without status=completed. The turn
			// ended, so drop any open Ask from this turn; a later Ask reopens.
			pendingID = ""
			pendingRaw = nil
		}
	}
	if pendingID == "" || settled[pendingID] || len(pendingRaw) == 0 {
		return nil
	}
	return parseAskQuestions(pendingID, pendingRaw)
}

// parseAskQuestions reads an AskUserQuestion input ({questions:[{question,
// header, multiSelect, options:[{label, description}]}]}), Grok and Claude
// alike.
func parseAskQuestions(id string, input json.RawMessage) *elicitation {
	var raw struct {
		Questions []struct {
			Question    string `json:"question"`
			Header      string `json:"header"`
			MultiSelect *bool  `json:"multiSelect"`
			Options     []struct {
				Label       string `json:"label"`
				Description string `json:"description"`
			} `json:"options"`
		} `json:"questions"`
	}
	if json.Unmarshal(input, &raw) != nil || len(raw.Questions) == 0 {
		return nil
	}
	out := &elicitation{ToolCallID: id}
	for _, q := range raw.Questions {
		eq := elicitQuestion{Question: q.Question, Header: q.Header}
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

// grokPlanModeFile reads sibling plan_mode.json (Active / awaiting flags).
type grokPlanMode struct {
	Active   bool // state == "Active"
	Awaiting bool
	Known    bool // file present and parsed
}

func grokPlanModeFile(chatHistoryPath string) grokPlanMode {
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(chatHistoryPath), "plan_mode.json"))
	if err != nil {
		return grokPlanMode{}
	}
	var doc struct {
		State    string `json:"state"`
		Awaiting *bool  `json:"awaiting_plan_approval"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return grokPlanMode{}
	}
	out := grokPlanMode{Known: true, Active: strings.EqualFold(doc.State, "Active")}
	if doc.Awaiting != nil {
		out.Awaiting = *doc.Awaiting
	}
	return out
}

// grokAwaitingPlanApprovalFile: when the file says awaiting_plan_approval=false,
// updates.jsonl alone must not keep the web on the plan-review card after
// Ctrl+C / quit (exit_plan_mode often has no status=completed).
func grokAwaitingPlanApprovalFile(chatHistoryPath string) (awaiting bool, known bool) {
	m := grokPlanModeFile(chatHistoryPath)
	if !m.Known {
		return false, false
	}
	return m.Awaiting, true
}

// pendingGrokPlanApproval: exit_plan_mode opened the TUI review and has not completed.
func pendingGrokPlanApproval(chatHistoryPath string) bool {
	if awaiting, known := grokAwaitingPlanApprovalFile(chatHistoryPath); known && !awaiting {
		return false
	}
	updatesPath := filepath.Join(filepath.Dir(chatHistoryPath), "updates.jsonl")
	data, err := readTailFile(updatesPath, 2<<20)
	if err != nil {
		return false
	}
	settled := map[string]bool{}
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
			if toolCallSettled(u.Status) && u.ToolCallID != "" {
				settled[u.ToolCallID] = true
			}
			// Some builds title the update "Plan mode exited" / similar after approve.
			if u.Title == "exit_plan_mode" && u.ToolCallID != "" && u.Status == "" {
				pendingID = u.ToolCallID
			}
		case "turn_completed":
			pendingID = ""
		}
	}
	return pendingID != "" && !settled[pendingID]
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

// Grok's askReader / planReader parts (agent_adapter.go): questions and the
// plan file live beside chat_history.jsonl; disk is the truth, since an
// unanswered Ask may outlive a flaky waiting flag.
func (grokAdapter) PendingAsk(path, _ string) *elicitation { return pendingGrokElicitation(path) }
func (grokAdapter) PendingPlan(path string) map[string]any {
	// Match the Grok TUI: only surface plan.md when exit_plan_mode opened
	// review (awaiting approval). plan mode Active while the agent is still
	// writing must not flash 「当前计划」 on the web ahead of the terminal.
	if !pendingGrokPlanApproval(path) {
		return nil
	}
	plan := map[string]any{"awaiting_approval": true}
	if excerpt := grokPlanExcerpt(path, 8000); excerpt != "" {
		plan["excerpt"] = excerpt
	}
	return plan
}
func (grokAdapter) PlanTool() string { return "" }

// grokSummaryModel reads the model and reasoning effort Grok keeps in
// summary.json beside chat_history.jsonl. A session with no reply yet has no
// model in its transcript; the web console's empty state names it from this
// (structured data, not the TUI's screen).
func grokSummaryModel(chatHistoryPath string) (model, effort string) {
	if chatHistoryPath == "" {
		return "", ""
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(chatHistoryPath), "summary.json"))
	if err != nil {
		return "", ""
	}
	var s struct {
		Model  string `json:"current_model_id"`
		Effort string `json:"reasoning_effort"`
	}
	if json.Unmarshal(raw, &s) != nil {
		return "", ""
	}
	return s.Model, s.Effort
}
