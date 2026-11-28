package main

// Disk reclaim is one fixed host operation. The approved device chooses when
// to start; it never supplies a shell command, distro, or VHDX path.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type diskReclaimState struct {
	TaskID                string  `json:"task_id"`
	TargetDevice          string  `json:"target_device"`
	Phase                 string  `json:"phase"`
	Stage                 string  `json:"stage,omitempty"`
	FailedStage           string  `json:"failed_stage,omitempty"`
	Error                 string  `json:"error,omitempty"`
	StartedAt             string  `json:"started_at,omitempty"`
	UpdatedAt             string  `json:"updated_at,omitempty"`
	DurationSeconds       float64 `json:"duration_seconds,omitempty"`
	ActiveAttention       int     `json:"active_attention,omitempty"`
	SnapshotWindows       int     `json:"snapshot_windows,omitempty"`
	BeforeFreeBytes       int64   `json:"before_free_bytes,omitempty"`
	AfterFreeBytes        int64   `json:"after_free_bytes,omitempty"`
	ReclaimedBytes        int64   `json:"reclaimed_bytes,omitempty"`
	BeforeVhdxBytes       int64   `json:"before_vhdx_bytes,omitempty"`
	AfterVhdxBytes        int64   `json:"after_vhdx_bytes,omitempty"`
	VhdxReducedBytes      int64   `json:"vhdx_reduced_bytes,omitempty"`
	CompactElapsedSeconds float64 `json:"compact_elapsed_seconds,omitempty"`
	TrimExit              *int    `json:"trim_exit,omitempty"`
	CompactExit           *int    `json:"compact_exit,omitempty"`
	VerifyExit            *int    `json:"verify_exit,omitempty"`
	VerifyOutput          string  `json:"verify_output,omitempty"`
	KeepaliveState        string  `json:"keepalive_state,omitempty"`
	History               []struct {
		Phase string `json:"phase"`
		At    string `json:"at"`
	} `json:"history,omitempty"`
}

func diskReclaimPath() string {
	if path := os.Getenv("WEZDECK_DISK_RECLAIM_STATUS_PATH"); path != "" {
		return path
	}
	return filepath.Join(filepath.Dir(filepath.Dir(attentionFile())), "disk-reclaim", "status.json")
}

func readDiskReclaim() diskReclaimState {
	var state diskReclaimState
	raw, err := os.ReadFile(diskReclaimPath())
	if err == nil {
		_ = json.Unmarshal(raw, &state)
	}
	return state
}

func diskReclaimStatus(device string) map[string]any {
	state := readDiskReclaim()
	if state.TaskID == "" || state.TargetDevice != device {
		return map[string]any{"v": 1, "ok": true, "phase": "none"}
	}
	return map[string]any{"v": 1, "ok": true, "task": state}
}

func writeDiskReclaimState(state diskReclaimState) error {
	path := diskReclaimPath()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	body, err := json.Marshal(state)
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp.%d", path, os.Getpid())
	if err := os.WriteFile(tmp, body, 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func startDiskReclaim(args json.RawMessage, via, device string) (any, error) {
	var request struct {
		Confirm      bool   `json:"confirm"`
		TargetDevice string `json:"target_device"`
	}
	if json.Unmarshal(args, &request) != nil || !request.Confirm {
		return nil, errors.New("disk reclaim requires explicit confirmation")
	}
	if device == "" {
		return nil, errors.New("approved device required")
	}
	if via == "local" && sessionIDPattern.MatchString(request.TargetDevice) {
		device = request.TargetDevice
	}
	lock, err := os.OpenFile(filepath.Join(os.TempDir(), "wezdeck-disk-reclaim.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil, errors.New("another disk reclaim launch is in progress")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	current := readDiskReclaim()
	switch current.Phase {
	case "queued", "preparing", "preflight", "trimming", "compacting", "restarting", "verifying":
		return nil, errors.New("disk reclaim already in progress")
	}
	id := newDiagID()
	now := time.Now().Format(time.RFC3339)
	state := diskReclaimState{TaskID: id, TargetDevice: device, Phase: "queued", StartedAt: now, UpdatedAt: now}
	if err := writeDiskReclaimState(state); err != nil {
		return nil, err
	}
	cmdPath := os.Getenv("WEZDECK_DISK_RECLAIM_CMD")
	if cmdPath == "" {
		cmdPath = filepath.Join(repoRoot(), "scripts", "dev", "wsl-reclaim-restart.sh")
	}
	if _, err := os.Stat(cmdPath); err != nil {
		state.Phase, state.Error = "failed", err.Error()
		_ = writeDiskReclaimState(state)
		return nil, err
	}
	cmd := exec.Command("bash", cmdPath, "--noninteractive", "--force-stop", "--task-id", id, "--target-device", device)
	logPath := filepath.Join(filepath.Dir(diskReclaimPath()), "launch.log")
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		state.Phase, state.Error = "failed", err.Error()
		_ = writeDiskReclaimState(state)
		return nil, err
	}
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Start(); err != nil {
		_ = log.Close()
		state.Phase, state.Error = "failed", err.Error()
		_ = writeDiskReclaimState(state)
		return nil, err
	}
	go func() {
		err := cmd.Wait()
		_ = log.Close()
		if err != nil {
			if current := readDiskReclaim(); current.TaskID == id && current.Phase == "queued" {
				state.Phase, state.Error = "failed", err.Error()
				_ = writeDiskReclaimState(state)
			}
			relayLogf("disk_reclaim", "task=%s device=%s outcome=launch_failed err=%q", id, device, err)
			return
		}
		relayLogf("disk_reclaim", "task=%s device=%s outcome=worker_queued", id, device)
	}()
	relayLogf("disk_reclaim", "task=%s device=%s outcome=accepted", id, device)
	return map[string]any{"v": 1, "ok": true, "task_id": id, "phase": "queued"}, nil
}

func diskReclaimProgressFrame(state diskReclaimState) relayFrame {
	view := map[string]any{"task_id": state.TaskID, "phase": state.Phase,
		"updated_at": state.UpdatedAt, "reclaimed_bytes": state.ReclaimedBytes,
		"vhdx_reduced_bytes": state.VhdxReducedBytes, "compact_elapsed_seconds": state.CompactElapsedSeconds,
		"after_vhdx_bytes": state.AfterVhdxBytes, "after_free_bytes": state.AfterFreeBytes,
		"failed_stage": state.FailedStage,
		"error":        strings.TrimSpace(clip(state.Error, 160)), "history": state.History}
	body, _ := json.Marshal(view)
	return relayFrame{T: "disk.reclaim.progress", Data: body}
}

func (r *relay) sendDiskReclaimToClient(cid, device string) {
	state := readDiskReclaim()
	if state.TaskID == "" || device == "" || state.TargetDevice != device {
		return
	}
	frame := diskReclaimProgressFrame(state)
	frame.Cid = cid
	r.send(frame)
	r.logf("disk_reclaim_progress", "task=%s device=%s phase=%s", state.TaskID, device, state.Phase)
}

func (r *relay) runDiskReclaimWatcher(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	last := ""
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		state := readDiskReclaim()
		if state.TaskID == "" || state.TargetDevice == "" {
			continue
		}
		stamp := state.TaskID + "/" + state.UpdatedAt + "/" + state.Phase
		if stamp == last {
			continue
		}
		last = stamp
		for _, cid := range r.recentClients() {
			if r.deviceOf(cid) == state.TargetDevice {
				r.sendDiskReclaimToClient(cid, state.TargetDevice)
			}
		}
	}
}
