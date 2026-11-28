package main

// `session.restart {id, fresh}` (signed write): the web console's 重启会话
// (fresh=false, the desk's F5: respawn the pane, the agent resumes its
// conversation) and 新开会话 (fresh=true, Ctrl+Shift+n: a blank agent
// process — the only way out of a name Claude keeps carrying across /clear).
// The work is scripts/runtime/session-restart.sh, run against the session's
// own pane on its own tmux server; only that pane is respawned.
//
// A fresh Claude start comes back with the new conversation's id: the script
// marks the old entry cleared_to it, so `session` on the old id answers
// replaced_by and the page follows (useFollowReplacement), as after /clear.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func restartSession(args json.RawMessage) (any, error) {
	var a struct {
		ID      string `json:"id"`
		Fresh   bool   `json:"fresh"`
		Recover bool   `json:"recover"`
	}
	if json.Unmarshal(args, &a) != nil {
		return nil, errors.New("session.restart: bad arguments")
	}
	if a.Recover {
		if a.Fresh {
			return nil, errors.New("session.restart: recovery requires the original conversation")
		}
		return recoverCodexSession(a.ID)
	}
	e, err := guardSession(a.ID)
	if err != nil {
		return nil, err
	}
	// Anything still outside the transcript belongs to the old process. Do
	// this before both resume and fresh respawns so the restarted pane cannot
	// resurrect an old web send as an active turn.
	dismissSessionOutbox(a.ID, "discarded at process restart")
	agent := sessionAgentFamily(e)
	cmdPath := os.Getenv("WEZDECK_SESSION_RESTART_CMD")
	if cmdPath == "" {
		cmdPath = filepath.Join(repoRoot(), "scripts", "runtime", "session-restart.sh")
	}
	argv := []string{cmdPath, "--pane", e.TmuxPane}
	if agent != "" {
		argv = append(argv, "--agent", agent)
	}
	if a.Fresh {
		argv = append(argv, "--fresh")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	start := time.Now()
	cmd := exec.CommandContext(ctx, "bash", argv...)
	cmd.Env = os.Environ()
	cmd.Env = append(cmd.Env, "WEZDECK_RESTART_SESSION_ID="+a.ID)
	if e.TmuxSocket != "" {
		// tmux without -S follows $TMUX: the session's own server
		cmd.Env = append(cmd.Env, "TMUX="+e.TmuxSocket+",0,0")
	}
	if p := os.Getenv("WEZDECK_ATTENTION_FILE"); p != "" {
		cmd.Env = append(cmd.Env, "WEZDECK_ATTENTION_STATE_PATH="+p, "WEZTERM_ATTENTION_LOCK_FILE="+p+".lock")
	}
	out, err := cmd.Output()
	result := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	for sc.Scan() {
		if k, v, ok := strings.Cut(sc.Text(), "="); ok {
			result[k] = v
		}
	}
	relayLogf("session_restart", "id=%s fresh=%t agent=%s outcome=%q new=%s ms=%d",
		a.ID, a.Fresh, agent, result["outcome"], result["session_id"], time.Since(start).Milliseconds())
	if err != nil || result["outcome"] != "respawned" {
		msg := result["outcome"]
		if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
			msg = strings.TrimSpace(string(ee.Stderr))
		} else if msg == "" && err != nil {
			msg = err.Error()
		}
		return nil, fmt.Errorf("restart failed: %s", clip(msg, 200))
	}
	reply := map[string]any{"v": 1, "ok": true, "id": a.ID, "fresh": a.Fresh}
	if id := result["session_id"]; id != "" {
		reply["session_id"] = id
	}
	return reply, nil
}
