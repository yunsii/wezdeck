package main

// Antigravity CLI writes one JSONL step per user input, model response and
// tool phase under brain/<conversation-id>/.system_generated/logs/.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
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
	"run_command": toolKindCommand, "manage_task": toolKindCommand,
	"view_file": toolKindRead, "read_file": toolKindRead,
	"write_file": toolKindWrite, "write_to_file": toolKindWrite,
	"edit_file": toolKindEdit, "replace_file_content": toolKindEdit,
	"multi_replace_file_content": toolKindEdit,
	"grep_search": toolKindSearch, "find_by_name": toolKindSearch, "list_dir": toolKindSearch,
	"search_web": toolKindWeb, "read_url_content": toolKindWeb,
	"invoke_subagent": toolKindTask, "define_subagent": toolKindTask,
	"manage_subagents": toolKindTask, "send_message": toolKindTask,
	"schedule": toolKindTask, "run_workflow": toolKindTask, "swarm": toolKindTask,
	"update_steps": toolKindTodo,
	"ask_question": toolKindAsk,
}

var (
	agyUserRequestRe  = regexp.MustCompile(`(?s)<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>`)
	agySettingsRe     = regexp.MustCompile(`(?s)<USER_SETTINGS_CHANGE>\s*(.*?)\s*</USER_SETTINGS_CHANGE>`)
	agyMetaBlocksRe   = regexp.MustCompile(`(?s)<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE|MEMORY)>.*?</(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE|MEMORY)>`)
	agyModeChangeRe   = regexp.MustCompile("(?i)`(?:Agent Mode|Execution Mode|Permission Mode|Mode)`\\s+from\\s+.+?\\s+to\\s+([^.\\n]+)")
)

// unwrapAgyUserInput extracts the human prompt from Agy's <USER_REQUEST> wrapper
// and strips injected metadata/settings blocks.
func unwrapAgyUserInput(raw string) string {
	if m := agyUserRequestRe.FindStringSubmatch(raw); len(m) == 2 {
		return strings.TrimSpace(m[1])
	}
	cleaned := agyMetaBlocksRe.ReplaceAllString(raw, "")
	return strings.TrimSpace(cleaned)
}

// extractAgyModeChange reads an in-session mode toggle from <USER_SETTINGS_CHANGE>.
func extractAgyModeChange(raw string) string {
	for _, block := range agySettingsRe.FindAllStringSubmatch(raw, -1) {
		if len(block) < 2 {
			continue
		}
		if m := agyModeChangeRe.FindStringSubmatch(block[1]); len(m) == 2 {
			if norm := normalizeAgyMode(m[1]); norm != "" {
				return norm
			}
		}
	}
	return ""
}

// cleanAgyToolResult drops Agy's repetitive leading Created At / Completed At
// timestamp lines so the expanded tool result starts with actual output.
func cleanAgyToolResult(raw string) string {
	s := strings.ReplaceAll(raw, "\r\n", "\n")
	lines := strings.Split(s, "\n")
	i := 0
	for i < len(lines) {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" || strings.HasPrefix(trimmed, "Created At:") || strings.HasPrefix(trimmed, "Completed At:") {
			i++
			continue
		}
		break
	}
	return strings.TrimSpace(strings.Join(lines[i:], "\n"))
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
			if text := unwrapAgyUserInput(row.Content); text != "" {
				return clip(text, 80)
			}
		}
	}
	return ""
}

