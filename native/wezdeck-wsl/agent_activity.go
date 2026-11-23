package main

// What the agent's TUI says it is doing right now, read off the pane the
// session reply already captures (`screen`): Claude's spinner line
//   ✢ Gesticulating… (4m 39s · ↓ 19.1k tokens · thought for 2s)
//   ✻ Compacting conversation… (36s · ↓ 2.0k tokens)
// and Codex's status line
//   • Working (12s • esc to interrupt)
// The transcript has no trace of a compaction until it is done, and none of
// the elapsed time or tokens, so the phone showed bare typing dots while the
// desk said what was going on.

import (
	"regexp"
	"strings"
)

type agentActivity struct {
	Text       string `json:"text"`              // Gesticulating / Compacting conversation / Working
	Elapsed    string `json:"elapsed,omitempty"` // 4m 39s
	Tokens     string `json:"tokens,omitempty"`  // ↓ 19.1k
	Compacting bool   `json:"compacting,omitempty"`
}

var (
	claudeSpinner = regexp.MustCompile(`^\s*[·✢✳✶✻✽*∗]\s+([^…()]{1,60}?)…\s*\(([^)]*)\)\s*$`)
	codexStatus   = regexp.MustCompile(`^\s*[•◦]\s+([^()]{1,60}?)\s+\(([^)]*esc to interrupt[^)]*)\)\s*$`)
	elapsedPart   = regexp.MustCompile(`^(\d+h\s*)?(\d+m\s*)?\d+s$`)
	tokensPart    = regexp.MustCompile(`^([↓↑])\s*([\d.]+[kKmM]?)\s+tokens$`)
)

// parseActivity reads the bottom of the screen (the status sits just above
// the prompt box); nil when the agent shows no status line.
func parseActivity(agent, screen string) *agentActivity {
	lines := strings.Split(screen, "\n")
	from := max(0, len(lines)-20)
	for i := len(lines) - 1; i >= from; i-- {
		line := lines[i]
		var m []string
		sep := " · "
		switch agent {
		case "codex":
			m = codexStatus.FindStringSubmatch(line)
			sep = " • "
		default:
			m = claudeSpinner.FindStringSubmatch(line)
		}
		if m == nil {
			continue
		}
		a := &agentActivity{Text: strings.TrimSpace(m[1])}
		a.Compacting = strings.HasPrefix(strings.ToLower(a.Text), "compacting")
		for _, part := range strings.Split(m[2], sep) {
			part = strings.TrimSpace(part)
			switch {
			case a.Elapsed == "" && elapsedPart.MatchString(part):
				a.Elapsed = part
			case a.Tokens == "" && tokensPart.MatchString(part):
				t := tokensPart.FindStringSubmatch(part)
				a.Tokens = t[1] + " " + t[2]
			}
		}
		return a
	}
	return nil
}
