package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHostControlsWarpStatus(t *testing.T) {
	for _, tc := range []struct{ output, state, reason string }{
		{"Status update: Connected\r\n", "connected", ""},
		{"Status update: Disconnected\r\nReason: Settings Changed\r\n", "disconnected", "Settings Changed"},
		{"Status update: Connecting\n", "connecting", ""},
		{"Status update: Registration missing\n", "unknown", ""},
	} {
		if got := parseWarpStatus(tc.output); got.State != tc.state || got.Reason != tc.reason {
			t.Errorf("parseWarpStatus(%q) = %+v", tc.output, got)
		}
	}
	for _, args := range []string{`{}`, `{"connected":null}`, `{"connected":"yes"}`} {
		if _, err := setWarp(json.RawMessage(args)); err == nil {
			t.Errorf("setWarp(%s) accepted invalid arguments", args)
		}
	}
}

func TestHostControlsOppoStatus(t *testing.T) {
	appData := t.TempDir()
	stateDir := filepath.Join(appData, "Local", "wezterm-runtime", "state")
	t.Setenv("WEZDECK_ATTENTION_FILE", filepath.Join(stateDir, "agent-attention", "attention.json"))
	write := func(path string, data []byte) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	sample, err := json.Marshal(map[string]any{"active": true, "heartbeat_at_ms": time.Now().UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	badge := filepath.Join(stateDir, "oppo-remote", "status.json")
	write(badge, sample)
	logDir := filepath.Join(appData, "Roaming", "O+Connect", "devicespace")
	write(filepath.Join(logDir, "2026-11-26_main.log"), []byte(
		"[16.2.0][info] 2026-11-26 22:27:16.798 - [[link.telemetry]] daemon_state: login -> success\n"+
			"[16.2.0][info] 2026-11-26 22:27:24.272 - [[link.telemetry]] link_result: success=false, errorCode=11001, duration=19015ms\r\n"))
	if got := oppoStatus(); got.Active == nil || !*got.Active || got.LastResult != "failed" ||
		got.ErrorCode != "11001" || got.LastAt != "2026-11-26 22:27:24" {
		t.Fatalf("unexpected OPPO status: %+v", got)
	}
	write(badge, []byte(`{"active":true,"heartbeat_at_ms":1}`))
	write(filepath.Join(logDir, "2026-11-27_main.log"), []byte(
		"[16.2.0][info] 2026-11-27 00:02:19.700 - [[link.telemetry]] link_result: success=true, errorCode=undefined, duration=638ms\r\n"))
	if got := oppoStatus(); got.Active != nil || got.LastResult != "connected" || got.ErrorCode != "" {
		t.Fatalf("unexpected OPPO status with stale sampler: %+v", got)
	}
}
