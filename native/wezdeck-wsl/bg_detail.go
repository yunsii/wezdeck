package main

// What a background task is, for the session header: the attention hook
// only knows a task id (its summary is often just `task:<id>`), but the
// transcript holds the call that started it (trackTask: Bash with
// run_in_background, Monitor) — its description, command and time — and
// Claude Code writes the task's output to
// /tmp/claude-*/*/<session>/tasks/<id>.output, whose last lines say what it
// is doing now.

import (
	"io"
	"os"
	"path/filepath"
	"strings"
)

type bgDetail struct {
	bgTask
	Tool    string   `json:"tool,omitempty"`
	Label   string   `json:"label,omitempty"`   // the call's description, else its command
	Command string   `json:"command,omitempty"` // what it runs (clipped)
	Started string   `json:"started,omitempty"` // the call's transcript timestamp
	At      *int     `json:"at,omitempty"`      // the call's message index (the page can jump there)
	Tail    []string `json:"tail,omitempty"`    // the output's last lines
}

const (
	bgTailLines = 4
	bgTailBytes = 4 << 10
)

// bgTasksRoot: where Claude Code keeps task output (the hook's
// WEZTERM_ATTENTION_CLAUDE_TASKS_ROOT, else /tmp).
func bgTasksRoot() string {
	if root := os.Getenv("WEZTERM_ATTENTION_CLAUDE_TASKS_ROOT"); root != "" {
		return root
	}
	return "/tmp"
}

// enrichBackground: each task with what the transcript and its output file
// say; a task neither knows keeps its id / summary only. Callers hold
// transcriptsMu when t is shared.
func enrichBackground(tasks []bgTask, t *transcript, sessionID string) []bgDetail {
	out := make([]bgDetail, 0, len(tasks))
	for _, task := range tasks {
		d := bgDetail{bgTask: task}
		if t != nil {
			if idx, ok := t.tasks[task.ID]; ok && idx < len(t.messages) {
				msg := t.messages[idx]
				at := idx
				d.Tool, d.Started, d.At = msg.Tool, msg.TS, &at
				d.Label = strings.TrimSpace(strings.TrimPrefix(msg.Text, msg.Tool))
				d.Command = clip(msg.Body, 600)
			}
		}
		d.Tail = bgOutputTail(sessionID, task.ID)
		out = append(out, d)
	}
	return out
}

// bgOutputTail: the last non-empty lines of the task's output, ANSI
// stripped; nil when there is no output file (yet).
func bgOutputTail(sessionID, taskID string) []string {
	if !sessionIDPattern.MatchString(sessionID) || strings.ContainsAny(taskID, `/\*?[`) || taskID == "" {
		return nil
	}
	matches, _ := filepath.Glob(filepath.Join(bgTasksRoot(), "claude-*", "*", sessionID, "tasks", taskID+".output"))
	if len(matches) == 0 {
		return nil
	}
	f, err := os.Open(matches[0])
	if err != nil {
		return nil
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil
	}
	start := info.Size() - bgTailBytes
	if start < 0 {
		start = 0
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil
	}
	text := ansiEscape.ReplaceAllString(string(data), "")
	// a carriage-return progress bar keeps only its last state
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		if i := strings.LastIndexByte(line, '\r'); i >= 0 {
			line = line[i+1:]
		}
		if line = strings.TrimRight(line, " \t"); line != "" {
			lines = append(lines, clip(line, 200))
		}
	}
	if start > 0 && len(lines) > 0 {
		lines = lines[1:] // the first line was cut by the window
	}
	if len(lines) > bgTailLines {
		lines = lines[len(lines)-bgTailLines:]
	}
	return lines
}
