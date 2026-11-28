package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReadHostResourcesUsesExistingGuardSnapshots(t *testing.T) {
	root := t.TempDir()
	t.Setenv("WEZDECK_HOST_RESOURCE_STATE_DIR", root)
	for name, body := range map[string]string{
		"disk-guard/status.json": `{"heartbeat_at_ms":123,"level":"warn","host_mount":"/mnt/d","host_avail_bytes":20,"host_size_bytes":100,"vhdx_bytes":60,"guest_used_bytes":40,"gap_bytes":20,"system":{"host_mount":"/mnt/c","level":"ok","host_avail_bytes":50,"host_size_bytes":100}}`,
		"oom-guard/status.json":  `{"heartbeat_at_ms":456,"level":"ok","mem_used_pct":42,"mem_total_mib":1024,"swap_used_pct":2,"loadavg_1":1.5,"loadavg_5":2.5}`,
	} {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	got := readHostResources()
	if got.SampledAt != 123 || got.WSL.Mount != "/mnt/d" || got.System.AvailBytes != 50 || got.GapBytes != 20 {
		t.Fatalf("disk fields: %+v", got)
	}
	if got.Memory.SampledAt != 456 || got.Memory.UsedPct != 42 || got.Memory.Load1 != 1.5 || got.Memory.CPUs < 1 {
		t.Fatalf("memory fields: %+v", got.Memory)
	}
}

func TestDiskCandidatesStayWithinKnownLocations(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("WEZDECK_HOST_RESOURCE_STATE_DIR", t.TempDir())
	cache := filepath.Join(home, ".cache/go-build")
	if err := os.MkdirAll(cache, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, "object"), make([]byte, 4096), 0600); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	got := diskCandidates()
	if time.Since(start) > 8*time.Second {
		t.Fatal("candidate scan exceeded its budget")
	}
	items := got["items"].([]diskCandidate)
	if len(items) != 1 || items[0].Path != cache || items[0].Bytes < 4096 || items[0].Volume != "wsl" {
		t.Fatalf("unexpected candidates: %+v", items)
	}
}

func TestDiskCandidatesDeduplicateWorktreeDependencies(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("WEZDECK_HOST_RESOURCE_STATE_DIR", t.TempDir())
	root := filepath.Join(home, "github/.worktrees/wezterm-config")
	for _, name := range []string{"one", "two"} {
		path := filepath.Join(root, name, "web/node_modules")
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "object"), make([]byte, 4096), 0600); err != nil {
			t.Fatal(err)
		}
	}
	items := diskCandidates()["items"].([]diskCandidate)
	if len(items) != 1 || items[0].Kind != "dependencies" || items[0].Path != root || items[0].Bytes < 8192 || items[0].Count != 2 {
		t.Fatalf("dependency inventory: %+v", items)
	}
}
