package main

// Seen nonces survive a relay restart. The timestamp window is ±2 min, so a
// signed write captured before a restart (an upgrade, a crash) could be sent
// again within 2 min after it when the map lived only in memory. They sit
// next to the device approvals (0600), are kept 5 min, and are read once
// per process. Callers hold nonceMu.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var nonceLoad sync.Once

func nonceFile() string {
	return filepath.Join(filepath.Dir(deviceFile()), "remote-nonces.json")
}

func loadNonces() {
	nonceLoad.Do(func() {
		data, err := os.ReadFile(nonceFile())
		if err != nil {
			return
		}
		var saved map[string]int64 // nonce → ms seen
		if json.Unmarshal(data, &saved) != nil {
			return
		}
		for nonce, ms := range saved {
			if at := time.UnixMilli(ms); time.Since(at) <= 5*time.Minute {
				nonceSeen[nonce] = at
			}
		}
	})
}

func saveNonces() {
	saved := make(map[string]int64, len(nonceSeen))
	for nonce, at := range nonceSeen {
		saved[nonce] = at.UnixMilli()
	}
	data, err := json.Marshal(saved)
	if err != nil {
		return
	}
	path := nonceFile()
	if os.MkdirAll(filepath.Dir(path), 0o700) != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, data, 0o600) == nil {
		_ = os.Rename(tmp, path)
	}
}
