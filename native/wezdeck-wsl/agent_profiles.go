package main

// Agent profiles exposed to the web console. The source of truth remains the
// tracked worktree-task.env; this read model deliberately returns ids and
// labels only, never credentials or command strings.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

type agentProfile struct {
	ID            string `json:"id"`
	Label         string `json:"label"`
	Default       bool   `json:"default,omitempty"`
	Configured    bool   `json:"configured,omitempty"`
	Model         string `json:"model,omitempty"`
	ModelOverride string `json:"model_override,omitempty"`
	DefaultModel  string `json:"default_model,omitempty"`
	MaskedKey     string `json:"masked_key,omitempty"`
	// Kimi / gateway status (Claude Code /status parity). Never include raw keys.
	BaseURL           string `json:"base_url,omitempty"`
	EffortLevel       string `json:"effort_level,omitempty"`
	AutoCompactWindow string `json:"auto_compact_window,omitempty"`
	OpusModel         string `json:"opus_model,omitempty"`
	SonnetModel       string `json:"sonnet_model,omitempty"`
	HaikuModel        string `json:"haiku_model,omitempty"`
	FableModel        string `json:"fable_model,omitempty"`
	SubagentModel     string `json:"subagent_model,omitempty"`
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
		if id != "claude_kimi" {
			profile.ModelOverride = readEnvAssignment(agentModelPath(id), "MODEL")
		}
		switch id {
		case "claude":
			profile.DefaultModel = claudeDefaultModel()
		case "claude_sub2api":
			profile.DefaultModel = readEnvAssignment(sub2apiEnvPath(), "ANTHROPIC_MODEL")
			profile.MaskedKey = maskedGatewayKey(sub2apiEnvPath())
			profile.Configured = profile.MaskedKey != "" && readEnvAssignment(sub2apiEnvPath(), "ANTHROPIC_BASE_URL") != ""
		case "codex":
			profile.DefaultModel = readTOMLModel(codexConfigPath(), "", "model")
		case "grok":
			profile.DefaultModel = readTOMLModel(grokConfigPath(), "models", "default")
		case "claude_kimi":
			profile.Configured = kimiConfigured()
			if profile.Configured {
				fillKimiProfileStatus(&profile)
			}
		}
		profiles = append(profiles, profile)
	}
	sort.Slice(profiles, func(i, j int) bool { return profiles[i].ID < profiles[j].ID })
	return map[string]any{"v": 1, "ok": true, "profiles": profiles, "default": active}, nil
}

func maskKey(key string) string {
	if key == "" {
		return ""
	}
	if len(key) <= 4 {
		return "••••••••"
	}
	return "••••••••" + key[len(key)-4:]
}

func maskedGatewayKey(path string) string {
	key := readEnvAssignment(path, "ANTHROPIC_AUTH_TOKEN")
	if key == "" {
		key = readEnvAssignment(path, "ANTHROPIC_API_KEY")
	}
	if strings.HasPrefix(key, "sk-your-") {
		return ""
	}
	return maskKey(key)
}

func sub2apiEnvPath() string {
	if path := os.Getenv("CLAUDE_SUB2API_ENV"); path != "" {
		return path
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "claude-profiles", "sub2api.env")
}

func claudeDefaultModel() string {
	home, _ := os.UserHomeDir()
	path := filepath.Join(home, ".claude", "settings.json")
	if root := os.Getenv("CLAUDE_CONFIG_DIR"); root != "" {
		path = filepath.Join(root, "settings.json")
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var settings struct {
		Model string            `json:"model"`
		Env   map[string]string `json:"env"`
	}
	if json.Unmarshal(body, &settings) != nil {
		return ""
	}
	if model := settings.Env["ANTHROPIC_MODEL"]; model != "" {
		return model
	}
	return settings.Model
}

func codexConfigPath() string {
	if home := os.Getenv("CODEX_HOME"); home != "" {
		return filepath.Join(home, "config.toml")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "config.toml")
}

func grokConfigPath() string {
	if home := os.Getenv("GROK_HOME"); home != "" {
		return filepath.Join(home, "config.toml")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".grok", "config.toml")
}

const readTOMLModelScript = `import sys, tomllib
try:
    with open(sys.argv[1], "rb") as f:
        data = tomllib.load(f)
    if sys.argv[2]:
        data = data.get(sys.argv[2], {})
    value = data.get(sys.argv[3], "") if isinstance(data, dict) else ""
    if isinstance(value, str):
        print(value[:100])
except (OSError, ValueError):
    pass
`

func readTOMLModel(path, section, key string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	out, err := exec.CommandContext(ctx, "python3", "-c", readTOMLModelScript, path, section, key).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func agentModelPath(id string) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "wezdeck", "agent-models", id+".env")
}

