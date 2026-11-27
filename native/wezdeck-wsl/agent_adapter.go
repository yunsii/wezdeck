package main

// Agent adapters (docs/remote-sessions.md "Agent adapters and the session
// contract"): everything that differs between agent CLIs lives behind this
// interface — where a session's transcript is, how one line of it becomes
// the shared chat model (chatMessage + sessionUsage), and its display title.
// The relay, the transport and the web page only ever see the shared model,
// so a new agent is one more file implementing agentAdapter plus an entry in
// agentAdapters.

import (
	"os"
	"path/filepath"
)

type agentAdapter interface {
	// Name is the agent id the phone sees ("claude", "grok", "codex").
	Name() string
	// Locate returns the session's transcript path, or "" when it has none here.
	Locate(home, sessionID string) string
	// Feed parses one transcript line into the shared model.
	Feed(t *transcript, line []byte)
	// Title is the agent-generated or /rename'd title, or "".
	Title(transcriptPath string) string
	// ToolKind maps one of the agent's tool calls to a shared kind (toolKind*)
	// so the phone summarises runs without knowing tool names.
	ToolKind(name string, input map[string]any) string
	// Capabilities declares what has no code of its own here (usage source,
	// account limits, mid-turn input, titles). Features this package wires
	// per agent are derived instead — see capabilitiesOf.
	Capabilities() agentCaps
}

// Optional adapter parts. The session reply calls them through these
// interfaces (never `if agent == "claude"`), and capabilitiesOf reports a
// feature exactly when its part is implemented: a declaration can no longer
// say "no" for a feature that works (2026-11-24: Claude showed 否 for Ask
// options and plan review long after both reached the phone).

// askReader: the agent's unanswered structured question (session.elicitation).
type askReader interface {
	// PendingAsk reads it from disk; screen is the pane's last lines (Claude
	// marks a multi-question Ask that is on its review step).
	PendingAsk(transcriptPath, screen string) *elicitation
}

// planReader: a plan waiting for approve / revise / exit, in either shape an
// agent uses.
type planReader interface {
	// PendingPlan: plan state shown beside the thread (session.plan), or nil.
	PendingPlan(transcriptPath string) map[string]any
	// PlanTool: the tool whose permission prompt approves a plan, so the
	// permission card shows it as a plan; "" when plans do not arrive that way.
	PlanTool() string
}

// limitsReader: account rate limits and per-session context window size
// reported by the agent CLI's statusLine tap.
type limitsReader interface {
	AccountLimits(model string) *accountLimits
	ContextSize(sessionID string) int
}

// capabilitiesOf: the declared capabilities plus the derived ones.
func capabilitiesOf(a agentAdapter) agentCaps {
	caps := a.Capabilities()
	_, caps.AskOptions = a.(askReader)
	_, caps.PlanReview = a.(planReader)
	_, caps.AccountLimits = a.(limitsReader)
	return caps
}

// planToolOf: the plan-approving tool for this agent, or "".
func planToolOf(agent string) string {
	if p, ok := adapterFor(agent).(planReader); ok {
		return p.PlanTool()
	}
	return ""
}

// Shared tool kinds (chatMessage.Kind).
const (
	toolKindCommand = "command" // runs a shell command
	toolKindRead    = "read"    // reads a file
	toolKindEdit    = "edit"    // changes part of a file
	toolKindWrite   = "write"   // writes a whole file
	toolKindSearch  = "search"  // grep / glob / list
	toolKindTask    = "task"    // subagent / background task
	toolKindTodo    = "todo"    // plan / todo list update
	toolKindWeb     = "web"     // fetch / web search
	toolKindAsk     = "ask"     // asks the human
	toolKindOther   = "other"
)

// agentCaps: what the phone may offer for this agent (the session reply's
// `capabilities`). New features add fields; old pages ignore them.
type agentCaps struct {
	// AskOptions: structured questions with tappable options
	// (session.elicitation). Derived: the adapter is an askReader.
	AskOptions bool `json:"ask_options"`
	// PlanReview: a plan waiting for approve / revise / exit. Derived: the
	// adapter is a planReader.
	PlanReview bool `json:"plan_review"`
	// Usage: where context / spend comes from — "transcript" (per-reply usage),
	// "token_count" (Codex events) or "none".
	Usage string `json:"usage"`
	// AccountLimits: the 5 h / 7 d limits reported by the CLI's status line.
	// Derived: the adapter is a limitsReader.
	AccountLimits bool `json:"account_limits"`
	// MidTurnInput: what a message sent mid-turn does — "queue" or "steer".
	MidTurnInput string `json:"mid_turn_input"`
	// Title: the agent names sessions (and honours /rename).
	Title bool `json:"title"`
}

// toolKindByName looks a tool up in an adapter's table, then falls back to
// the shape of its input, so unknown tools still land in a sensible kind.
func toolKindByName(table map[string]string, name string, input map[string]any) string {
	if kind, ok := table[name]; ok {
		return kind
	}
	switch {
	case len(editPairs(input)) > 0:
		return toolKindEdit
	case func() bool { _, ok := writeContent(name, input); return ok }():
		return toolKindWrite
	case inputString(input, "command", "cmd", "CommandLine") != "":
		return toolKindCommand
	case toolFile(input) != "":
		return toolKindRead
	}
	return toolKindOther
}

