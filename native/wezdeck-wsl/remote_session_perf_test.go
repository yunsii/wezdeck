package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAttentionFileCacheAvoidsRepeatedGlob(t *testing.T) {
	t.Setenv("WEZDECK_ATTENTION_FILE", "")
	attentionPathMu.Lock()
	origCached, origChecked, origGlob := attentionPathCached, attentionPathChecked, attentionGlobFunc
	attentionPathCached = ""
	attentionPathChecked = time.Time{}
	calls := 0
	attentionGlobFunc = func(pattern string) ([]string, error) {
		calls++
		return []string{"/mnt/c/Users/test/AppData/Local/wezterm-runtime/state/agent-attention/attention.json"}, nil
	}
	attentionPathMu.Unlock()
	defer func() {
		attentionPathMu.Lock()
		attentionPathCached = origCached
		attentionPathChecked = origChecked
		attentionGlobFunc = origGlob
		attentionPathMu.Unlock()
	}()

	for i := 0; i < 50; i++ {
		got := attentionFile()
		if !strings.HasSuffix(got, "/attention.json") {
			t.Fatalf("unexpected attentionFile: %q", got)
		}
	}
	if calls != 1 {
		t.Fatalf("expected resolveDefaultAttentionFile to glob once within TTL, got %d calls", calls)
	}
}

func TestHandleRPCAttachesHostMSAndLogsSlowRPC(t *testing.T) {
	dir := t.TempDir()
	att := filepath.Join(dir, "attention.json")
	if err := os.WriteFile(att, []byte(`{"entries":{},"recent":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEZDECK_ATTENTION_FILE", att)
	t.Setenv("WEZDECK_RELAY_OPEN_READS", "1")
	t.Setenv("WEZDECK_RELAY_SLOW_RPC_MS", "0")

	logPath := filepath.Join(dir, "relay.log")
	f, err := openRelayLog(logPath)
	if err != nil {
		t.Fatal(err)
	}
	r := &relay{log: f}
	res := handleRPC(relayFrame{T: "rpc", ID: "r1", Cid: "c1", Action: "sessions"}, "websocket", r)
	_ = f.Close()

	if res.OK == nil || !*res.OK {
		t.Fatalf("expected ok response, got %+v", res)
	}
	if res.HostMS == nil || *res.HostMS < 0 {
		t.Fatalf("expected non-negative host_ms on response frame, got %+v", res.HostMS)
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if !strings.Contains(text, `event=rpc via=websocket action="sessions"`) {
		t.Fatalf("missing rpc log row:\n%s", text)
	}
	if strings.Contains(text, `event=rpc_slow`) {
		t.Fatalf("WEZDECK_RELAY_SLOW_RPC_MS=0 should disable slow logging, got:\n%s", text)
	}

	// Re-run with threshold 1ms and verify slow row formatting works when triggered.
	t.Setenv("WEZDECK_RELAY_SLOW_RPC_MS", "1")
	f2, err := openRelayLog(logPath)
	if err != nil {
		t.Fatal(err)
	}
	r2 := &relay{log: f2}
	var timing rpcTiming
	timing.add("read_ms", 2*time.Millisecond)
	timing.add("live_ms", 5*time.Millisecond)
	if got := timing.suffix(); got != " read_ms=2 live_ms=5" {
		t.Fatalf("unexpected timing suffix: %q", got)
	}
	_ = handleRPC(relayFrame{T: "rpc", ID: "r2", Cid: "c1", Action: "sessions"}, "websocket", r2)
	_ = f2.Close()
}

func TestServeDispatchLogsBridgeTiming(t *testing.T) {
	dir := t.TempDir()
	att := filepath.Join(dir, "attention.json")
	if err := os.WriteFile(att, []byte(`{"entries":{},"recent":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEZDECK_ATTENTION_FILE", att)
	t.Setenv("WEZDECK_RELAY_LOG_DIR", dir)
	t.Setenv("WEZDECK_BRIDGE_SLOW_RPC_MS", "0")

	res := dispatch(request{Version: 2, Domain: "remote", Action: "sessions", Payload: json.RawMessage(`{}`)})
	if !res.OK {
		t.Fatalf("expected bridge sessions ok, got %+v", res)
	}
	// Quiet heartbeat stays silent on fast path.
	hb := dispatch(request{Version: 2, Domain: "bridge", Action: "status"})
	if !hb.OK {
		t.Fatalf("expected bridge.status ok, got %+v", hb)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "relay.log"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if !strings.Contains(text, `event=bridge_rpc via=local action="remote.sessions" ok=true`) {
		t.Fatalf("missing bridge_rpc row:\n%s", text)
	}
	if strings.Contains(text, `action="bridge.status"`) {
		t.Fatalf("fast bridge.status heartbeat should stay quiet:\n%s", text)
	}
}

func BenchmarkLiveSessionsFrom(b *testing.B) {
	dir := b.TempDir()
	att := filepath.Join(dir, "attention.json")
	b.Setenv("WEZDECK_ATTENTION_FILE", att)
	if err := markSessionClosed("closed-0"); err != nil {
		b.Fatal(err)
	}
	entries := map[string]attentionEntry{
		"live-1": {SessionID: "live-1", TmuxSocket: "/nonexistent-tmux-sock", TmuxPane: "%1", Status: "running"},
	}
	recent := make([]recentEntry, 0, 50)
	for i := 0; i < 50; i++ {
		recent = append(recent, recentEntry{
			attentionEntry: attentionEntry{
				SessionID:  fmt.Sprintf("arch-%d", i),
				TmuxSocket: "/nonexistent-tmux-sock",
				TmuxPane:   fmt.Sprintf("%%%d", i+2),
			},
			ArchivedTS: int64(1_700_000_000_000 + i),
		})
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = liveSessionsFrom(entries, recent)
	}
}

func TestTranscriptLocateCacheValidatesAndInvalidates(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	id := "cache-test-session-1"
	dir := filepath.Join(home, ".claude", "projects", "proj-a")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, id+".jsonl")
	if err := os.WriteFile(file, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	gotPath, gotAgent := findTranscript(id)
	if gotPath != file || gotAgent != "claude" {
		t.Fatalf("first lookup: want (%q, claude), got (%q, %q)", file, gotPath, gotAgent)
	}
	if p, ag, ok := lookupTranscriptCached(home, id); !ok || p != file || ag != "claude" {
		t.Fatalf("expected warm transcript cache hit, got (%q, %q, %v)", p, ag, ok)
	}

	// Removing the file invalidates the cache on the very next lookup.
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if p, ag := findTranscript(id); p != "" || ag != "" {
		t.Fatalf("removed file must invalidate cache, got (%q, %q)", p, ag)
	}
	// pending-* placeholders always short-circuit cleanly.
	if p, ag := findTranscript("pending-1234"); p != "" || ag != "" {
		t.Fatalf("pending id must short-circuit, got (%q, %q)", p, ag)
	}
}

func TestDropEmptyHandoffSplashesSkipsTranscriptIOWhenNoHandoff(t *testing.T) {
	cards := []sessionCard{
		{ID: "s-1", Worktree: "/wt-a", Status: "idle"},
		{ID: "s-2", Worktree: "/wt-b", Status: "running"},
	}
	// No cleared_to targets among listed cards -> must return original slice unchanged.
	got := dropEmptyHandoffSplashes(cards, nil)
	if len(got) != 2 || got[0].ID != "s-1" || got[1].ID != "s-2" {
		t.Fatalf("unexpected cards: %+v", got)
	}
}
