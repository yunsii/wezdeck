package main

// `clear` (signed write): the phone's swipe "mark as read" — the same as
// Ctrl+X in the Alt+/ picker: archive one live attention entry into
// recent[] and nudge the badge counters (attention-jump.sh --forget). Only
// a session the relay lists can be cleared, and only while its entry still
// has the ts read here (--only-if-ts), so an entry that just changed state
// (a fresh question) is not swallowed.
//
// The session page also sends it on its own once a `done` session has been
// on screen for a moment (seen on the web = seen, like focus-ack at the
// desk). That call names the `ts` and `status` it saw: when the entry has
// moved on since (a new turn, a question), nothing is cleared and the reply
// says skipped — never an error, never the newer state swallowed.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

func clearAttention(args json.RawMessage) (any, error) {
	var a struct {
		ID     string `json:"id"`
		TS     int64  `json:"ts"`
		Status string `json:"status"`
	}
	if json.Unmarshal(args, &a) != nil || !sessionIDPattern.MatchString(a.ID) {
		return nil, errors.New("clear: bad session id")
	}
	entries, err := liveSessions()
	if err != nil {
		return nil, err
	}
	e, ok := entries[a.ID]
	if !ok {
		return nil, errors.New("clear: session not found (ended or not tracked)")
	}
	if (a.TS != 0 && e.TS != a.TS) || (a.Status != "" && e.Status != a.Status) {
		return map[string]any{"v": 1, "ok": true, "id": a.ID, "skipped": "changed"}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "bash",
		filepath.Join(repoRoot(), "scripts", "runtime", "attention-jump.sh"),
		"--forget", a.ID, "--only-if-ts", strconv.FormatInt(e.TS, 10))
	cmd.Env = os.Environ()
	// a relay pointed at another attention file (the test stack) clears there,
	// never in the live state
	if p := os.Getenv("WEZDECK_ATTENTION_FILE"); p != "" {
		cmd.Env = append(cmd.Env, "WEZDECK_ATTENTION_STATE_PATH="+p, "WEZTERM_ATTENTION_LOCK_FILE="+p+".lock")
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("clear: %v %s", err, clip(string(out), 200))
	}
	return map[string]any{"v": 1, "ok": true, "id": a.ID}, nil
}
