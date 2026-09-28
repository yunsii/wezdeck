package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func repoRoot() string {
	if value := os.Getenv("WEZDECK_REPO"); value != "" {
		return value
	}
	if value := os.Getenv("WEZTERM_CONFIG_REPO"); value != "" {
		return value
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	candidates := []string{}
	if home != "" {
		candidates = append(candidates, filepath.Join(home, ".wezterm-x", "repo-root.txt"))
	}
	if win := os.Getenv("WEZDECK_WINDOWS_HOME"); win != "" {
		candidates = append(candidates, filepath.Join(win, ".wezterm-x", "repo-root.txt"))
	}
	for _, path := range candidates {
		body, err := os.ReadFile(path)
		if err == nil && strings.TrimSpace(string(body)) != "" {
			return strings.TrimSpace(string(body))
		}
	}
	return ""
}

func catalogEnv() []string {
	root := repoRoot()
	runtime := filepath.Join(os.Getenv("HOME"), ".wezterm-x")
	if root == "" {
		return nil
	}
	if win := os.Getenv("WEZDECK_WINDOWS_HOME"); win != "" {
		runtime = filepath.Join(win, ".wezterm-x")
	}
	return []string{
		"WEZDECK_REPO=" + root,
		"WEZTERM_CONFIG_REPO=" + root,
		"WEZTERM_RUNTIME_DIR=" + runtime,
		"WORKSPACE_CATALOG_CONFIG_DIR=" + filepath.Dir(runtime),
		"WEZTERM_MOCK_PATH=" + filepath.Join(root, "tests", "lua-units", "?.lua"),
	}
}

func runDump(script string, args []string, extra []string) (any, error) {
	root := repoRoot()
	if root == "" {
		return nil, errors.New("repo root is empty")
	}
	command := append([]string{filepath.Join(root, "scripts", "runtime", script)}, args...)
	cmd := exec.Command("lua5.4", command...)
	cmd.Env = append(os.Environ(), extra...)
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
