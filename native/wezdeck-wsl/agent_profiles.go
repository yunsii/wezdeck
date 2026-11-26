package main

// Agent profiles exposed to the web console. The source of truth remains the
// tracked worktree-task.env; this read model deliberately returns ids and
// labels only, never credentials or command strings.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type agentProfile struct {
	ID         string `json:"id"`
	Label      string `json:"label"`
	Default    bool   `json:"default,omitempty"`
	Configured bool   `json:"configured,omitempty"`
	Model      string `json:"model,omitempty"`
}

var agentProfileKey = regexp.MustCompile(`^WT_PROVIDER_AGENT_PROFILE_([A-Z0-9_]+)_RESUME_COMMAND=(.+)$`)

func agentProfileLabel(id string) string {
	switch id {
	case "claude":
		return "Claude"
	case "claude_sub2api":
		return "Claude · gateway"
	case "claude_kimi":
		return "Claude · Kimi"
	case "codex":
		return "Codex"
	case "grok":
		return "Grok"
	default:
		return id
	}
}

func readEnvAssignment(path, key string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	for scanner := bufio.NewScanner(f); scanner.Scan(); {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, key+"=") {
			continue
		}
		value := strings.TrimSpace(strings.TrimPrefix(line, key+"="))
		return strings.Trim(value, "'\"")
	}
	return ""
}

func activeAgentProfile() string {
	if value := strings.TrimSpace(os.Getenv("MANAGED_AGENT_PROFILE")); value != "" {
		return strings.TrimSuffix(strings.TrimSuffix(value, "-resume"), "_resume")
	}
	path := filepath.Join(repoRoot(), "wezterm-x", "local", "shared.env")
	value := readEnvAssignment(path, "MANAGED_AGENT_PROFILE")
	if value == "" {
		value = readEnvAssignment(filepath.Join(repoRoot(), "config", "worktree-task.env"), "WT_PROVIDER_AGENT_PROFILE")
	}
	value = strings.TrimSuffix(strings.TrimSuffix(value, "-resume"), "_resume")
	if value == "" {
		return "claude"
	}
	return strings.ToLower(strings.ReplaceAll(value, "-", "_"))
}

func listAgentProfiles() (any, error) {
	path := filepath.Join(repoRoot(), "config", "worktree-task.env")
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	ids := map[string]bool{}
	for scanner := bufio.NewScanner(f); scanner.Scan(); {
		match := agentProfileKey.FindStringSubmatch(strings.TrimSpace(scanner.Text()))
		if len(match) != 3 || strings.TrimSpace(match[2]) == "" {
			continue
		}
		ids[strings.ToLower(match[1])] = true
	}
	active := activeAgentProfile()
	profiles := make([]agentProfile, 0, len(ids))
	for id := range ids {
		profile := agentProfile{ID: id, Label: agentProfileLabel(id), Default: id == active}
		if id == "claude_kimi" {
			profile.Configured = kimiConfigured()
			if profile.Configured {
				profile.Model = readEnvAssignment(kimiEnvPath(), "ANTHROPIC_MODEL")
			}
		}
		profiles = append(profiles, profile)
	}
	sort.Slice(profiles, func(i, j int) bool { return profiles[i].ID < profiles[j].ID })
	return map[string]any{"v": 1, "ok": true, "profiles": profiles, "default": active}, nil
}

func kimiEnvPath() string {
	if path := os.Getenv("CLAUDE_KIMI_ENV"); path != "" {
		return path
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "claude-profiles", "kimi.env")
}

func kimiConfigured() bool {
	path := kimiEnvPath()
	token := readEnvAssignment(path, "ANTHROPIC_AUTH_TOKEN")
	return token != "" && token != "sk-your-moonshot-api-key"
}

var kimiModelPattern = regexp.MustCompile(`^[a-zA-Z0-9._-]+(?:\[[a-zA-Z0-9]+\])?$`)

func configureKimiProfile(args json.RawMessage) (any, error) {
	var input struct {
		Token string `json:"token"`
		Model string `json:"model"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return nil, errors.New("agent.profile.configure: bad arguments")
	}
	input.Token = strings.TrimSpace(input.Token)
	input.Model = strings.TrimSpace(input.Model)
	if input.Token == "" {
		input.Token = readEnvAssignment(kimiEnvPath(), "ANTHROPIC_AUTH_TOKEN")
	}
	if len(input.Token) < 8 || len(input.Token) > 512 || strings.ContainsAny(input.Token, " \t\r\n'\"") {
		return nil, errors.New("agent.profile.configure: invalid API key")
	}
	if !kimiModelPattern.MatchString(input.Model) || len(input.Model) > 80 {
		return nil, errors.New("agent.profile.configure: invalid model id")
	}
	path := kimiEnvPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, errors.New("agent.profile.configure: cannot create credential directory")
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".kimi.env-*")
	if err != nil {
		return nil, errors.New("agent.profile.configure: cannot create credential file")
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if err := tmp.Chmod(0o600); err != nil {
		return nil, errors.New("agent.profile.configure: cannot protect credential file")
	}
	content := fmt.Sprintf("ANTHROPIC_BASE_URL='https://api.moonshot.ai/anthropic'\nANTHROPIC_AUTH_TOKEN='%s'\n", input.Token)
	for _, key := range []string{
		"ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
	} {
		content += fmt.Sprintf("%s='%s'\n", key, input.Model)
	}
	content += "CLAUDE_CODE_AUTO_COMPACT_WINDOW='1000000'\nCLAUDE_CODE_EFFORT_LEVEL='max'\n"
	if _, err := tmp.WriteString(content); err != nil {
		return nil, errors.New("agent.profile.configure: cannot write credential file")
	}
	if err := tmp.Sync(); err != nil {
		return nil, errors.New("agent.profile.configure: cannot sync credential file")
	}
	if err := tmp.Close(); err != nil {
		return nil, errors.New("agent.profile.configure: cannot close credential file")
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return nil, errors.New("agent.profile.configure: cannot install credential file")
	}
	relayLogf("agent_profile", "profile=claude_kimi configured=true model=%q", input.Model)
	return map[string]any{"v": 1, "ok": true, "configured": true}, nil
}
