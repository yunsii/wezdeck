package main

// Agent adapters (docs/remote-access.md "Agent adapters and the session
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
}

// agentAdapters, in lookup order (a session id is unique to one agent).
var agentAdapters = []agentAdapter{claudeAdapter{}, grokAdapter{}, codexAdapter{}}

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
	return globFirst(filepath.Join(home, ".claude", "projects", "*", id+".jsonl"))
}
func (claudeAdapter) Feed(t *transcript, line []byte) { t.feedLine(line) }
func (claudeAdapter) Title(path string) string        { return lastClaudeAITitle(path) }

// Grok: ~/.grok/sessions/*/<id>/chat_history.jsonl; title from summary.json.
type grokAdapter struct{}

func (grokAdapter) Name() string { return "grok" }
func (grokAdapter) Locate(home, id string) string {
	return globFirst(filepath.Join(home, ".grok", "sessions", "*", id, "chat_history.jsonl"))
}
func (grokAdapter) Feed(t *transcript, line []byte) { t.feedGrok(line) }
func (grokAdapter) Title(path string) string        { return grokSessionTitle(path) }

// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl; no title yet.
type codexAdapter struct{}

func (codexAdapter) Name() string { return "codex" }
func (codexAdapter) Locate(home, id string) string {
	return globFirst(filepath.Join(home, ".codex", "sessions", "*", "*", "*", "rollout-*-"+id+".jsonl"))
}
func (codexAdapter) Feed(t *transcript, line []byte) { t.feedCodex(line) }
func (codexAdapter) Title(string) string             { return "" }
