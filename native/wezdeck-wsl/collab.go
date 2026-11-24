package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// collabFlags is the allowlist of `ticket api <action>` commands the bridge
// exposes, with the payload keys each one may forward as `--<key> <value>`.
// Read-only by construction: api.py has no write verbs. Keep in lockstep with
// skills/agent-collab/schema/.
var collabFlags = map[string][]string{
	"health":     {"repo"},
	"list":       {"status", "repo", "parent", "since", "limit"},
	"show":       {"id"},
	"events":     {"after", "ticket", "limit"},
	"run":        {"run"},
	"prompt":     {"sha"},
	"transcript": {"run", "tail"},
	"metrics":    {"window", "ticket", "parent", "repo"},
}

var collabValue = regexp.MustCompile(`^[A-Za-z0-9_.:,+-]{1,128}$`)

func collabArgs(action string, payload json.RawMessage) ([]string, error) {
	keys, ok := collabFlags[action]
	if !ok {
		return nil, fmt.Errorf("unknown collab action %q", action)
	}
	values := map[string]any{}
	if len(payload) > 0 && string(payload) != "null" {
		if err := json.Unmarshal(payload, &values); err != nil {
			return nil, fmt.Errorf("payload: %w", err)
		}
	}
	args := []string{action}
	for _, key := range keys {
		raw, present := values[key]
		if !present || raw == nil {
			continue
		}
		var text string
		switch v := raw.(type) {
		case string:
			text = v
		case float64:
			text = fmt.Sprintf("%d", int64(v))
		default:
			return nil, fmt.Errorf("payload %s: unsupported type", key)
		}
		if text == "" {
			continue
		}
		if !collabValue.MatchString(text) {
			return nil, fmt.Errorf("payload %s: invalid value", key)
		}
		args = append(args, "--"+key, text)
	}
	return args, nil
}

// runCollab executes `python3 <repo>/skills/agent-collab/lib/api.py`.
// api.py always prints one JSON envelope ({"v":1,"ok":…}); a non-ok envelope
// is passed through as the result so the console can show the reason.
func runCollab(action string, payload json.RawMessage) (any, error) {
	args, err := collabArgs(action, payload)
	if err != nil {
		return nil, err
	}
	root := repoRoot()
	if root == "" {
		return nil, errors.New("repo root is empty")
	}
	script := filepath.Join(root, "skills", "agent-collab", "lib", "api.py")
	if _, err := os.Stat(script); err != nil {
		return nil, fmt.Errorf("ticket api missing: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "python3", append([]string{script}, args...)...)
	cmd.Env = append(os.Environ(), "TICKET_RUNTIME_LOG=0")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return nil, errors.New(detail)
	}
	var result any
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		return nil, err
	}
	return result, nil
}
