package main

// What a permission prompt is about, for the phone (no screen reading).
// While the attention entry is waiting with waiting_kind=permission_prompt,
// the call the agent is blocked on is the newest tool call in the
// transcript with no result yet. Chat timeline rows keep clipped previews so
// long histories stay light, but the single pending approval card gets the
// full summary and full command / diff / file / JSON payload (capped only at
// a generous 64 KiB safety limit) so the human can review everything before
// approving.

import (
	"encoding/json"
	"fmt"
	"strings"
)

const (
	permissionBodyCap    = 64 * 1024
	permissionSummaryCap = 2000
)

type permissionOption struct {
	Label string   `json:"label"`
	Kind  string   `json:"kind"` // "allow" | "always" | "deny"
	Keys  []string `json:"keys"` // allowedKeys sequence, e.g. ["Enter"], ["Down", "Enter"], ["Escape"]
}

type pendingCall struct {
	Tool      string             `json:"tool"`
	Text      string             `json:"text"`                // "<tool> <target>" (compat)
	Summary   string             `json:"summary,omitempty"`   // full human summary / target (wraps in UI)
	Flags     []string           `json:"flags,omitempty"`     // e.g. bypass-sandbox, daemon, background
	Body      string             `json:"body,omitempty"`      // full command / diff / file / JSON args
	File      string             `json:"file,omitempty"`
	Plan      bool               `json:"plan,omitempty"`      // ExitPlanMode: the body is the plan
	Truncated bool               `json:"truncated,omitempty"` // true only when body exceeded permissionBodyCap
	Options   []permissionOption `json:"options,omitempty"`   // parsed TUI menu options (e.g. Agy Always allow)
}

// planTool: the agent's plan-approving tool (planReader.PlanTool), "" none.
func pendingPermission(messages []chatMessage, planTool string) *pendingCall {
	for i := len(messages) - 1; i >= 0; i-- {
		m := messages[i]
		if m.Role != "tool" || !m.Pending {
			continue
		}
		if m.Tool == "AskUserQuestion" || m.Tool == "ask_question" {
			return nil // a question, answered by the elicitation card
		}
		return buildPendingCall(m, planTool)
	}
	return nil
}

func buildPendingCall(m chatMessage, planTool string) *pendingCall {
	isPlan := planTool != "" && m.Tool == planTool
	out := &pendingCall{
		Tool: m.Tool,
		Text: m.Text,
		Body: m.Body,
		File: m.File,
		Plan: isPlan,
	}
	if m.rawInput == nil {
		return out
	}
	out.Flags = permissionFlags(m.rawInput)
	out.Summary = permissionSummary(m.Tool, m.rawInput)
	if body, truncated := permissionBody(m.Tool, m.rawInput, isPlan); body != "" {
		out.Body = body
		out.Truncated = truncated
	}
	return out
}

func permissionFlags(input map[string]any) []string {
	var flags []string
	if input["BypassSandbox"] == true {
		flags = append(flags, "bypass-sandbox")
	}
	if input["IsDaemon"] == true {
		flags = append(flags, "daemon")
	} else if input["run_in_background"] == true {
		flags = append(flags, "background")
	}
	return flags
}

func permissionCommandText(input map[string]any) string {
	if cmd := inputString(input, "command", "cmd", "CommandLine"); cmd != "" {
		return cmd
	}
	if list, ok := input["command"].([]any); ok {
		var words []string
		for _, w := range list {
			if v, ok := w.(string); ok {
				words = append(words, v)
			}
		}
		return strings.Join(words, " ")
	}
	return ""
}

