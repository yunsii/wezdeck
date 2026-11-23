package main

// Slash commands in a Claude transcript. Claude Code records a command as
//
//	<command-name>/model</command-name> <command-message>…</command-message>
//	<command-args>opus</command-args>
//
// (a user line, or a system line with subtype local_command — /resume) and
// what it printed as <local-command-stdout>…</local-command-stdout> (or
// stderr). These used to be dropped with every "<…" line, so the phone never
// saw /model's "Set model to …" and a sent command looked like a message
// the agent never took. They become one system message, kind "slash"
// (not "command": that is a tool row's kind for shell calls):
// Text the command line, Body its output.

import (
	"encoding/json"
	"regexp"
	"strings"
)

var (
	commandName   = regexp.MustCompile(`(?s)<command-name>\s*(/?[^<\s]+)\s*</command-name>`)
	commandArgs   = regexp.MustCompile(`(?s)<command-args>(.*?)</command-args>`)
	commandOutput = regexp.MustCompile(`(?s)<local-command-(?:stdout|stderr)>(.*?)</local-command-(?:stdout|stderr)>`)
	ansiEscape    = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)
)

// feedCommand takes a command or command-output line; false for anything else.
func (t *transcript) feedCommand(kind, subtype string, top, message json.RawMessage, ts string) bool {
	var text string
	switch {
	case kind == "system" && subtype == "local_command":
		_ = json.Unmarshal(top, &text)
	case kind == "user":
		if json.Unmarshal(message, &text) != nil {
			return false
		}
	default:
		return false
	}
	trimmed := strings.TrimSpace(text)
	if m := commandName.FindStringSubmatch(trimmed); m != nil && strings.HasPrefix(trimmed, "<") {
		line := m[1]
		if !strings.HasPrefix(line, "/") {
			line = "/" + line
		}
		if a := commandArgs.FindStringSubmatch(trimmed); a != nil {
			if args := strings.TrimSpace(a[1]); args != "" {
				line += " " + args
			}
		}
		t.messages = append(t.messages, chatMessage{Role: "system", Kind: "slash", Text: clip(line, 300), TS: ts})
		return true
	}
	if m := commandOutput.FindStringSubmatch(trimmed); m != nil && strings.HasPrefix(trimmed, "<") {
		out := strings.TrimSpace(ansiEscape.ReplaceAllString(m[1], ""))
		if n := len(t.messages); n > 0 && t.messages[n-1].Role == "system" && t.messages[n-1].Kind == "slash" && t.messages[n-1].Body == "" {
			t.messages[n-1].Body = clipLines(clip(out, 3000), 40)
		} else if out != "" {
			t.messages = append(t.messages, chatMessage{Role: "system", Kind: "slash", Body: clipLines(clip(out, 3000), 40), TS: ts})
		}
		return true
	}
	return false
}
