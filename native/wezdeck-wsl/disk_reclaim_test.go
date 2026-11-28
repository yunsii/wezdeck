package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDiskReclaimRequiresConfirmationAndScopesStatus(t *testing.T) {
	dir := t.TempDir()
	status := filepath.Join(dir, "status.json")
	t.Setenv("WEZDECK_DISK_RECLAIM_STATUS_PATH", status)
	if _, err := startDiskReclaim(json.RawMessage(`{}`), "remote", "device-a"); err == nil {
		t.Fatal("reclaim started without confirmation")
	}
	stub := filepath.Join(dir, "stub.sh")
	argsFile := filepath.Join(dir, "args")
	if err := os.WriteFile(stub, []byte("#!/bin/bash\nprintf '%s\\n' \"$*\" > "+argsFile+"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEZDECK_DISK_RECLAIM_CMD", stub)
	result, err := startDiskReclaim(json.RawMessage(`{"confirm":true,"target_device":"device-b","command":"rm -rf /"}`), "remote", "device-a")
	if err != nil {
		t.Fatal(err)
	}
	id := result.(map[string]any)["task_id"].(string)
	if len(id) != 16 {
		t.Fatalf("unexpected task id %q", id)
	}
	if got := diskReclaimStatus("device-b")["phase"]; got != "none" {
		t.Fatalf("another device can see progress: %v", got)
	}
	owner := diskReclaimStatus("device-a")["task"].(diskReclaimState)
	if owner.TaskID != id || owner.TargetDevice != "device-a" || owner.Phase != "queued" {
		t.Fatalf("unexpected owner status: %+v", owner)
	}
	if _, err := startDiskReclaim(json.RawMessage(`{"confirm":true}`), "remote", "device-a"); err == nil {
		t.Fatal("second start accepted while first is queued")
	}
	// The fake script receives a fixed option set; browser-supplied command
	// text is never forwarded to a shell.
	for i := 0; i < 50; i++ {
		if body, err := os.ReadFile(argsFile); err == nil {
			if strings.Contains(string(body), "rm -rf") || !strings.Contains(string(body), "--target-device device-a") {
				t.Fatalf("unexpected script arguments: %s", body)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("stub was not started")
}

func TestDiskReclaimLocalDeviceTarget(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEZDECK_DISK_RECLAIM_STATUS_PATH", filepath.Join(dir, "status.json"))
	stub := filepath.Join(dir, "stub.sh")
	if err := os.WriteFile(stub, []byte("#!/bin/bash\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEZDECK_DISK_RECLAIM_CMD", stub)
	_, err := startDiskReclaim(json.RawMessage(`{"confirm":true,"target_device":"browser-1"}`), "local", "local")
	if err != nil {
		t.Fatal(err)
	}
	if got := diskReclaimStatus("browser-1")["phase"]; got == "none" {
		t.Fatal("local initiating browser cannot read its task")
	}
}

func TestDiskReclaimProgressFrameOmitsPrivateWorkerOutput(t *testing.T) {
	state := diskReclaimState{TaskID: "task-1", TargetDevice: "device-a", Phase: "failed",
		Error: "verification failed", VerifyOutput: "private host log and token",
		ReclaimedBytes: 123}
	state.History = append(state.History, struct {
		Phase string `json:"phase"`
		At    string `json:"at"`
	}{Phase: "verifying", At: "2026-11-28T12:00:00Z"})
	frame := diskReclaimProgressFrame(state)
	if frame.T != "disk.reclaim.progress" {
		t.Fatalf("unexpected frame type: %s", frame.T)
	}
	if strings.Contains(string(frame.Data), "private host log") || strings.Contains(string(frame.Data), "device-a") {
		t.Fatalf("private worker data reached progress push: %s", frame.Data)
	}
	if !strings.Contains(string(frame.Data), `"reclaimed_bytes":123`) {
		t.Fatalf("reclaimed bytes missing: %s", frame.Data)
	}
	if !strings.Contains(string(frame.Data), `"phase":"verifying"`) {
		t.Fatalf("phase history missing: %s", frame.Data)
	}
}