var claudeToolKinds = map[string]string{
	"Bash": toolKindCommand, "BashOutput": toolKindCommand, "KillShell": toolKindCommand,
	"Read": toolKindRead, "NotebookRead": toolKindRead,
	"Edit": toolKindEdit, "MultiEdit": toolKindEdit, "NotebookEdit": toolKindEdit,
	"Write": toolKindWrite,
	"Grep":  toolKindSearch, "Glob": toolKindSearch, "LS": toolKindSearch,
	"Task": toolKindTask, "Agent": toolKindTask,
	"TodoWrite": toolKindTodo, "ExitPlanMode": toolKindTodo,
	"WebFetch": toolKindWeb, "WebSearch": toolKindWeb,
	"AskUserQuestion": toolKindAsk,
}

var grokToolKinds = map[string]string{
	"run_terminal_command": toolKindCommand, "get_command_or_subagent_output": toolKindCommand,
	"read_file":      toolKindRead,
	"search_replace": toolKindEdit, "edit_file": toolKindEdit,
	"write": toolKindWrite, "write_file": toolKindWrite,
	"grep": toolKindSearch, "glob": toolKindSearch, "list_dir": toolKindSearch,
	"spawn_subagent": toolKindTask, "task": toolKindTask,
	"todo_write": toolKindTodo, "enter_plan_mode": toolKindTodo, "exit_plan_mode": toolKindTodo,
	"web_search": toolKindWeb, "web_fetch": toolKindWeb,
	"ask_user_question": toolKindAsk,
}

var codexToolKinds = map[string]string{
	"shell": toolKindCommand, "exec_command": toolKindCommand, "local_shell": toolKindCommand,
	"write_stdin": toolKindCommand,
	"apply_patch": toolKindEdit,
	"update_plan": toolKindTodo,
	"web_search":  toolKindWeb,
	"view_image":  toolKindRead,
}

// agentAdapters, in lookup order (a session id is unique to one agent).
var agentAdapters = []agentAdapter{claudeAdapter{}, grokAdapter{}, codexAdapter{}, agyAdapter{}}

func adapterFor(name string) agentAdapter {
	for _, a := range agentAdapters {
		if a.Name() == name {
			return a
		}
	}
	return nil
}

// findTranscript locates a session's conversation file and its agent.
func findTranscript(sessionID string) (path, agent string) {
	if !sessionIDPattern.MatchString(sessionID) {
		return "", ""
	}
	home, _ := os.UserHomeDir()
	for _, a := range agentAdapters {
		if p := a.Locate(home, sessionID); p != "" {
			return p, a.Name()
		}
	}
	return "", ""
}

// readSessionTitle: agent-generated or /rename'd display title when known.
func readSessionTitle(path, agent string) string {
	if a := adapterFor(agent); a != nil {
		return a.Title(path)
	}
	return ""
}

func globFirst(pattern string) string {
	if matches, _ := filepath.Glob(pattern); len(matches) > 0 {
		return matches[0]
	}
	return ""
}

// Claude: ~/.claude/projects/*/<id>.jsonl; title = last type=ai-title.
type claudeAdapter struct{}

func (claudeAdapter) Name() string { return "claude" }
func (claudeAdapter) Locate(home, id string) string {
	for _, root := range []string{
		filepath.Join(home, ".claude"),
		filepath.Join(home, ".config", "claude-profiles", "home"),
		filepath.Join(home, ".config", "claude-profiles", "kimi-home"),
	} {
		if path := globFirst(filepath.Join(root, "projects", "*", id+".jsonl")); path != "" {
			return path
		}
	}
	return ""
}
func (claudeAdapter) Feed(t *transcript, line []byte) { t.feedLine(line) }
func (claudeAdapter) Title(path string) string        { return lastClaudeAITitle(path) }
func (claudeAdapter) ToolKind(name string, input map[string]any) string {
	return toolKindByName(claudeToolKinds, name, input)
}
func (claudeAdapter) Capabilities() agentCaps {
	return agentCaps{Usage: "transcript", MidTurnInput: "queue", Title: true}
}
func (claudeAdapter) AccountLimits(_ string) *accountLimits { return claudeAccountLimits() }
func (claudeAdapter) ContextSize(sessionID string) int      { return claudeContextSize(sessionID) }

// Grok: ~/.grok/sessions/*/<id>/chat_history.jsonl; title from summary.json.
type grokAdapter struct{}

func (grokAdapter) Name() string { return "grok" }
func (grokAdapter) Locate(home, id string) string {
	return globFirst(filepath.Join(home, ".grok", "sessions", "*", id, "chat_history.jsonl"))
}
func (grokAdapter) Feed(t *transcript, line []byte) { t.feedGrok(line) }
func (grokAdapter) Title(path string) string        { return grokSessionTitle(path) }
func (grokAdapter) ToolKind(name string, input map[string]any) string {
	return toolKindByName(grokToolKinds, name, input)
}
func (grokAdapter) Capabilities() agentCaps {
	return agentCaps{Usage: "none", MidTurnInput: "queue", Title: true}
}

// Codex: rollout-*-<id>.jsonl; title from the adjacent session index.
type codexAdapter struct{}

func (codexAdapter) Name() string { return "codex" }
func (codexAdapter) Locate(home, id string) string {
	return globFirst(filepath.Join(home, ".codex", "sessions", "*", "*", "*", "rollout-*-"+id+".jsonl"))
}
func (codexAdapter) Feed(t *transcript, line []byte) { t.feedCodex(line) }
func (codexAdapter) Title(path string) string        { return codexSessionTitle(path) }
func (codexAdapter) ToolKind(name string, input map[string]any) string {
	return toolKindByName(codexToolKinds, name, input)
}
func (codexAdapter) Capabilities() agentCaps {
	return agentCaps{Usage: "token_count", MidTurnInput: "steer", Title: true}
}
