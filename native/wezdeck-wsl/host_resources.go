package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

type hostVolume struct {
	Mount      string `json:"mount"`
	Level      string `json:"level"`
	AvailBytes int64  `json:"avail_bytes"`
	SizeBytes  int64  `json:"size_bytes"`
}

type hostResourceStatus struct {
	SampledAt int64      `json:"sampled_at"`
	System    hostVolume `json:"system"`
	WSL       hostVolume `json:"wsl"`
	VHDXBytes int64      `json:"vhdx_bytes"`
	GuestUsed int64      `json:"guest_used_bytes"`
	GapBytes  int64      `json:"gap_bytes"`
	Memory    struct {
		SampledAt int64   `json:"sampled_at"`
		Level     string  `json:"level"`
		UsedPct   float64 `json:"used_pct"`
		TotalMiB  int64   `json:"total_mib"`
		SwapPct   float64 `json:"swap_used_pct"`
		Load1     float64 `json:"loadavg_1"`
		Load5     float64 `json:"loadavg_5"`
		CPUs      int     `json:"cpus"`
	} `json:"memory"`
}

func resourceStateRoot() string {
	if root := os.Getenv("WEZDECK_HOST_RESOURCE_STATE_DIR"); root != "" {
		return root
	}
	return filepath.Dir(filepath.Dir(attentionFile()))
}

func readHostResources() hostResourceStatus {
	var result hostResourceStatus
	result.Memory.CPUs = runtime.NumCPU()
	root := resourceStateRoot()
	var disk struct {
		Heartbeat int64  `json:"heartbeat_at_ms"`
		Level     string `json:"level"`
		Mount     string `json:"host_mount"`
		Avail     int64  `json:"host_avail_bytes"`
		Size      int64  `json:"host_size_bytes"`
		VHDX      int64  `json:"vhdx_bytes"`
		Guest     int64  `json:"guest_used_bytes"`
		Gap       int64  `json:"gap_bytes"`
		System    struct {
			Mount string `json:"host_mount"`
			Level string `json:"level"`
			Avail int64  `json:"host_avail_bytes"`
			Size  int64  `json:"host_size_bytes"`
		} `json:"system"`
	}
	if raw, err := os.ReadFile(filepath.Join(root, "disk-guard", "status.json")); err == nil && json.Unmarshal(raw, &disk) == nil {
		result.SampledAt = disk.Heartbeat
		result.WSL = hostVolume{disk.Mount, disk.Level, disk.Avail, disk.Size}
		result.System = hostVolume{disk.System.Mount, disk.System.Level, disk.System.Avail, disk.System.Size}
		result.VHDXBytes, result.GuestUsed, result.GapBytes = disk.VHDX, disk.Guest, disk.Gap
	}
	var oom struct {
		Heartbeat int64   `json:"heartbeat_at_ms"`
		Level     string  `json:"level"`
		Used      float64 `json:"mem_used_pct"`
		Total     int64   `json:"mem_total_mib"`
		Swap      float64 `json:"swap_used_pct"`
		Load1     float64 `json:"loadavg_1"`
		Load5     float64 `json:"loadavg_5"`
	}
	if raw, err := os.ReadFile(filepath.Join(root, "oom-guard", "status.json")); err == nil && json.Unmarshal(raw, &oom) == nil {
		result.Memory.SampledAt = oom.Heartbeat
		result.Memory.Level, result.Memory.UsedPct, result.Memory.TotalMiB = oom.Level, oom.Used, oom.Total
		result.Memory.SwapPct, result.Memory.Load1, result.Memory.Load5 = oom.Swap, oom.Load1, oom.Load5
	}
	return result
}

type diskCandidate struct {
	Label  string `json:"label"`
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	Kind   string `json:"kind"`
	Count  int    `json:"count,omitempty"`
	Volume string `json:"volume"`
}

