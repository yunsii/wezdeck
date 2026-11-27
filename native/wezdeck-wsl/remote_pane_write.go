package main

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// Both relay transports already carry error strings. Keep a stable prefix for
// partial sends so old clients get a readable error and new clients can
// distinguish it from a rejected key.
const paneSubmitErrorPrefix = "tmux submit failed after paste: "

type paneWriteError struct {
	stage  string
	detail string
}

func (e *paneWriteError) Error() string {
	switch e.stage {
	case "load_buffer":
		return "tmux load-buffer: " + e.detail
	case "paste":
		return "tmux paste-buffer: " + e.detail
	case "submit":
		return paneSubmitErrorPrefix + e.detail
	default:
		return "tmux send-keys: " + e.detail
	}
}

func logPaneWrite(e attentionEntry, op, action string, started time.Time, err error) {
	elapsed := time.Since(started).Milliseconds()
	stage := "dispatched"
	snapshot := ""
	if err != nil {
		var failure *paneWriteError
		if errors.As(err, &failure) {
			stage = failure.stage
		} else {
			stage = "unknown"
		}
		snapshot = paneWriteClientSnapshot(e.TmuxSocket)
	}
	relayLogf("pane_write", "op_id=%q action=%q session=%q pane=%q stage=%q ok=%t ms=%d clients=%q",
		op, action, e.SessionID, e.TmuxPane, stage, err == nil, elapsed, snapshot)
}

// Capture flags from the whole server: tmux may select a client attached
// to a different session than the target pane.
func paneWriteClientSnapshot(socket string) string {
	out, err := tmuxCmd(socket, "list-clients", "-F", "#{client_pid}:#{session_id}:#{client_flags}").Output()
	if err != nil {
		return "unavailable"
	}
	flags := strings.Fields(string(out))
	if len(flags) == 0 {
		return "none"
	}
	if len(flags) > 12 {
		return strings.Join(flags[:12], " ") + fmt.Sprintf(" (+%d)", len(flags)-12)
	}
	return strings.Join(flags, " ")
}
