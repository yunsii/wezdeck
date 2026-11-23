package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// A browser on the host reads sessions through the Runtime bridge
// (domain "remote"), the same read set the relay serves; writes stay out.
func TestServeRemoteReads(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TICKETS_ROOT", root)
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

	for _, write := range []string{"send", "key", "clear", "session.new", "ticket.new", "device.register"} {
		res := dispatch(request{Version: 2, Domain: "remote", Action: write,
			Payload: json.RawMessage(`{"id":"x","text":"hi"}`)})
		if res.OK || res.Status != "unknown_action" {
			t.Fatalf("remote.%s must not be served by the bridge: %+v", write, res)
		}
	}
}