var managedModelPattern = regexp.MustCompile(`^[a-zA-Z0-9._:/\[\]-]+$`)
var agentProfileIDPattern = regexp.MustCompile(`^[a-z0-9_]+$`)

func editableModelProfile(id string) bool {
	switch id {
	case "claude", "claude_sub2api", "codex", "grok":
		return true
	}
	return false
}

func configureAgentModel(args json.RawMessage) (any, error) {
	var input struct {
		Profile string `json:"profile"`
		Model   string `json:"model"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return nil, errors.New("agent.profile.model: bad arguments")
	}
	input.Model = strings.TrimSpace(input.Model)
	if input.Profile == "claude_kimi" {
		return nil, errors.New("agent.profile.model: configure Kimi in its own panel")
	}
	if !editableModelProfile(input.Profile) || !registeredAgentProfile(input.Profile) {
		return nil, errors.New("agent.profile.model: unknown profile")
	}
	if input.Model != "" && (len(input.Model) > 100 || !managedModelPattern.MatchString(input.Model)) {
		return nil, errors.New("agent.profile.model: invalid model id")
	}
	path := agentModelPath(input.Profile)
	if input.Model == "" {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("agent.profile.model: cannot clear model override")
		}
	} else {
		if err := writePrivateFile(path, []byte("MODEL='"+input.Model+"'\n")); err != nil {
			return nil, errors.New("agent.profile.model: cannot save model override")
		}
	}
	relayLogf("agent_profile", "profile=%s model_override=%q", input.Profile, input.Model)
	return map[string]any{"v": 1, "ok": true}, nil
}

func registeredAgentProfile(id string) bool {
	if !agentProfileIDPattern.MatchString(id) {
		return false
	}
	path := filepath.Join(repoRoot(), "config", "worktree-task.env")
	return readEnvAssignment(path, "WT_PROVIDER_AGENT_PROFILE_"+strings.ToUpper(id)+"_RESUME_COMMAND") != ""
}

func writePrivateFile(path string, body []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".agent-profile-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := tmp.Write(body); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
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

// fillKimiProfileStatus copies the Claude Code /status fields from kimi.env
// (official platform.kimi.ai Claude Code guide) into the web read model.
func fillKimiProfileStatus(profile *agentProfile) {
	path := kimiEnvPath()
	profile.BaseURL = readEnvAssignment(path, "ANTHROPIC_BASE_URL")
	profile.Model = readEnvAssignment(path, "ANTHROPIC_MODEL")
	profile.MaskedKey = maskKey(readEnvAssignment(path, "ANTHROPIC_AUTH_TOKEN"))
	profile.EffortLevel = readEnvAssignment(path, "CLAUDE_CODE_EFFORT_LEVEL")
	profile.AutoCompactWindow = readEnvAssignment(path, "CLAUDE_CODE_AUTO_COMPACT_WINDOW")
	profile.OpusModel = readEnvAssignment(path, "ANTHROPIC_DEFAULT_OPUS_MODEL")
	profile.SonnetModel = readEnvAssignment(path, "ANTHROPIC_DEFAULT_SONNET_MODEL")
	profile.HaikuModel = readEnvAssignment(path, "ANTHROPIC_DEFAULT_HAIKU_MODEL")
	profile.FableModel = readEnvAssignment(path, "ANTHROPIC_DEFAULT_FABLE_MODEL")
	profile.SubagentModel = readEnvAssignment(path, "CLAUDE_CODE_SUBAGENT_MODEL")
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
