package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentProfilesExposeRegisteredIDsWithoutCommands(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "wezterm-x", "local"), 0o755); err != nil {
		t.Fatal(err)
	}
	config := "WT_PROVIDER_AGENT_PROFILE_CLAUDE_RESUME_COMMAND=claude\n" +
		"WT_PROVIDER_AGENT_PROFILE_CLAUDE_KIMI_RESUME_COMMAND=/secret/command\n" +
		"WT_PROVIDER_AGENT_PROFILE_EMPTY_RESUME_COMMAND=\n"
	if err := os.WriteFile(filepath.Join(root, "config", "worktree-task.env"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "wezterm-x", "local", "shared.env"), []byte("MANAGED_AGENT_PROFILE='claude_kimi'\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEZDECK_REPO", root)
	t.Setenv("MANAGED_AGENT_PROFILE", "")
	result, err := listAgentProfiles()
	if err != nil {
		t.Fatal(err)
	}
	data := result.(map[string]any)
	profiles := data["profiles"].([]agentProfile)
	if data["default"] != "claude_kimi" || len(profiles) != 2 {
		t.Fatalf("profiles: %+v", data)
	}
	body, _ := json.Marshal(result)
	if strings.Contains(string(body), "/secret/command") {
		t.Fatal("profile command leaked")
	}
	for _, profile := range profiles {
		if profile.ID == "claude_kimi" && !profile.Default {
			t.Fatal("Kimi should be the default")
		}
	}
}

func TestNewSessionRejectsUnknownAgentProfile(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config", "worktree-task.env"), []byte("WT_PROVIDER_AGENT_PROFILE_CLAUDE_RESUME_COMMAND=claude\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEZDECK_REPO", root)
	_, err := startNewSession(json.RawMessage(`{"repo":"/tmp","name":"test","prompt":"hi","agent_profile":"shell;rm"}`))
	if err == nil || err.Error() != "session.new: unknown agent profile" {
		t.Fatalf("want profile refusal, got %v", err)
	}
}

func TestNewSessionRejectsUnconfiguredKimiBeforeCreatingWorktree(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config", "worktree-task.env"), []byte("WT_PROVIDER_AGENT_PROFILE_CLAUDE_KIMI_RESUME_COMMAND=claude-kimi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEZDECK_REPO", root)
	t.Setenv("CLAUDE_KIMI_ENV", filepath.Join(root, "missing.env"))
	_, err := startNewSession(json.RawMessage(`{"repo":"/tmp","name":"test","prompt":"hi","agent_profile":"claude_kimi"}`))
	if err == nil || err.Error() != "session.new: configure the Kimi API key in Agents first" {
		t.Fatalf("want Kimi preflight refusal, got %v", err)
	}
}

func TestClaudeAdapterFindsKimiTranscript(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".config", "claude-profiles", "kimi-home", "projects", "-repo", "session-1.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := (claudeAdapter{}).Locate(home, "session-1"); got != path {
		t.Fatalf("Kimi transcript: got %q, want %q", got, path)
	}
}

