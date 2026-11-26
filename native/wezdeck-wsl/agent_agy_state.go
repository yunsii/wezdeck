package main

// Agy session state beyond the message stream: execution mode detection,
// unanswered ask_question elicitation, and TUI permission prompt detection
// (Agy has no PermissionRequest hook, so a pending tool call + visible
// permission prompt in the pane tail surfaces the approval card on the web).

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// PendingAsk implements askReader: returns the newest unanswered ask_question
// tool call in transcript_full.jsonl so the web renders tappable options.
func (agyAdapter) PendingAsk(path, _ string) *elicitation { return pendingAgyElicitation(path) }

func pendingAgyElicitation(path string) *elicitation {
	data, err := readTailFile(path, 2<<20)
	if err != nil {
		return nil
	}
	type pendingCall struct {
		step int
		name string
		args json.RawMessage
	}
	var queue []pendingCall
	for _, line := range bytes.Split(data, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var row struct {
			StepIndex int    `json:"step_index"`
			Type      string `json:"type"`
			ToolCalls []struct {
				Name string          `json:"name"`
				Args json.RawMessage `json:"args"`
			} `json:"tool_calls"`
		}
		if json.Unmarshal(line, &row) != nil {
			continue
		}
		switch row.Type {
		case "USER_INPUT":
			queue = nil
		case "PLANNER_RESPONSE":
			queue = nil
			for _, tc := range row.ToolCalls {
				queue = append(queue, pendingCall{step: row.StepIndex, name: tc.Name, args: tc.Args})
			}
		case "GENERIC":
			if len(queue) > 0 {
				queue = queue[1:]
			}
		}
	}
	for i := len(queue) - 1; i >= 0; i-- {
		if queue[i].name == "ask_question" {
			return parseAgyAskQuestions("agy-step-"+strconv.Itoa(queue[i].step), queue[i].args)
		}
	}
	return nil
}

// parseAgyAskQuestions parses Agy's ask_question schema:
// {questions:[{question, options:["..."], is_multi_select}]}.
func parseAgyAskQuestions(id string, input json.RawMessage) *elicitation {
	var raw struct {
		Questions []struct {
			Question      string   `json:"question"`
			Options       []string `json:"options"`
			IsMultiSelect bool     `json:"is_multi_select"`
		} `json:"questions"`
	}
	if json.Unmarshal(input, &raw) != nil || len(raw.Questions) == 0 {
		return nil
	}
	out := &elicitation{ToolCallID: id}
	for _, q := range raw.Questions {
		if strings.TrimSpace(q.Question) == "" {
			continue
		}
		eq := elicitQuestion{Question: q.Question, MultiSelect: q.IsMultiSelect}
		for _, opt := range q.Options {
			if opt = strings.TrimSpace(opt); opt != "" {
				eq.Options = append(eq.Options, elicitOption{Label: opt})
			}
		}
		out.Questions = append(out.Questions, eq)
	}
	if len(out.Questions) == 0 {
		return nil
	}
	return out
}

// agyPermissionPromptVisible reports whether the tail of an Agy pane currently
// displays a tool/command permission confirmation dialog (distinct from the
// first-open workspace trust dialog and from ordinary assistant prose).
func agyPermissionPromptVisible(screen string) bool {
	tail := agyScreenTail(screen, 24)
	if tail == "" || agyTrustPrompt(tail) {
		return false
	}
	hasYes := strings.Contains(tail, "Yes, run command") ||
		strings.Contains(tail, "Yes, accept this change") ||
		strings.Contains(tail, "Yes, allow access") ||
		strings.Contains(tail, "Yes, allow creation") ||
		strings.Contains(tail, "Yes, allow tool call") ||
		strings.Contains(tail, "Yes, and always allow") ||
		strings.Contains(tail, "1. Yes")
	if !hasYes {
		return false
	}
	hasNo := strings.Contains(tail, "No, deny") ||
		strings.Contains(tail, "No, and always deny")
	hasHeader := strings.Contains(tail, "Run this command?") ||
		strings.Contains(tail, "Allow access to this URL?") ||
		strings.Contains(tail, "Allow calling this tool?") ||
		strings.Contains(tail, "Do you want to proceed?")
	return hasNo || hasHeader
}

