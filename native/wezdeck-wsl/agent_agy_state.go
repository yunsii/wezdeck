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
	"regexp"
	"strconv"
	"strings"
)

var agyAskStepRe = regexp.MustCompile(`Question\s+(\d+)/(\d+)`)

// agyAskCurrentStep parses Agy's "Question X/Y:" header from the pane tail so
// multi-question prompts stay synced with the live TUI step (1-based, 0 if absent).
func agyAskCurrentStep(screen string, total int) int {
	if total <= 1 {
		return 0
	}
	tail := agyScreenTail(screen, 30)
	if tail == "" {
		return 0
	}
	step := 0
	for _, m := range agyAskStepRe.FindAllStringSubmatch(tail, -1) {
		if len(m) != 3 {
			continue
		}
		cur, err1 := strconv.Atoi(m[1])
		tot, err2 := strconv.Atoi(m[2])
		if err1 == nil && err2 == nil && tot == total && cur >= 1 && cur <= total {
			step = cur
		}
	}
	return step
}

// PendingAsk implements askReader: returns the newest unanswered ask_question
// tool call in transcript_full.jsonl so the web renders tappable options.
func (agyAdapter) PendingAsk(path, screen string) *elicitation {
	el := pendingAgyElicitation(path)
	if el != nil && len(el.Questions) > 1 {
		el.CurrentStep = agyAskCurrentStep(screen, len(el.Questions))
	}
	return el
}

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

// agyParseMenuLine strips box borders, detects a selection cursor (> / ❯ / ▸ / ›),
// and strips optional numbering ("1. ", "2. ") from a single terminal line so
// option labels only match actual menu rows, never assistant prose.
func agyParseMenuLine(line string) (text string, selected bool, numbered bool) {
	s := strings.TrimSpace(line)
	for {
		trimmed := strings.TrimLeft(s, "│┃| ")
		if trimmed == s {
			break
		}
		s = trimmed
	}
	for {
		trimmed := strings.TrimLeft(s, ">❯▸›●•*-")
		if trimmed == s {
			break
		}
		selected = true
		s = strings.TrimSpace(trimmed)
	}
	if len(s) >= 3 && s[0] >= '1' && s[0] <= '9' && s[1] == '.' && s[2] == ' ' {
		return strings.TrimSpace(s[3:]), selected, true
	}
	return s, selected, false
}

func agyMenuKeys(targetIdx, selectedIdx int) []string {
	var keys []string
	for i := selectedIdx; i < targetIdx; i++ {
		keys = append(keys, "Down")
	}
	for i := targetIdx; i < selectedIdx; i++ {
		keys = append(keys, "Up")
	}
	return append(keys, "Enter")
}

// agyPermissionOptions parses the live confirmation menu from the tail of an
// Agy pane, returning ordered options with the exact key sequence relative to
// the currently highlighted row. Returns nil when no permission menu is visible
// (e.g. workspace trust dialog or assistant prose quoting option labels).
func agyPermissionOptions(screen string) []permissionOption {
	tail := agyScreenTail(screen, 18)
	if tail == "" || agyTrustPrompt(tail) {
		return nil
	}
	type rawOpt struct {
		label    string
		kind     string
		selected bool
		alwaysNo bool
	}
	var rawOpts []rawOpt
	var hasYes, hasNo, hasHeader bool
	for _, raw := range strings.Split(tail, "\n") {
		line, selected, numbered := agyParseMenuLine(raw)
		if line == "" {
			continue
		}
		switch {
		case strings.HasPrefix(line, "Yes, and always allow"),
			strings.HasPrefix(line, "Yes, always allow"),
			strings.HasPrefix(line, "Always allow"):
			hasYes = true
			rawOpts = append(rawOpts, rawOpt{label: line, kind: "always", selected: selected})
		case strings.HasPrefix(line, "Yes, run command"),
			strings.HasPrefix(line, "Yes, accept this change"),
			strings.HasPrefix(line, "Yes, allow access"),
			strings.HasPrefix(line, "Yes, allow creation"),
			strings.HasPrefix(line, "Yes, allow tool call"),
			numbered && line == "Yes":
			hasYes = true
			rawOpts = append(rawOpts, rawOpt{label: line, kind: "allow", selected: selected})
		case strings.HasPrefix(line, "No, and always deny"):
			hasNo = true
			rawOpts = append(rawOpts, rawOpt{label: line, kind: "deny", selected: selected, alwaysNo: true})
		case strings.HasPrefix(line, "No, deny"),
			numbered && line == "No":
			hasNo = true
			rawOpts = append(rawOpts, rawOpt{label: line, kind: "deny", selected: selected})
		case line == "Run this command?",
			line == "Allow access to this URL?",
			line == "Allow calling this tool?",
			line == "Do you want to proceed?":
			hasHeader = true
		}
	}
	if !hasYes || (!hasNo && !hasHeader) || len(rawOpts) == 0 {
		return nil
	}
	selectedIdx := 0
	for i, opt := range rawOpts {
		if opt.selected {
			selectedIdx = i
			break
		}
	}
	out := make([]permissionOption, 0, len(rawOpts))
	for i, opt := range rawOpts {
		keys := agyMenuKeys(i, selectedIdx)
		if opt.kind == "deny" && !opt.alwaysNo {
			keys = []string{"Escape"}
		}
		out = append(out, permissionOption{
			Label: opt.label,
			Kind:  opt.kind,
			Keys:  keys,
		})
	}
	return out
}

// agyPermissionPromptVisible reports whether the tail of an Agy pane currently
// displays a tool/command permission confirmation dialog (distinct from the
// first-open workspace trust dialog and from ordinary assistant prose).
func agyPermissionPromptVisible(screen string) bool {
	return len(agyPermissionOptions(screen)) > 0
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

// applyAgyScreenPermission surfaces a pending Agy tool call as a permission
// prompt card when the TUI is blocked on a confirmation dialog (Agy has no
// PermissionRequest lifecycle hook). Requires an active turn and an unanswered
// tool call from the full transcript so completed turns or quoted prose never
// lock the web composer. Reports whether status was escalated.
func applyAgyScreenPermission(out map[string]any, pending *pendingCall, screen string) bool {
	if _, already := out["permission"]; already || pending == nil {
		return false
	}
	status, _ := out["status"].(string)
	if status != "running" && status != "waiting" {
		return false
	}
	opts := agyPermissionOptions(screen)
	if len(opts) == 0 {
		return false
	}
	copyCall := *pending
	copyCall.Options = opts
	out["permission"] = &copyCall
	out["status"] = "waiting"
	out["waiting_kind"] = "permission_prompt"
	return true
}

// agyListCardWaiting reports whether a running Agy session with an unanswered
// tool call is currently displaying a permission confirmation dialog in its
// tmux pane, so the session list / unread badge / Alt+j match the detail page.
func agyListCardWaiting(e attentionEntry, path string) bool {
	if e.Status != "running" || e.WaitingKind != "" || e.TmuxPane == "" || path == "" {
		return false
	}
	tr, err := loadTranscript(path, "agy")
	if err != nil || tr == nil {
		return false
	}
	transcriptsMu.Lock()
	pending := pendingPermission(tr.messages, "")
	transcriptsMu.Unlock()
	if pending == nil {
		return false
	}
	screen, err := tmuxCmd(e.TmuxSocket, "capture-pane", "-p", "-J", "-t", e.TmuxPane, "-S", "-30").Output()
	if err != nil {
		return false
	}
	return agyPermissionPromptVisible(strings.TrimRight(string(screen), "\n "))
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
