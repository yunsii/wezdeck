package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentProfileSettingsArePrivateAndBlockNewLaunches(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("WEZDECK_REPO", home)
	t.Setenv("MANAGED_AGENT_PROFILE", "claude")
	if err := os.MkdirAll(filepath.Join(home, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	config := "WT_PROVIDER_AGENT_PROFILE_CLAUDE_RESUME_COMMAND=claude\n" +
		"WT_PROVIDER_AGENT_PROFILE_CODEX_RESUME_COMMAND=codex\n" +
		"WT_PROVIDER_AGENT_PROFILE_GROK_RESUME_COMMAND=grok\n"
	if err := os.WriteFile(filepath.Join(home, "config", "worktree-task.env"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := configureAgentProfileSettings(json.RawMessage(`{"profile":"claude","note":"当前不可用","disabled":true}`))
	if err != nil {
		t.Fatal(err)
	}
	path := agentProfileSettingsPath("claude")
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("private settings file: %v, %v", info, err)
	}
	listed, err := listAgentProfiles()
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, profile := range listed.(map[string]any)["profiles"].([]agentProfile) {
		if profile.ID == "claude" {
			found = profile.Disabled && profile.Note == "当前不可用"
		}
	}
	if !found {
		t.Fatal("disabled profile and note missing from agent.profiles")
	}
	for _, args := range []string{
		`{"repo":"/tmp","name":"test","prompt":"hi","agent_profile":"claude"}`,
		`{"repo":"/tmp","name":"test","prompt":"hi"}`,
	} {
		_, err := startNewSession(json.RawMessage(args))
		if err == nil || !strings.Contains(err.Error(), "disabled") {
			t.Fatalf("disabled new session was accepted: %v", err)
		}
	}
	if _, err := startSessionHandoff(json.RawMessage(`{"id":"missing","to":"claude"}`)); err == nil || !strings.Contains(err.Error(), "disabled") {
		t.Fatalf("disabled handoff was accepted: %v", err)
	}
	if _, err := configureAgentProfileSettings(json.RawMessage(`{"profile":"grok","note":"不能自动处理用户消息队列，不建议在交互场景下使用","disabled":false}`)); err != nil {
		t.Fatal(err)
	}
	if settings, err := readAgentProfileSettings("grok"); err != nil || settings.Note == "" || settings.Disabled {
		t.Fatalf("Grok note: %+v, %v", settings, err)
	}
	for _, args := range []string{
		`{"profile":"unknown","note":"x","disabled":true}`,
		`{"profile":"codex","note":"bad\nline","disabled":false}`,
		`{"profile":"codex","note":"x"}`,
	} {
		if _, err := configureAgentProfileSettings(json.RawMessage(args)); err == nil {
			t.Fatalf("invalid settings accepted: %s", args)
		}
	}
	if _, err := configureAgentProfileSettings(json.RawMessage(`{"profile":"claude","note":"","disabled":false}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("cleared profile settings remain: %v", err)
	}
}
