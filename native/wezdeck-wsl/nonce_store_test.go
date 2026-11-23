package main

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// a nonce seen before a restart is still a replay after it; stale ones go
func TestNoncesSurviveRestart(t *testing.T) {
	t.Setenv("WEZDECK_REMOTE_DEVICES", filepath.Join(t.TempDir(), "devices.json"))
	reset := func() {
		nonceSeen = map[string]time.Time{}
		nonceLoad = sync.Once{}
	}
	reset()
	nonceMu.Lock()
	loadNonces()
	nonceSeen["fresh"] = time.Now()
	nonceSeen["stale"] = time.Now().Add(-6 * time.Minute)
	saveNonces()
	nonceMu.Unlock()

	reset() // the relay restarts
	nonceMu.Lock()
	loadNonces()
	_, fresh := nonceSeen["fresh"]
	_, stale := nonceSeen["stale"]
	nonceMu.Unlock()
	if !fresh || stale {
		t.Fatalf("after restart: fresh=%v stale=%v", fresh, stale)
	}
	reset()
}

func TestRelayLogIsOwnerOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "logs", "relay.log")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := openRelayLog(path)
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("relay.log mode %v", info.Mode().Perm())
	}
}