func (t *transcript) settleAgyPending() {
	for _, idx := range t.agyPending {
		if idx >= 0 && idx < len(t.messages) {
			t.messages[idx].Pending = false
		}
	}
	t.agyPending = nil
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
		t.settleAgyPending()
		if mode := extractAgyModeChange(row.Content); mode != "" {
			t.mode = mode
		}
		if text := unwrapAgyUserInput(row.Content); text != "" {
			t.messages = append(t.messages, chatMessage{Role: "user", Text: clip(text, 8000), TS: row.CreatedAt})
		}
	case "PLANNER_RESPONSE":
		t.settleAgyPending()
		if text := strings.TrimSpace(row.Content); text != "" {
			t.messages = append(t.messages, chatMessage{Role: "assistant", Text: clip(text, 8000), TS: row.CreatedAt})
		}
		for _, call := range row.ToolCalls {
			args, err := json.Marshal(call.Args)
			if err == nil {
				t.addTool("", call.Name, string(args), row.CreatedAt)
				idx := len(t.messages) - 1
				t.messages[idx].Pending = true
				t.agyPending = append(t.agyPending, idx)
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
	case "GENERIC":
		if len(t.agyPending) > 0 {
			idx := t.agyPending[0]
			t.agyPending = t.agyPending[1:]
			if idx >= 0 && idx < len(t.messages) {
				if out := cleanAgyToolResult(row.Content); out != "" {
					t.messages[idx].Result = clipLines(clip(out, 3000), 40)
				}
				t.messages[idx].Pending = false
			}
		}
	}
}

func agyToolSummary(name string, input map[string]any) string {
	switch name {
	case "read_file", "view_file":
		path := toolFile(input)
		if path == "" {
			return ""
		}
		start, hasStart := inputInt(input, "StartLine", "start_line")
		end, hasEnd := inputInt(input, "EndLine", "end_line")
		switch {
		case hasStart && hasEnd:
			path = fmt.Sprintf("%s:%d-%d", path, start, end)
		case hasStart:
			path = fmt.Sprintf("%s:%d+", path, start)
		case hasEnd:
			path = fmt.Sprintf("%s:1-%d", path, end)
		}
		if off, ok := inputInt(input, "ByteOffset", "byte_offset"); ok && off > 0 {
			path = fmt.Sprintf("%s @%dB", path, off)
		}
		return clip(name+" "+path, 160)
	case "run_command":
		summary := firstLine(inputString(input, "toolSummary", "description"))
		cmd := firstLine(inputString(input, "CommandLine", "command", "cmd"))
		var target string
		switch {
		case summary != "" && cmd != "":
			target = summary + " · " + cmd
		case summary != "":
			target = summary
		case cmd != "":
			target = cmd
		default:
			return ""
		}
		if input["BypassSandbox"] == true {
			target = "[unsandboxed] " + target
		}
		return clip(name+" "+target, 160)
	case "search_web":
		q := firstLine(inputString(input, "query", "Query"))
		if q == "" {
			return ""
		}
		if dom := inputString(input, "domain", "Domain"); dom != "" {
			q += " (" + dom + ")"
		}
		return clip(name+" "+q, 160)
	case "invoke_subagent":
		role := inputString(input, "Role")
		kind := inputString(input, "TypeName")
		switch {
		case role != "" && kind != "":
			return clip(fmt.Sprintf("%s %s (%s)", name, role, kind), 160)
		case role != "":
			return clip(name+" "+role, 160)
		case kind != "":
			return clip(name+" "+kind, 160)
		}
	case "update_steps":
		steps, _ := input["steps"].([]any)
		if len(steps) == 0 {
			return ""
		}
		done, active := 0, ""
		for _, raw := range steps {
			m, _ := raw.(map[string]any)
			switch inputString(m, "status") {
			case "done":
				done++
			case "in_progress":
				if active == "" {
					active = inputString(m, "title")
				}
			}
		}
		label := fmt.Sprintf("%d/%d", done, len(steps))
		if active != "" {
			label += " · " + active
		}
		return clip(name+" "+label, 160)
	case "manage_task", "manage_subagents":
		action := inputString(input, "Action")
		target := inputString(input, "TaskId")
		if action != "" {
			if target != "" {
				return clip(name+" "+action+" "+target, 160)
			}
			return clip(name+" "+action, 160)
		}
	case "swarm":
		action := inputString(input, "action")
		who := inputString(input, "name")
		if action != "" {
			if who != "" {
				return clip(name+" "+action+" "+who, 160)
			}
			return clip(name+" "+action, 160)
		}
	case "ask_question":
		if qs, _ := input["questions"].([]any); len(qs) > 0 {
			if m, _ := qs[0].(map[string]any); m != nil {
				if q := firstLine(inputString(m, "question")); q != "" {
					return clip(name+" "+q, 160)
				}
			}
		}
	}
	return ""
}

func agyToolBody(name string, input map[string]any) string {
	switch name {
	case "update_steps":
		steps, _ := input["steps"].([]any)
		if len(steps) == 0 {
			return ""
		}
		var lines []string
		for _, raw := range steps {
			m, _ := raw.(map[string]any)
			title := inputString(m, "title")
			if title == "" {
				continue
			}
			mark := "○"
			switch inputString(m, "status") {
			case "done":
				mark = "✓"
			case "in_progress":
				mark = "●"
			case "failed":
				mark = "✗"
			case "skipped":
				mark = "–"
			}
			lines = append(lines, mark+" "+title)
		}
		return clipLines(strings.Join(lines, "\n"), 40)
	case "invoke_subagent":
		prompt := inputString(input, "Prompt")
		var meta []string
		for _, k := range []string{"TypeName", "Role", "Model", "Workspace"} {
			if v := inputString(input, k); v != "" {
				meta = append(meta, k+": "+v)
			}
		}
		if len(meta) == 0 && prompt == "" {
			return ""
		}
		if len(meta) > 0 && prompt != "" {
			return clip(strings.Join(meta, " · ")+"\n\n"+prompt, 2000)
		}
		if prompt != "" {
			return clip(prompt, 2000)
		}
		return strings.Join(meta, " · ")
	case "send_message":
		if msg := inputString(input, "Message"); msg != "" {
			return clip(msg, 2000)
		}
	case "schedule":
		if p := inputString(input, "Prompt"); p != "" {
			return clip(p, 2000)
		}
	case "run_workflow":
		if s := inputString(input, "Script", "ScriptPath"); s != "" {
			return clipLines(clip(s, 2000), 40)
		}
	case "swarm":
		if b := inputString(input, "brief"); b != "" {
			return clip(b, 2000)
		}
	case "ask_question":
		qs, _ := input["questions"].([]any)
		if len(qs) == 0 {
			return ""
		}
		var lines []string
		for _, raw := range qs {
			m, _ := raw.(map[string]any)
			if q := inputString(m, "question"); q != "" {
				lines = append(lines, q)
			}
			if opts, _ := m["options"].([]any); len(opts) > 0 {
				for i, o := range opts {
					if s, ok := o.(string); ok && s != "" {
						lines = append(lines, fmt.Sprintf("  %d. %s", i+1, s))
					}
				}
			}
		}
		return clipLines(strings.Join(lines, "\n"), 40)
	}
	return ""
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
		if text := unwrapAgyUserInput(row.Content); text != "" {
			*users = append(*users, text)
		}
	case "PLANNER_RESPONSE":
		if row.Content != "" {
			*lastAssist = clip(row.Content, 1200)
		}
		for _, call := range row.ToolCalls {
			if path := inputString(call.Args, "Path", "path", "AbsolutePath", "TargetFile", "file_path"); path != "" {
				files[path] = struct{}{}
			}
		}
	}
}
