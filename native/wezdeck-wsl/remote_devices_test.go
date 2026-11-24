package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestListDevicesOmitsKeysAndOrdersPendingFirst(t *testing.T) {
	path := filepath.Join(t.TempDir(), "remote-devices.json")
	t.Setenv("WEZDECK_REMOTE_DEVICES", path)
	store := deviceStore{
		Approved: []deviceRecord{{ID: "aaaa", Name: "Linux", PublicKey: "SECRETKEY", At: "2026-11-20T10:00:00Z",
			SeenAt: "2026-11-24T08:00:00Z", Info: &deviceInfo{Browser: "Chrome 157", OS: "Android 16", Mobile: true}}},
		Pending: []deviceRecord{{ID: "bbbb", Name: "ev\x1bil", PublicKey: "OTHERKEY", At: "2026-11-24T09:00:00Z"}},
	}
	data, _ := json.Marshal(store)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := listDevices()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(got)
	if strings.Contains(string(raw), "KEY") {
		t.Fatalf("public key leaked: %s", raw)
	}
	devices := got.(map[string]any)["devices"].([]deviceView)
	if len(devices) != 2 || devices[0].ID != "bbbb" || devices[0].State != "pending" ||
		devices[1].State != "approved" || devices[1].Info.Browser != "Chrome 157" {
		t.Fatalf("unexpected list: %s", raw)
	}
	if devices[0].Name != "evil" {
		t.Fatalf("control characters kept: %q", devices[0].Name)
	}
}

func TestListDevicesEmptyStore(t *testing.T) {
	t.Setenv("WEZDECK_REMOTE_DEVICES", filepath.Join(t.TempDir(), "none.json"))
	got, _ := listDevices()
	raw, _ := json.Marshal(got)
	if string(raw) != `{"devices":[]}` {
		t.Fatalf("got %s", raw)
	}
}

func TestRelayDoesNotServeDeviceList(t *testing.T) {
	if _, ok, _ := readRPC("devices", json.RawMessage("{}")); ok {
		t.Fatal("devices must stay local (serve.go), not a relay read")
	}
}