func diskCandidates() map[string]any {
	home, _ := os.UserHomeDir()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	candidates := []diskCandidate{}
	partial := false
	add := func(path, label, kind, volume string) {
		if ctx.Err() != nil {
			return
		}
		if _, err := os.Stat(path); err != nil {
			return
		}
		probe, stop := context.WithTimeout(ctx, 1500*time.Millisecond)
		out, err := exec.CommandContext(probe, "du", "-sx", "-B1", path).Output()
		stop()
		if err != nil {
			if probe.Err() != nil {
				partial = true
			}
			return
		}
		fields := strings.Fields(string(out))
		if len(fields) == 0 {
			return
		}
		bytes, err := strconv.ParseInt(fields[0], 10, 64)
		if err == nil && bytes > 0 {
			candidates = append(candidates, diskCandidate{Label: label, Path: path, Bytes: bytes, Kind: kind, Volume: volume})
		}
	}
	for _, item := range []struct{ path, label, kind string }{
		{filepath.Join(home, ".cache/go-build"), "Go build cache", "cache"},
		{filepath.Join(home, ".npm/_cacache"), "npm cache", "cache"},
		{filepath.Join(home, ".cache/pnpm"), "pnpm metadata cache", "cache"},
	} {
		add(item.path, item.label, item.kind, "wsl")
	}
	depsRoot := filepath.Join(home, "github/.worktrees/wezterm-config")
	if dirs, err := os.ReadDir(depsRoot); err == nil {
		paths := []string{}
		for _, dir := range dirs {
			if !dir.IsDir() {
				continue
			}
			path := filepath.Join(depsRoot, dir.Name(), "web/node_modules")
			if info, err := os.Lstat(path); err == nil && info.IsDir() {
				paths = append(paths, path)
			}
		}
		if len(paths) > 0 {
			probe, stop := context.WithTimeout(ctx, 6*time.Second)
			out, err := exec.CommandContext(probe, "du", append([]string{"-scx", "-B1"}, paths...)...).Output()
			dep := diskCandidate{Label: "Web dependencies", Path: depsRoot, Kind: "dependencies", Count: len(paths), Volume: "wsl"}
			if probe.Err() != nil {
				partial = true
			}
			stop()
			if err == nil {
				lines := strings.Split(strings.TrimSpace(string(out)), "\n")
				fields := strings.Fields(lines[len(lines)-1])
				if len(fields) > 0 {
					if bytes, err := strconv.ParseInt(fields[0], 10, 64); err == nil {
						dep.Bytes = bytes
					}
				}
			}
			candidates = append(candidates, dep)
		}
	}
	if root := resourceStateRoot(); strings.HasPrefix(root, "/mnt/c/Users/") {
		userHome := filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(root))))
		add(filepath.Join(userHome, "AppData/Local/Google/Chrome/User Data/Default/Service Worker/CacheStorage"), "Chrome Service Worker cache", "cache", "system")
	}
	for _, root := range []string{filepath.Join(home, "work"), filepath.Join(home, "github")} {
		if ctx.Err() != nil {
			break
		}
		// Workstations are the main source of independent build output.
		families, _ := os.ReadDir(filepath.Join(root, ".worktrees"))
		for _, family := range families {
			if !family.IsDir() || ctx.Err() != nil || len(candidates) >= 24 {
				continue
			}
			worktrees, _ := os.ReadDir(filepath.Join(root, ".worktrees", family.Name()))
			for _, tree := range worktrees {
				if !tree.IsDir() || ctx.Err() != nil || len(candidates) >= 24 {
					continue
				}
				for _, name := range []string{".next", ".turbo"} {
					add(filepath.Join(root, ".worktrees", family.Name(), tree.Name(), name), family.Name()+"/"+tree.Name()+"/"+name, "build", "wsl")
				}
			}
		}
		// A bounded project-level walk avoids dependency-internal build dirs.
		projects, _ := os.ReadDir(root)
		for _, project := range projects {
			if !project.IsDir() || strings.HasPrefix(project.Name(), ".") {
				continue
			}
			for _, name := range []string{".next", ".turbo"} {
				if len(candidates) >= 24 || ctx.Err() != nil {
					break
				}
				add(filepath.Join(root, project.Name(), name), project.Name()+"/"+name, "build", "wsl")
			}
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].Bytes > candidates[j].Bytes })
	if len(candidates) > 8 {
		candidates = candidates[:8]
	}
	return map[string]any{"v": 1, "ok": true, "items": candidates, "partial": partial || ctx.Err() != nil}
}