func TestConfigureKimiProfileWritesPrivateFileWithoutReturningKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "claude-profiles", "kimi.env")
	t.Setenv("CLAUDE_KIMI_ENV", path)
	result, err := configureKimiProfile(json.RawMessage(`{"token":"sk-test-secret","model":"k3.1-pro"}`))
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credential file mode: %v", info.Mode().Perm())
	}
	content, _ := os.ReadFile(path)
	got := string(content)
	if !strings.Contains(got, "ANTHROPIC_API_KEY='sk-test-secret'") ||
		!strings.Contains(got, "ANTHROPIC_BASE_URL='https://api.kimi.ai/coding/'") ||
		!strings.Contains(got, "CLAUDE_CODE_AUTO_COMPACT_WINDOW='262144'") ||
		!strings.Contains(got, "CLAUDE_CODE_MAX_CONTEXT_TOKENS='262144'") ||
		!strings.Contains(got, "CLAUDE_CODE_EFFORT_LEVEL='high'") ||
		!strings.Contains(got, "CLAUDE_CODE_AUTO_MODE_SERVER='0'") ||
		!kimiConfigured() {
		t.Fatalf("credential file was not configured: %s", got)
	}
	if strings.Contains(got, "ANTHROPIC_AUTH_TOKEN=") {
		t.Fatal("Kimi Code profile must not also write AUTH_TOKEN")
	}
	body, _ := json.Marshal(result)
	if strings.Contains(string(body), "sk-test-secret") {
		t.Fatal("API key leaked in response")
	}
	if _, err := configureKimiProfile(json.RawMessage(`{"model":"k3.1-pro[1m]"}`)); err != nil {
		t.Fatalf("model-only update: %v", err)
	}
	content, _ = os.ReadFile(path)
	got = string(content)
	if !strings.Contains(got, "ANTHROPIC_API_KEY='sk-test-secret'") ||
		!strings.Contains(got, "ANTHROPIC_MODEL='k3.1-pro[1m]'") ||
		!strings.Contains(got, "CLAUDE_CODE_AUTO_COMPACT_WINDOW='1048576'") ||
		!strings.Contains(got, "CLAUDE_CODE_MAX_CONTEXT_TOKENS='1048576'") {
		t.Fatalf("model-only 1M update lost key/budget: %s", got)
	}
	if _, err := configureKimiProfile(json.RawMessage(`{"token":"bad'key","model":"k3.1-pro"}`)); err == nil {
		t.Fatal("unsafe API key accepted")
	}
}

func TestNewSessionPassesSelectedProfileToBothWorkstationPaths(t *testing.T) {
	create := newSessionCreateArgs("direction", "purpose", "claude_kimi")
	reuse := newSessionReuseArgs("/repo/worktree", "claude_kimi")
	if strings.Join(create, "|") != "--no-attach|--description|purpose|--agent-profile|claude_kimi|--|direction" {
		t.Fatalf("create args: %q", create)
	}
	if strings.Join(reuse, "|") != "--no-attach|--agent-profile|claude_kimi|/repo/worktree" {
		t.Fatalf("reuse args: %q", reuse)
	}
}