func agyScreenTail(screen string, maxLines int) string {
	trimmed := strings.TrimRight(screen, "\n \t\r")
	if trimmed == "" {
		return ""
	}
	lines := strings.Split(trimmed, "\n")
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return strings.Join(lines, "\n")
}

func agyScreenPendingCall(screen string) *pendingCall {
	tail := agyScreenTail(screen, 16)
	header := "Run this command?"
	for _, line := range strings.Split(tail, "\n") {
		s := strings.TrimSpace(line)
		if strings.Contains(s, "Run this command?") ||
			strings.Contains(s, "Allow access to this URL?") ||
			strings.Contains(s, "Allow calling this tool?") ||
			strings.Contains(s, "Do you want to proceed?") {
			header = s
			break
		}
	}
	return &pendingCall{Tool: "agy", Text: header, Body: tail}
}

// applyAgyScreenPermission surfaces a pending Agy tool call as a permission
// prompt card when the TUI is blocked on a confirmation dialog (Agy has no
// PermissionRequest lifecycle hook). pending must come from the full
// transcript (not the incremental since-window slice).
func applyAgyScreenPermission(out map[string]any, pending *pendingCall, screen string) {
	if _, already := out["permission"]; already || !agyPermissionPromptVisible(screen) {
		return
	}
	if pending == nil {
		pending = agyScreenPendingCall(screen)
	}
	out["permission"] = pending
	out["status"] = "waiting"
	out["waiting_kind"] = "permission_prompt"
}

func normalizeAgyMode(raw string) string {
	s := strings.ToLower(strings.TrimSpace(strings.Trim(raw, "`'\"")))
	switch s {
	case "":
		return ""
	case "auto", "auto mode":
		return "auto"
	case "accept-edits", "accept edits", "acceptedits":
		return "accept-edits"
	case "plan", "plan mode":
		return "plan"
	case "full-access", "full access", "yolo", "bypasspermissions", "dangerously-skip-permissions":
		return "full-access"
	case "default", "default mode", "manual", "none":
		return "default"
	default:
		return s
	}
}

func agySettingsPath() string {
	if dir := strings.TrimSpace(os.Getenv("AGY_CONFIG_DIR")); dir != "" {
		return filepath.Join(dir, "settings.json")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".gemini", "antigravity-cli", "settings.json")
}

func agyModeFromSettings() string {
	body, err := os.ReadFile(agySettingsPath())
	if err != nil {
		return ""
	}
	var settings struct {
		AgentMode string `json:"agentMode"`
	}
	if json.Unmarshal(body, &settings) != nil {
		return ""
	}
	return normalizeAgyMode(settings.AgentMode)
}

func agyModeFromArgs(argv []string) string {
	mode := ""
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		if arg == "--dangerously-skip-permissions" {
			return "full-access"
		}
		if arg == "--mode" && i+1 < len(argv) {
			mode = normalizeAgyMode(argv[i+1])
			i++
			continue
		}
		if strings.HasPrefix(arg, "--mode=") {
			mode = normalizeAgyMode(strings.TrimPrefix(arg, "--mode="))
		}
	}
	return mode
}

// resolveAgyMode returns Agy's effective execution mode so the web console can
// always tell whether auto mode is on: in-session toggle > CLI flag > settings.json > default.
func resolveAgyMode(e attentionEntry, t *transcript) string {
	if t != nil && t.mode != "" {
		return t.mode
	}
	if e.TmuxPane != "" {
		argv := paneDescendantArgs(e.TmuxSocket, e.TmuxPane, func(comm string) bool { return comm == "agy" })
		if mode := agyModeFromArgs(argv); mode != "" {
			return mode
		}
	}
	if mode := agyModeFromSettings(); mode != "" {
		return mode
	}
	return "default"
}
