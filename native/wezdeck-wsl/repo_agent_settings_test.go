package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRepositoryAgentSettingResolvesAndPersists(t *testing.T) {
	wd, _ := os.Getwd()
	t.Setenv("WEZDECK_REPO", filepath.Clean(filepath.Join(wd, "../..")))
	t.Setenv("MANAGED_AGENT_PROFILE", "claude")
	repo, _ := newSessionFixture(t)
	settingsPath := os.Getenv("WEZDECK_REPO_AGENT_SETTINGS_FILE")
	profile, source, err := repoAgentProfile(repo)
	if err != nil || profile == "" || source != "workspace" {
		t.Fatalf("workspace default: %q %q %v", profile, source, err)
	}
	args, _ := json.Marshal(map[string]string{"repo": repo, "profile": "codex"})
	if _, err := setRepoAgentProfile(args); err != nil {
		t.Fatal(err)
	}
	profile, source, err = repoAgentProfile(repo)
	if err != nil || profile != "codex" || source != "override" {
		t.Fatalf("override: %q %q %v", profile, source, err)
	}
	listed, err := listRepos()
	if err != nil {
		t.Fatal(err)
	}
	choices := listed.(map[string]any)["repos"].([]repoChoice)
	if len(choices) != 1 || choices[0].AgentProfile != "codex" || choices[0].AgentSource != "override" || choices[0].WorkspaceAgentProfile != "claude" {
		t.Fatalf("repo list: %+v", choices)
	}
	if info, err := os.Stat(settingsPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("settings permissions: %v %v", info, err)
	}
	args, _ = json.Marshal(map[string]string{"repo": repo, "profile": ""})
	if _, err := setRepoAgentProfile(args); err != nil {
		t.Fatal(err)
	}
	profile, source, err = repoAgentProfile(repo)
	if err != nil || profile == "" || source != "workspace" {
		t.Fatalf("restored workspace default: %q %q %v", profile, source, err)
	}
}

func TestRepositoryAgentSettingRejectsUnknownRepoAndProfile(t *testing.T) {
	wd, _ := os.Getwd()
	t.Setenv("WEZDECK_REPO", filepath.Clean(filepath.Join(wd, "../..")))
	t.Setenv("CLAUDE_KIMI_ENV", filepath.Join(t.TempDir(), "missing-kimi.env"))
	repo, _ := newSessionFixture(t)
	for _, input := range []map[string]string{
		{"repo": filepath.Dir(repo), "profile": "codex"},
		{"repo": repo, "profile": "shell;rm"},
		{"repo": repo, "profile": "claude_kimi"},
	} {
		args, _ := json.Marshal(input)
		if _, err := setRepoAgentProfile(args); err == nil {
			t.Fatalf("accepted %+v", input)
		}
	}
}

func TestRepositoryAgentFollowsWorkspaceMap(t *testing.T) {
	wd, _ := os.Getwd()
	source := filepath.Join(wd, "..", "..", "scripts", "runtime", "worktree", "lib", "resume-command.sh")
	body, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	repo, _ := newSessionFixture(t)
	host := t.TempDir()
	lib := filepath.Join(host, "scripts", "runtime", "worktree", "lib", "resume-command.sh")
	if err := os.MkdirAll(filepath.Dir(lib), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lib, body, 0o600); err != nil {
		t.Fatal(err)
	}
	mapPath := filepath.Join(host, "wezterm-x", "local", "workspace-agent-map.tsv")
	if err := os.MkdirAll(filepath.Dir(mapPath), 0o700); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(t.TempDir(), "other")
	if err := os.WriteFile(mapPath, []byte(repo+"\tgrok\n"+other+"\tcodex\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEZDECK_REPO", host)
	resolved := workspaceAgentProfiles([]string{repo, other})
	if len(resolved) != 2 || resolved[0] != "grok" || resolved[1] != "codex" {
		t.Fatalf("batch workspace map: %+v", resolved)
	}
	profile, sourceKind, err := repoAgentProfile(repo)
	if err != nil || profile != "grok" || sourceKind != "workspace" {
		t.Fatalf("workspace map: %q %q %v", profile, sourceKind, err)
	}
}

func TestRepositoryListSurvivesCorruptSettings(t *testing.T) {
	wd, _ := os.Getwd()
	t.Setenv("WEZDECK_REPO", filepath.Clean(filepath.Join(wd, "../..")))
	repo, _ := newSessionFixture(t)
	if err := os.WriteFile(repoAgentSettingsPath(), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := listRepos()
	if err != nil {
		t.Fatal(err)
	}
	listed := result.(map[string]any)
	choices := listed["repos"].([]repoChoice)
	if listed["settings_error"] != true || len(choices) != 1 || choices[0].Root != repo || choices[0].AgentProfile == "" || choices[0].AgentSource != "workspace" {
		t.Fatalf("degraded repository list: %+v", listed)
	}
	_, err = startNewSession(json.RawMessage(`{"repo":"` + repo + `","name":"test","prompt":"hi"}`))
	if err == nil || !strings.Contains(err.Error(), "invalid repository agent settings") {
		t.Fatalf("default creation should refuse corrupt settings: %v", err)
	}
}

func TestNewSessionRejectsUnknownResolvedAgent(t *testing.T) {
	wd, _ := os.Getwd()
	t.Setenv("WEZDECK_REPO", filepath.Clean(filepath.Join(wd, "../..")))
	repo, _ := newSessionFixture(t)
	body, _ := json.Marshal(repoAgentSettings{repo: "not_a_real_agent"})
	if err := os.WriteFile(repoAgentSettingsPath(), body, 0o600); err != nil {
		t.Fatal(err)
	}
	args, _ := json.Marshal(map[string]string{"repo": repo, "name": "test", "prompt": "hi"})
	_, err := startNewSession(args)
	if err == nil || err.Error() != "session.new: unknown agent profile" {
		t.Fatalf("unknown resolved profile: %v", err)
	}
}

func TestNewSessionDistinguishesUnreadableAgentSettings(t *testing.T) {
	wd, _ := os.Getwd()
	t.Setenv("WEZDECK_REPO", filepath.Clean(filepath.Join(wd, "../..")))
	t.Setenv("MANAGED_AGENT_PROFILE", "claude")
	settingsDir := t.TempDir()
	t.Setenv("WEZDECK_AGENT_PROFILE_SETTINGS_DIR", settingsDir)
	repo, _ := newSessionFixture(t)
	if err := os.WriteFile(filepath.Join(settingsDir, "claude.json"), []byte("bad json"), 0o600); err != nil {
		t.Fatal(err)
	}
	args, _ := json.Marshal(map[string]string{"repo": repo, "name": "test", "prompt": "hi"})
	_, err := startNewSession(args)
	if err == nil || !strings.Contains(err.Error(), "cannot read claude agent settings") {
		t.Fatalf("unreadable profile settings: %v", err)
	}
}

func TestRepositoryAgentSettingsLockBlocksConcurrentWriter(t *testing.T) {
	_, _ = newSessionFixture(t)
	unlock, err := lockRepoAgentSettings()
	if err != nil {
		t.Fatal(err)
	}
	acquired := make(chan error, 1)
	go func() {
		release, err := lockRepoAgentSettings()
		if err == nil {
			release()
		}
		acquired <- err
	}()
	select {
	case err := <-acquired:
		unlock()
		t.Fatalf("second writer acquired lock early: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	unlock()
	select {
	case err := <-acquired:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("second writer did not acquire released lock")
	}
}
