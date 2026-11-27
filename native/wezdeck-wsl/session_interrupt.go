package main

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Match the terminal's own cancellation notices. Compare with a capture
// taken before pressing the key, so notices from older turns cannot confirm it.
var interruptNotice = map[string]*regexp.Regexp{
	"agy":   regexp.MustCompile(`(?m)^\s*⎿\s+Interrupted · What should Antigravity CLI do instead\?`),
	"codex": regexp.MustCompile(`(?m)^\s*■ Conversation interrupted - use /feedback`),
	"grok":  regexp.MustCompile(`(?m)^\s*Turn cancelled by user in [^\n]+\.\s*$`),
}

var interruptInFlight sync.Map

func (e attentionEntry) interruptTurn() string {
	started := e.TurnStarted
	if started == 0 {
		started = e.TS
	}
	return e.SessionID + "/" + strconv.FormatInt(started, 10)
}

func (e attentionEntry) interrupted(marker string) bool {
	return e.busy() && marker == e.interruptTurn()
}

func interruptSession(e attentionEntry) (any, error) {
	agent := sessionAgentFamily(e)
	notice := interruptNotice[agent]
	if notice == nil {
		return sendSessionKey(e, "C-c")
	}
	key := e.TmuxSocket + "/" + e.TmuxPane
	if _, inFlight := interruptInFlight.LoadOrStore(key, true); inFlight {
		return nil, errors.New("an interrupt is already in progress")
	}
	defer interruptInFlight.Delete(key)
	_, _, _, _, _, marker, alive := paneStateWithInterrupt(e)
	if !alive || !e.busy() {
		return nil, errors.New("the session has no running turn")
	}
	reply := map[string]any{"v": 1, "ok": true, "interrupted": true}
	if e.interrupted(marker) {
		return reply, nil
	}
	capture := func() ([]byte, error) {
		return tmuxCmd(e.TmuxSocket, "capture-pane", "-p", "-J", "-S", "-120", "-t", e.TmuxPane).Output()
	}
	before, err := capture()
	if err != nil {
		return nil, fmt.Errorf("capture pane before interrupt: %w", err)
	}
	seen := len(notice.FindAllIndex(before, -1))
	start := time.Now()
	if _, err := sendSessionKey(e, "C-c"); err != nil {
		return nil, err
	}
	deadline := start.Add(1500 * time.Millisecond)
	for {
		screen, err := capture()
		if err == nil && len(notice.FindAllIndex(screen, -1)) > seen {
			if out, err := tmuxCmd(e.TmuxSocket, "set-option", "-p", "-t", e.TmuxPane,
				"@wezdeck_interrupted_turn", e.interruptTurn()).CombinedOutput(); err != nil {
				return nil, fmt.Errorf("record interrupt: %s", strings.TrimSpace(string(out)))
			}
			relayLogf("session_interrupt", "id=%s agent=%s outcome=confirmed ms=%d", e.SessionID, agent, time.Since(start).Milliseconds())
			return reply, nil
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	relayLogf("session_interrupt", "id=%s agent=%s outcome=unconfirmed ms=%d", e.SessionID, agent, time.Since(start).Milliseconds())
	reply["interrupted"] = false
	return reply, nil
}
