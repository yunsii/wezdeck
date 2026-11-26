package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestRunWriteLogsClientOperationWithoutMessage(t *testing.T) {
	op := "446fe9df-83f7-41ea-b7a9-acbf390a92e6"
	var lines []string
	logf := func(event, format string, args ...any) {
		lines = append(lines, event+" "+fmt.Sprintf(format, args...))
	}
	args, _ := json.Marshal(map[string]string{
		"id": "invalid id", "text": "private message", "client_op": op,
	})
	_, err := runWrite("send", args, "local", "local", logf)
	if err == nil || len(lines) != 1 || !strings.Contains(lines[0], "op_id="+op) {
		t.Fatalf("missing correlated failure: err=%v lines=%v", err, lines)
	}
	if strings.Contains(lines[0], "private message") {
		t.Fatal("message body leaked into write log")
	}
}

func TestRunWriteWithoutClientOperationKeepsExistingLogShape(t *testing.T) {
	var line string
	args, _ := json.Marshal(map[string]string{"id": "invalid id", "text": "private message"})
	_, _ = runWrite("send", args, "webrtc", "test-device", func(event, format string, values ...any) {
		line = event + " " + fmt.Sprintf(format, values...)
	})
	if strings.Contains(line, "op_id=") {
		t.Fatalf("unexpected client operation in remote write log: %s", line)
	}
}
