package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// A browser on the host reads sessions through the Runtime bridge
// (domain "remote"), the same read set the relay serves, and writes without
// a device key (remote_write.go) — but not device registration.
func TestServeRemoteReads(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TICKETS_ROOT", root)
	// the write row must not land in the live relay.log
	t.Setenv("WEZDECK_RELAY_LOG_DIR", t.TempDir())
	cfg := "targets:\n  alpha:\n    path: /tmp/alpha\n  beta:\n    path: /tmp/beta\n"
	if err := os.WriteFile(filepath.Join(root, "config.yml"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	res := dispatch(request{Version: 2, Domain: "remote", Action: "ticket.targets"})
	if !res.OK {
		t.Fatalf("remote.ticket.targets: %s %s", res.Status, res.Error)
	}
	body, _ := json.Marshal(res.Result)
	var got struct {
		Targets []ticketTarget `json:"targets"`
	}
	_ = json.Unmarshal(body, &got)
	if len(got.Targets) != 2 || got.Targets[0].Key != "alpha" {
		t.Fatalf("targets = %+v", got.Targets)
	}

	// device registration stays a relay-only thing
	if res := dispatch(request{Version: 2, Domain: "remote", Action: "device.register"}); res.Status != "unknown_action" {
		t.Fatalf("remote.device.register must not be served by the bridge: %+v", res)
	}
	// a write from this computer runs the real action with its own guards:
	// a bad session id is refused by sendToSession, not as an unknown action
	res = dispatch(request{Version: 2, Domain: "remote", Action: "send",
		Payload: json.RawMessage(`{"id":"../nope","text":"hi"}`)})
	if res.OK || res.Status == "unknown_action" {
		t.Fatalf("remote.send should reach sendToSession and be refused there: %+v", res)
	}
}