func permissionSummary(name string, input map[string]any) string {
	// Command tools show the full command in Body; keep Summary strictly for the
	// human description so the UI does not repeat the command's first line.
	if permissionCommandText(input) != "" {
		return clip(inputString(input, "toolSummary", "description", "Description"), permissionSummaryCap)
	}
	if path := toolFile(input); path != "" {
		if name == "read_file" || name == "view_file" {
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
		}
		return clip(path, permissionSummaryCap)
	}
	switch name {
	case "search_web":
		if q := strings.TrimSpace(inputString(input, "query", "Query")); q != "" {
			if dom := strings.TrimSpace(inputString(input, "domain", "Domain")); dom != "" {
				q += " (" + dom + ")"
			}
			return clip(q, permissionSummaryCap)
		}
	case "read_url_content", "WebFetch":
		if u := strings.TrimSpace(inputString(input, "url", "Url")); u != "" {
			return clip(u, permissionSummaryCap)
		}
	case "invoke_subagent":
		var parts []string
		role := strings.TrimSpace(inputString(input, "Role"))
		kind := strings.TrimSpace(inputString(input, "TypeName"))
		switch {
		case role != "" && kind != "":
			parts = append(parts, fmt.Sprintf("%s (%s)", role, kind))
		case role != "":
			parts = append(parts, role)
		case kind != "":
			parts = append(parts, kind)
		}
		for _, k := range []string{"Model", "Workspace"} {
			if v := strings.TrimSpace(inputString(input, k)); v != "" {
				parts = append(parts, k+": "+v)
			}
		}
		if len(parts) > 0 {
			return clip(strings.Join(parts, " · "), permissionSummaryCap)
		}
	case "run_workflow":
		if desc := strings.TrimSpace(inputString(input, "Description", "ScriptPath")); desc != "" {
			return clip(desc, permissionSummaryCap)
		}
	case "manage_task", "manage_subagents":
		action := strings.TrimSpace(inputString(input, "Action"))
		target := strings.TrimSpace(inputString(input, "TaskId"))
		if action != "" {
			if target != "" {
				return clip(action+" "+target, permissionSummaryCap)
			}
			return clip(action, permissionSummaryCap)
		}
	case "swarm":
		action := strings.TrimSpace(inputString(input, "action"))
		who := strings.TrimSpace(inputString(input, "name"))
		if action != "" {
			if who != "" {
				return clip(action+" "+who, permissionSummaryCap)
			}
			return clip(action, permissionSummaryCap)
		}
	}
	if v := inputString(input, "toolSummary", "description", "Description",
		"title", "Title", "url", "Url", "query", "Query", "pattern", "Action", "action"); v != "" {
		return clip(v, permissionSummaryCap)
	}
	return ""
}

func clipBody(s string, maxRunes int) (string, bool) {
	s = strings.TrimRight(s, "\n")
	if s == "" {
		return "", false
	}
	runes := []rune(s)
	if len(runes) <= maxRunes {
		return s, false
	}
	return string(runes[:maxRunes]) + "\n…", true
}

func permissionBody(name string, input map[string]any, isPlan bool) (string, bool) {
	if isPlan {
		if plan := inputString(input, "plan"); plan != "" {
			return clipBody(plan, permissionBodyCap)
		}
	}
	if pairs := editPairs(input); len(pairs) > 0 {
		var parts []string
		for _, p := range pairs {
			var b strings.Builder
			for _, l := range strings.Split(p[0], "\n") {
				b.WriteString("- " + l + "\n")
			}
			for _, l := range strings.Split(p[1], "\n") {
				b.WriteString("+ " + l + "\n")
			}
			parts = append(parts, strings.TrimRight(b.String(), "\n"))
		}
		return clipBody(strings.Join(parts, "\n…\n"), permissionBodyCap)
	}
	if content, ok := writeContent(name, input); ok {
		return clipBody(content, permissionBodyCap)
	}
	if cmd := permissionCommandText(input); cmd != "" {
		return clipBody(cmd, permissionBodyCap)
	}
	switch name {
	case "run_workflow":
		if s := inputString(input, "Script", "ScriptPath"); s != "" {
			return clipBody(s, permissionBodyCap)
		}
	case "invoke_subagent":
		if p := inputString(input, "Prompt"); p != "" {
			return clipBody(p, permissionBodyCap)
		}
	case "send_message":
		if msg := inputString(input, "Message"); msg != "" {
			return clipBody(msg, permissionBodyCap)
		}
	case "schedule":
		if p := inputString(input, "Prompt"); p != "" {
			return clipBody(p, permissionBodyCap)
		}
	case "swarm":
		if b := inputString(input, "brief"); b != "" {
			return clipBody(b, permissionBodyCap)
		}
	}
	// Other tools (MCP, search_web, read_url_content, manage_task, etc.):
	// pretty-print full structured arguments so nothing is hidden before Allow.
	if len(input) > 0 {
		if raw, err := json.MarshalIndent(input, "", "  "); err == nil {
			return clipBody(string(raw), permissionBodyCap)
		}
	}
	return "", false
}
