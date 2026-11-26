package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

type agentProfileSettings struct {
	Note     string `json:"note,omitempty"`
	Disabled bool   `json:"disabled,omitempty"`
}

func agentProfileSettingsPath(id string) string {
	if dir := os.Getenv("WEZDECK_AGENT_PROFILE_SETTINGS_DIR"); dir != "" {
		return filepath.Join(dir, id+".json")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "wezdeck", "agent-profiles", id+".json")
}

func readAgentProfileSettings(id string) (agentProfileSettings, error) {
	var empty agentProfileSettings
	body, err := os.ReadFile(agentProfileSettingsPath(id))
	if errors.Is(err, os.ErrNotExist) {
		return empty, nil
	}
	if err != nil {
		return empty, err
	}
	var settings *agentProfileSettings
	if err := json.Unmarshal(body, &settings); err != nil {
		return empty, err
	}
	if settings == nil || !validAgentProfileNote(settings.Note) {
		return empty, errors.New("invalid agent profile settings")
	}
	return *settings, nil
}

func agentProfileDisabled(id string) (bool, error) {
	settings, err := readAgentProfileSettings(id)
	return settings.Disabled, err
}

func validAgentProfileNote(note string) bool {
	if !utf8.ValidString(note) || utf8.RuneCountInString(note) > 240 {
		return false
	}
	for _, r := range note {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func configureAgentProfileSettings(args json.RawMessage) (any, error) {
	var input struct {
		Profile  string  `json:"profile"`
		Note     *string `json:"note"`
		Disabled *bool   `json:"disabled"`
	}
	if json.Unmarshal(args, &input) != nil || input.Note == nil || input.Disabled == nil {
		return nil, errors.New("agent.profile.settings: bad arguments")
	}
	if !registeredAgentProfile(input.Profile) {
		return nil, errors.New("agent.profile.settings: unknown profile")
	}
	note := strings.TrimSpace(*input.Note)
	if !validAgentProfileNote(note) {
		return nil, errors.New("agent.profile.settings: note must be one line of at most 240 characters")
	}
	path := agentProfileSettingsPath(input.Profile)
	if note == "" && !*input.Disabled {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("agent.profile.settings: cannot clear settings")
		}
	} else {
		body, err := json.Marshal(agentProfileSettings{Note: note, Disabled: *input.Disabled})
		if err != nil || writePrivateFile(path, append(body, '\n')) != nil {
			return nil, errors.New("agent.profile.settings: cannot save settings")
		}
	}
	relayLogf("agent_profile", "profile=%s disabled=%t note_present=%t", input.Profile, *input.Disabled, note != "")
	return map[string]any{"v": 1, "ok": true}, nil
}
