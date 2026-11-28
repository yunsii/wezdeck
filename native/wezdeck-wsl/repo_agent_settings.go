package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

type repoAgentSettings map[string]string

func repoAgentSettingsPath() string {
	if path := os.Getenv("WEZDECK_REPO_AGENT_SETTINGS_FILE"); path != "" {
		return path
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "wezdeck", "repo-agents.json")
}

func readRepoAgentSettings() (repoAgentSettings, error) {
	body, err := os.ReadFile(repoAgentSettingsPath())
	if errors.Is(err, os.ErrNotExist) {
		return repoAgentSettings{}, nil
	}
	if err != nil {
		return nil, err
	}
	var settings repoAgentSettings
	if err := json.Unmarshal(body, &settings); err != nil || settings == nil {
		return nil, errors.New("invalid repository agent settings")
	}
	return settings, nil
}

// Resolve all repositories in one shell while using the terminal's workspace map.
func workspaceAgentProfiles(repos []string) []string {
	profiles := make([]string, len(repos))
	for i := range profiles {
		profiles[i] = activeAgentProfile()
	}
	if len(repos) == 0 || repoRoot() == "" {
		return profiles
	}
	lib := filepath.Join(repoRoot(), "scripts", "runtime", "worktree", "lib", "resume-command.sh")
	args := []string{"-c", `source "$1" || exit; root="$2"; shift 2; for repo in "$@"; do profile="$(resume_command_active_profile "$root" "$repo")" || exit; printf '%s\0' "$profile"; done`, "repo-agent", lib, repoRoot()}
	cmd := exec.Command("bash", append(args, repos...)...)
	out, err := cmd.Output()
	parts := bytes.Split(out, []byte{0})
	if err != nil || len(parts) != len(repos)+1 {
		relayLogf("repo_agent_resolve", "outcome=fallback repos=%d err=%q", len(repos), errText(err))
		return profiles
	}
	for i := range repos {
		if profile := strings.TrimSpace(string(parts[i])); profile != "" {
			profiles[i] = strings.ToLower(strings.ReplaceAll(profile, "-", "_"))
		}
	}
	return profiles
}

func repoAgentProfile(repo string) (profile, source string, err error) {
	settings, err := readRepoAgentSettings()
	if err != nil {
		return "", "", err
	}
	if profile := settings[repo]; profile != "" {
		return profile, "override", nil
	}
	return workspaceAgentProfiles([]string{repo})[0], "workspace", nil
}

func lockRepoAgentSettings() (func(), error) {
	path := repoAgentSettingsPath() + ".lock"
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		file.Close()
		return nil, err
	}
	return func() {
		_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		_ = file.Close()
	}, nil
}

func setRepoAgentProfile(args json.RawMessage) (any, error) {
	var input struct {
		Repo    string `json:"repo"`
		Profile string `json:"profile"`
	}
	if json.Unmarshal(args, &input) != nil {
		return nil, errors.New("repo.agent.set: bad arguments")
	}
	known := false
	for _, repo := range knownRepos() {
		if repo.Root == input.Repo {
			known = true
			break
		}
	}
	if !known {
		return nil, errors.New("repo.agent.set: unknown repository")
	}
	if input.Profile != "" {
		valid := false
		profiles, err := listAgentProfiles()
		if err != nil {
			return nil, err
		}
		for _, profile := range profiles.(map[string]any)["profiles"].([]agentProfile) {
			if profile.ID == input.Profile && !profile.Disabled {
				valid = true
				break
			}
		}
		if !valid {
			return nil, errors.New("repo.agent.set: unavailable agent profile")
		}
		if input.Profile == "claude_kimi" && !kimiConfigured() {
			return nil, errors.New("repo.agent.set: configure the Kimi API key first")
		}
	}
	unlock, err := lockRepoAgentSettings()
	if err != nil {
		return nil, errors.New("repo.agent.set: cannot lock settings")
	}
	defer unlock()
	settings, err := readRepoAgentSettings()
	if err != nil {
		return nil, err
	}
	if input.Profile == "" {
		delete(settings, input.Repo)
	} else {
		settings[input.Repo] = input.Profile
	}
	body, _ := json.Marshal(settings)
	if err := writePrivateFile(repoAgentSettingsPath(), append(body, '\n')); err != nil {
		return nil, errors.New("repo.agent.set: cannot save settings")
	}
	relayLogf("repo_agent", "repo=%q profile=%q source=%s", input.Repo, input.Profile, map[bool]string{true: "workspace", false: "override"}[input.Profile == ""])
	return map[string]any{"v": 1, "ok": true}, nil
}
