package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"syscall"
	"time"
)

const warpCLI = "/mnt/c/Program Files/Cloudflare/Cloudflare WARP/warp-cli.exe"

type warpState struct {
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

func warpCommand(ctx context.Context, action string) (string, error) {
	cmd := exec.CommandContext(ctx, warpCLI, action)
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return "", errors.New("One Client did not respond in time")
	}
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", errors.New("One Client is unavailable on this host")
		}
		return "", fmt.Errorf("One Client %s failed: %s", action, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func parseWarpStatus(out string) warpState {
	state := warpState{State: "unknown"}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if value, ok := strings.CutPrefix(line, "Status update: "); ok {
			switch strings.ToLower(value) {
			case "connected", "disconnected", "connecting", "disconnecting":
				state.State = strings.ToLower(value)
			}
		}
		if value, ok := strings.CutPrefix(line, "Reason: "); ok {
			state.Reason = value
		}
	}
	return state
}

func readWarp(ctx context.Context) (warpState, error) {
	out, err := warpCommand(ctx, "status")
	return parseWarpStatus(out), err
}

func warpStatus() (warpState, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return readWarp(ctx)
}

func setWarp(args json.RawMessage) (warpState, error) {
	var input struct {
		Connected *bool `json:"connected"`
	}
	if json.Unmarshal(args, &input) != nil || input.Connected == nil {
		return warpState{}, errors.New("connected must be a boolean")
	}
	config, err := os.UserConfigDir()
	if err != nil {
		return warpState{}, err
	}
	dir := filepath.Join(config, "wezdeck")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return warpState{}, err
	}
	lock, err := os.OpenFile(filepath.Join(dir, "warp-change.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return warpState{}, err
	}
	defer lock.Close()
	// The loopback bridge and remote relay run in separate processes.
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return warpState{}, errors.New("One Client is already changing state")
		}
		return warpState{}, err
	}

	want, command := "disconnected", "disconnect"
	if *input.Connected {
		want, command = "connected", "connect"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	status, err := readWarp(ctx)
	if err != nil || status.State == want {
		return status, err
	}
	if _, err = warpCommand(ctx, command); err != nil {
		return status, err
	}

	tick := time.NewTicker(400 * time.Millisecond)
	defer tick.Stop()
	for {
		status, err = readWarp(ctx)
		if err != nil || status.State == want {
			return status, err
		}
		select {
		case <-ctx.Done():
			return status, errors.New("One Client has not confirmed the requested state yet")
		case <-tick.C:
		}
	}
}

type oppoControlStatus struct {
	Active     *bool  `json:"active"`
	LastResult string `json:"last_result,omitempty"`
	LastAt     string `json:"last_at,omitempty"`
	ErrorCode  string `json:"error_code,omitempty"`
}

var oppoLinkResult = regexp.MustCompile(`(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.\d+ .*\[\[link\.telemetry\]\] link_result: success=(true|false), errorCode=(\d+|undefined|\w+),`)

func oppoStatus() oppoControlStatus {
	var result oppoControlStatus
	runtimeState := filepath.Dir(filepath.Dir(attentionFile()))
	sample, err := os.ReadFile(filepath.Join(runtimeState, "oppo-remote", "status.json"))
	var badge struct {
		Heartbeat int64 `json:"heartbeat_at_ms"`
		Active    *bool `json:"active"`
	}
	if err == nil && json.Unmarshal(sample, &badge) == nil {
		age := time.Since(time.UnixMilli(badge.Heartbeat))
		if age >= 0 && age <= 20*time.Second {
			result.Active = badge.Active
		}
	}

	// Derive the Windows profile from the same runtime state root as attention.
	// Only return timestamp, outcome and a numeric vendor error code.
	profile := filepath.Join(runtimeState, "..", "..", "..")
	logDir := filepath.Join(profile, "Roaming", "O+Connect", "devicespace")
	logs, _ := filepath.Glob(filepath.Join(logDir, "????-??-??_main.log"))
	slices.Reverse(logs)
	for _, path := range logs {
		if match := latestOppoResult(path); match != nil {
			result.LastAt, result.LastResult = match[1], "failed"
			if match[2] == "true" {
				result.LastResult = "connected"
			} else if strings.Trim(match[3], "0123456789") == "" {
				result.ErrorCode = match[3]
			}
			break
		}
	}
	return result
}

func latestOppoResult(path string) []string {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil
	}
	const limit = 4 << 20
	if _, err = file.Seek(max(0, info.Size()-limit), io.SeekStart); err != nil {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(file, limit))
	if err != nil {
		return nil
	}
	matches := oppoLinkResult.FindAllStringSubmatch(string(data), -1)
	if len(matches) == 0 {
		return nil
	}
	return matches[len(matches)-1]
}
