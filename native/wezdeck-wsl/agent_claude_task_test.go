package main

import (
	"strings"
	"testing"
)

// A Monitor's events and a background command's end arrive as
// task-notification attachments (or, on an idle session, a user line); each
// shows in the thread as a quiet "task" row where it arrived — as the
// terminal prints it — and lands on the call that started the task.
func TestTaskNotificationsLandOnTheirCall(t *testing.T) {
	note := func(body string) string {
		return `{"type":"attachment","attachment":{"type":"queued_command","commandMode":"task-notification","origin":{"kind":"task-notification"},"prompt":` + jsonString(body) + `}}`
	}
	lines := []string{
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"m1","name":"Monitor","input":{"description":"watch the deploy","command":"x"}},{"type":"tool_use","id":"b1","name":"Bash","input":{"command":"make","run_in_background":true}}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"m1","content":"Monitor started (task mtask1, expires in 30s)."},{"type":"tool_result","tool_use_id":"b1","content":"Command running in background with ID: btask2. Output is being written to: /tmp/x"}]}}`,
		note("<task-notification>\n<task-id>mtask1</task-id>\n<summary>Monitor event: \"watch the deploy\"</summary>\n<event>step 1 built</event>\n</task-notification>"),
		note("<task-notification>\n<task-id>mtask1</task-id>\n<summary>Monitor event: \"watch the deploy\"</summary>\n<event>step 2 uploaded</event>\n</task-notification>"),
	}
	msgs := parseClaudeTranscript([]byte(strings.Join(lines, "\n")+"\n"), 100)
	monitor, bash := msgs[0], msgs[1]
	if len(msgs) != 4 || msgs[2].Kind != "task" || msgs[2].Text != `Monitor event: "watch the deploy"` || msgs[2].Body != "step 1 built" || msgs[3].Body != "step 2 uploaded" {
		t.Fatalf("event rows: %+v", msgs[2:])
	}
	if !monitor.Pending || monitor.Result != "step 1 built\nstep 2 uploaded\n" {
		t.Fatalf("live monitor: pending=%v result=%q", monitor.Pending, monitor.Result)
	}
	if bash.Pending || !strings.Contains(bash.Result, "btask2") {
		t.Fatalf("background bash started: pending=%v result=%q", bash.Pending, bash.Result)
	}
	lines = append(lines,
		note("<task-notification>\n<task-id>mtask1</task-id>\n<tool-use-id>m1</tool-use-id>\n<status>completed</status>\n<summary>Monitor \"watch the deploy\" stream ended</summary>\n</task-notification>"),
		note("<task-notification>\n<task-id>btask2</task-id>\n<tool-use-id>b1</tool-use-id>\n<status>completed</status>\n<summary>Background command \"make\" completed (exit code 0)</summary>\n</task-notification>"),
		note("<task-notification>\n<task-id>unknown</task-id>\n<event>ignored</event>\n</task-notification>"),
	)
	// a plain command whose output quotes a Monitor's start line is no task
	lines = append(lines,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"g1","name":"Bash","input":{"command":"grep task log"}}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"g1","content":"220: Monitor started (task mtask1, expires)"}]}}`,
	)
	msgs = parseClaudeTranscript([]byte(strings.Join(lines, "\n")+"\n"), 100)
	monitor, bash = msgs[0], msgs[1]
	if monitor.Pending || monitor.Result != "step 1 built\nstep 2 uploaded\n— Monitor \"watch the deploy\" stream ended" {
		t.Fatalf("ended monitor: pending=%v result=%q", monitor.Pending, monitor.Result)
	}
	if !strings.HasSuffix(bash.Result, "— Background command \"make\" completed (exit code 0)") {
		t.Fatalf("finished bash: %q", bash.Result)
	}
	// 4 event / end rows + the unknown task's row (no call, still shown)
	var tasks []chatMessage
	for _, m := range msgs {
		if m.Kind == "task" {
			tasks = append(tasks, m)
		}
	}
	if len(tasks) != 5 || tasks[2].Text != `Monitor "watch the deploy" stream ended` || tasks[3].Text != `Background command "make" completed (exit code 0)` || tasks[4].Body != "ignored" {
		t.Fatalf("task rows: %+v", tasks)
	}
	grep := msgs[len(msgs)-1]
	if grep.Tool != "Bash" || strings.Contains(grep.Result, "— ") {
		t.Fatalf("a quoting command took a task: %+v", grep)
	}
	// an idle session: the notification is a user line; queued and then
	// delivered, it shows once
	idle := `{"type":"user","message":{"role":"user","content":` + jsonString("<task-notification>\n<task-id>mtask9</task-id>\n<summary>Monitor event: \"x\"</summary>\n<event>a &lt; b</event>\n</task-notification>") + `},"origin":{"kind":"task-notification"}}`
	again := parseClaudeTranscript([]byte(idle+"\n"+note("<task-notification>\n<task-id>mtask9</task-id>\n<summary>Monitor event: \"x\"</summary>\n<event>a &lt; b</event>\n</task-notification>")+"\n"), 100)
	if len(again) != 1 || again[0].Kind != "task" || again[0].Body != "a < b" {
		t.Fatalf("idle notification: %+v", again)
	}
}

func jsonString(s string) string {
	b := strings.Builder{}
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
