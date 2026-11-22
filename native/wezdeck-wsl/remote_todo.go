package main

// Repo follow-ups (待办) for the phone (docs/remote-access.md "Repo to-dos"):
// a to-do belongs to the repository a session runs in, so it outlives the
// conversation and any later session there can pick it up. Storage and repo
// resolution live in scripts/runtime/todo.py (SQLite table `todos`, keyed by
// the git common dir); the relay only maps a session to its directory.
//
//	todos {session?, all?}                 read: the session's repo, or every open one
//	todo  {op, session, text?, id?}        signed write: add | done | reopen | delete

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// sessionCwd: the directory a tracked session runs in.
func sessionCwd(id string) (string, error) {
	if !sessionIDPattern.MatchString(id) {
		return "", errors.New("invalid session id")
	}
	entries, err := liveSessions()
	if err != nil {
		return "", err
	}
	e, ok := entries[id]
	if !ok {
		return "", errors.New("session not found (ended or not tracked)")
	}
	_, cwd, _, _, _ := paneState(e)
	if cwd == "" {
		return "", errors.New("the session's directory is unknown")
	}
	return cwd, nil
}

func runTodoCLI(args ...string) (any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	argv := append([]string{filepath.Join(repoRoot(), "scripts", "runtime", "todo.py")}, args...)
	argv = append(argv, "--json")
	out, err := exec.CommandContext(ctx, "python3", argv...).Output()
	var result map[string]any
	if json.Unmarshal(out, &result) != nil {
		if err != nil {
			return nil, fmt.Errorf("todo: %v", err)
		}
		return nil, errors.New("todo: unreadable answer")
	}
	if ok, _ := result["ok"].(bool); !ok {
		msg, _ := result["error"].(string)
		return nil, fmt.Errorf("todo: %s", msg)
	}
	return result, nil
}

func listTodos(args json.RawMessage) (any, error) {
	var a struct {
		Session string `json:"session"`
		All     bool   `json:"all"`
	}
	if json.Unmarshal(args, &a) != nil {
		return nil, errors.New("bad request")
	}
	if a.All || a.Session == "" {
		return runTodoCLI("list", "--all", "--open")
	}
	cwd, err := sessionCwd(a.Session)
	if err != nil {
		return nil, err
	}
	return runTodoCLI("list", "--cwd", cwd)
}

func writeTodo(args json.RawMessage) (any, error) {
	var a struct {
		Op      string `json:"op"`
		Session string `json:"session"`
		Text    string `json:"text"`
		ID      int64  `json:"id"`
	}
	if json.Unmarshal(args, &a) != nil {
		return nil, errors.New("bad to-do request")
	}
	switch a.Op {
	case "add":
		text := strings.TrimSpace(a.Text)
		if text == "" || len(text) > 6000 {
			return nil, errors.New("to-do text is empty or too long")
		}
		cwd, err := sessionCwd(a.Session)
		if err != nil {
			return nil, err
		}
		return runTodoCLI("add", "--cwd", cwd, "--session", a.Session, "--source", "phone", "--", text)
	case "done", "reopen", "delete":
		if a.ID <= 0 {
			return nil, errors.New("to-do id missing")
		}
		return runTodoCLI(a.Op, strconv.FormatInt(a.ID, 10))
	}
	return nil, fmt.Errorf("unknown to-do op %q", a.Op)
}
