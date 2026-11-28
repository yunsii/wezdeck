package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

func sessionPinsPath() string {
	if path := os.Getenv("WEZDECK_SESSION_PINS"); path != "" {
		return path
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "state", "wezdeck", "session-pins.json")
}

func readSessionPins(path string) (map[string]int64, error) {
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]int64{}, nil
	}
	if err != nil {
		return nil, err
	}
	var pins map[string]int64
	if json.Unmarshal(body, &pins) != nil || pins == nil {
		return nil, errors.New("invalid session pins")
	}
	return pins, nil
}

func saveSessionPins(path string, pins map[string]int64) error {
	body, err := json.Marshal(pins)
	if err != nil {
		return err
	}
	return writePrivateFile(path, append(body, '\n'))
}

func pendingPinRedirect(redirect sessionRedirect) bool {
	return isPendingSessionID(redirect.From) && !isPendingSessionID(redirect.To)
}

func sessionPinsForList(redirects []sessionRedirect) map[string]int64 {
	path := sessionPinsPath()
	pins, err := loadSessionPinsForList(path, redirects)
	if err != nil {
		relayLogf("session_pin", "outcome=read_failed err=%q", err)
	}
	return pins
}

func loadSessionPinsForList(path string, redirects []sessionRedirect) (map[string]int64, error) {
	pins, err := readSessionPins(path)
	if err != nil {
		return nil, err
	}
	for _, redirect := range redirects {
		if pendingPinRedirect(redirect) && pins[redirect.From] > 0 {
			return migrateSessionPins(path, redirects)
		}
	}
	return pins, nil
}

func migrateSessionPins(path string, redirects []sessionRedirect) (map[string]int64, error) {
	unlock, err := lockPrivateStateFile(path)
	if err != nil {
		return nil, err
	}
	defer unlock()
	pins, err := readSessionPins(path)
	if err != nil {
		return nil, err
	}
	changed := false
	for _, redirect := range redirects {
		at := pins[redirect.From]
		if at == 0 || !pendingPinRedirect(redirect) {
			continue
		}
		pins[redirect.To] = max(pins[redirect.To], at)
		delete(pins, redirect.From)
		changed = true
	}
	if changed {
		if err := saveSessionPins(path, pins); err != nil {
			return pins, err
		}
	}
	return pins, nil
}

func writeSessionPin(args json.RawMessage) (any, error) {
	var input struct {
		ID     string `json:"id"`
		Pinned *bool  `json:"pinned"`
	}
	if json.Unmarshal(args, &input) != nil || input.Pinned == nil || !sessionIDPattern.MatchString(input.ID) {
		return nil, errors.New("session.pin: bad arguments")
	}
	list, err := listSessionsFor(true)
	if err != nil {
		return nil, err
	}
	result := list.(map[string]any)
	id := input.ID
	for _, redirect := range result["redirects"].([]sessionRedirect) {
		if redirect.From == id && pendingPinRedirect(redirect) {
			id = redirect.To
			break
		}
	}
	for _, card := range result["sessions"].([]sessionCard) {
		if card.ID == id && card.TicketID == "" {
			at, err := setSessionPin(sessionPinsPath(), id, *input.Pinned)
			return map[string]any{"ok": err == nil, "id": id, "pinned_at": at}, err
		}
	}
	return nil, errors.New("session.pin: session is no longer in the list")
}

func setSessionPin(path, id string, pinned bool) (int64, error) {
	unlock, err := lockPrivateStateFile(path)
	if err != nil {
		return 0, err
	}
	defer unlock()
	pins, err := readSessionPins(path)
	if err != nil {
		return 0, err
	}
	at := pins[id]
	if pinned && at == 0 {
		at = time.Now().UnixMilli()
		pins[id] = at
	} else if !pinned && at != 0 {
		at = 0
		delete(pins, id)
	} else {
		return at, nil
	}
	return at, saveSessionPins(path, pins)
}