func TestAgentModelOverrideIsPrivateAndPerProfile(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("WEZDECK_REPO", root)
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	config := "WT_PROVIDER_AGENT_PROFILE_CLAUDE_RESUME_COMMAND=claude\n" +
		"WT_PROVIDER_AGENT_PROFILE_CODEX_RESUME_COMMAND=codex\n"
	if err := os.WriteFile(filepath.Join(root, "config", "worktree-task.env"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := configureAgentModel(json.RawMessage(`{"profile":"codex","model":"gpt-6.2-sol"}`)); err != nil {
		t.Fatal(err)
	}
	path := agentModelPath("codex")
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("private model file: %v, %v", info, err)
	}
	if got := readEnvAssignment(path, "MODEL"); got != "gpt-6.2-sol" {
		t.Fatalf("model override: %q", got)
	}
	listed, err := listAgentProfiles()
	if err != nil {
		t.Fatal(err)
	}
	for _, profile := range listed.(map[string]any)["profiles"].([]agentProfile) {
		if profile.ID == "codex" && profile.ModelOverride != "gpt-6.2-sol" {
			t.Fatalf("Codex panel model: %q", profile.ModelOverride)
		}
	}
	if _, err := configureAgentModel(json.RawMessage(`{"profile":"claude","model":"sonnet"}`)); err != nil {
		t.Fatal(err)
	}
	if got := readEnvAssignment(agentModelPath("claude"), "MODEL"); got != "sonnet" {
		t.Fatalf("Claude model override: %q", got)
	}
	if _, err := configureAgentModel(json.RawMessage(`{"profile":"codex","model":""}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("cleared override remains: %v", err)
	}
	if _, err := configureAgentModel(json.RawMessage(`{"profile":"codex","model":"bad key"}`)); err == nil {
		t.Fatal("invalid model accepted")
	}
}

func TestAgentProfilesReadExistingModelsAndMaskKeys(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("WEZDECK_REPO", home)
	t.Setenv("CODEX_HOME", "")
	t.Setenv("GROK_HOME", "")
	sub2api := filepath.Join(home, "sub2api.env")
	kimi := filepath.Join(home, "kimi.env")
	t.Setenv("CLAUDE_SUB2API_ENV", sub2api)
	t.Setenv("CLAUDE_KIMI_ENV", kimi)
	files := map[string]string{
		filepath.Join(home, "config", "worktree-task.env"): "WT_PROVIDER_AGENT_PROFILE_CLAUDE_RESUME_COMMAND=claude\nWT_PROVIDER_AGENT_PROFILE_CLAUDE_SUB2API_RESUME_COMMAND=claude-sub2api\nWT_PROVIDER_AGENT_PROFILE_CLAUDE_KIMI_RESUME_COMMAND=claude-kimi\nWT_PROVIDER_AGENT_PROFILE_CODEX_RESUME_COMMAND=codex\nWT_PROVIDER_AGENT_PROFILE_GROK_RESUME_COMMAND=grok\n",
		filepath.Join(home, ".claude", "settings.json"):    `{"model":"sonnet"}`,
		filepath.Join(home, ".codex", "config.toml"):       "model = \"gpt-6.2-sol\"\napi_key = \"codex-secret\"\n",
		filepath.Join(home, ".grok", "config.toml"):        "[models]\ndefault = \"grok-4.5\"\n[model.secret]\napi_key = \"grok-secret\"\n",
		sub2api: "ANTHROPIC_BASE_URL='https://gateway.example'\nANTHROPIC_AUTH_TOKEN='sub2api-secret-1234'\nANTHROPIC_MODEL='gateway-model'\n",
		kimi:    "ANTHROPIC_BASE_URL='https://api.kimi.ai/coding/'\nANTHROPIC_API_KEY='kimi-secret-5678'\nANTHROPIC_MODEL='k3.1-pro'\nANTHROPIC_DEFAULT_OPUS_MODEL='k3.1-pro'\nANTHROPIC_DEFAULT_SONNET_MODEL='k3.1-pro'\nANTHROPIC_DEFAULT_HAIKU_MODEL='k3.1-pro'\nANTHROPIC_DEFAULT_FABLE_MODEL='k3.1-pro'\nCLAUDE_CODE_SUBAGENT_MODEL='k3.1-pro'\nCLAUDE_CODE_AUTO_COMPACT_WINDOW='262144'\nCLAUDE_CODE_MAX_CONTEXT_TOKENS='262144'\nCLAUDE_CODE_EFFORT_LEVEL='high'\n",
	}
	for path, body := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	result, err := listAgentProfiles()
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]agentProfile{}
	for _, profile := range result.(map[string]any)["profiles"].([]agentProfile) {
		got[profile.ID] = profile
	}
	for id, model := range map[string]string{
		"claude": "sonnet", "claude_sub2api": "gateway-model",
		"codex": "gpt-6.2-sol", "grok": "grok-4.5",
	} {
		if got[id].DefaultModel != model {
			t.Fatalf("%s default model: %q, want %q", id, got[id].DefaultModel, model)
		}
	}
	if got["claude_sub2api"].MaskedKey != "••••••••1234" || !got["claude_sub2api"].Configured {
		t.Fatalf("gateway credential status: %+v", got["claude_sub2api"])
	}
	kimiProfile := got["claude_kimi"]
	if kimiProfile.MaskedKey != "••••••••5678" || kimiProfile.Model != "k3.1-pro" {
		t.Fatalf("Kimi credential/model status: %+v", kimiProfile)
	}
	if kimiProfile.BaseURL != "https://api.kimi.ai/coding/" || kimiProfile.EffortLevel != "high" || kimiProfile.AutoCompactWindow != "262144" || kimiProfile.MaxContextTokens != "262144" {
		t.Fatalf("Kimi /status fields: %+v", kimiProfile)
	}
	if kimiProfile.OpusModel != "k3.1-pro" || kimiProfile.SubagentModel != "k3.1-pro" {
		t.Fatalf("Kimi tier models: %+v", kimiProfile)
	}
	response, _ := json.Marshal(result)
	for _, secret := range []string{"sub2api-secret-1234", "kimi-secret-5678", "codex-secret", "grok-secret"} {
		if strings.Contains(string(response), secret) {
			t.Fatalf("secret leaked in profile response: %s", secret)
		}
	}
}
