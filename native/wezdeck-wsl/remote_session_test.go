package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseClaudeTranscriptKeepsPromptsTextAndToolLines(t *testing.T) {
	lines := []string{
		`{"type":"user","message":{"role":"user","content":"帮我看看手机端"}}`,
		`{"type":"user","isMeta":true,"message":{"role":"user","content":"meta"}}`,
		`{"type":"user","message":{"role":"user","content":"<command-name>/goal</command-name>"}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好的"},{"type":"tool_use","name":"Bash","input":{"command":"ls web"}}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"x"}]}}`,
		`not json`,
	}
	got := parseClaudeTranscript([]byte(strings.Join(lines, "\n")), 10)
	want := []chatMessage{{Role: "user", Text: "帮我看看手机端"}, {Role: "assistant", Text: "好的"}, {Role: "tool", Text: "Bash ls web"}}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i].Role != want[i].Role || got[i].Text != want[i].Text {
			t.Fatalf("message %d: got %+v want %+v", i, got[i], want[i])
		}
	}
}

func newDevice(t *testing.T) (*ecdsa.PrivateKey, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	raw := elliptic.Marshal(elliptic.P256(), key.X, key.Y) //nolint:staticcheck // uncompressed point, same as WebCrypto "raw"
	return key, base64.RawURLEncoding.EncodeToString(raw)
}

func signFrame(t *testing.T, key *ecdsa.PrivateKey, device string, w signedWrite) json.RawMessage {
	t.Helper()
	payload, _ := json.Marshal(w)
	digest := sha256.Sum256(payload)
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	body, _ := json.Marshal(map[string]string{"device": device, "payload": string(payload), "sig": base64.RawURLEncoding.EncodeToString(sig)})
	return body
}

func TestVerifyWriteAcceptsOnlyApprovedFreshSignedRequests(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEZDECK_REMOTE_DEVICES", filepath.Join(dir, "devices.json"))
	key, pub := newDevice(t)
	res, err := registerDevice(json.RawMessage(`{"public_key":"` + pub + `","name":"phone"}`))
	if err != nil || res.(map[string]any)["state"] != "pending" {
		t.Fatalf("register: %v %v", res, err)
	}
	id := res.(map[string]any)["id"].(string)
	w := signedWrite{Action: "send", Args: json.RawMessage(`{"id":"s","text":"hi"}`), TS: time.Now().UnixMilli(), Nonce: "n1"}
	if _, _, err := verifyWrite("send", signFrame(t, key, id, w)); err == nil || !strings.Contains(err.Error(), "not approved") {
		t.Fatalf("pending device must be refused, got %v", err)
	}
	s := loadDevices()
	s.Approved, s.Pending = s.Pending, nil
	if err := saveDevices(s); err != nil {
		t.Fatal(err)
	}
	got, device, err := verifyWrite("send", signFrame(t, key, id, w))
	if err != nil || device != id || string(got.Args) != `{"id":"s","text":"hi"}` {
		t.Fatalf("valid write refused: %v", err)
	}
	if _, _, err := verifyWrite("send", signFrame(t, key, id, w)); err == nil || !strings.Contains(err.Error(), "replayed") {
		t.Fatalf("replay must be refused, got %v", err)
	}
	if _, _, err := verifyWrite("key", signFrame(t, key, id, signedWrite{Action: "send", TS: time.Now().UnixMilli(), Nonce: "n2"})); err == nil {
		t.Fatal("action mismatch must be refused")
	}
	old := signedWrite{Action: "send", TS: time.Now().Add(-10 * time.Minute).UnixMilli(), Nonce: "n3"}
	if _, _, err := verifyWrite("send", signFrame(t, key, id, old)); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("stale write must be refused, got %v", err)
	}
	other, _ := newDevice(t)
	if _, _, err := verifyWrite("send", signFrame(t, other, id, signedWrite{Action: "send", TS: time.Now().UnixMilli(), Nonce: "n4"})); err == nil || !strings.Contains(err.Error(), "verify") {
		t.Fatalf("foreign key must be refused, got %v", err)
	}
	if _, _, err := verifyWrite("send", json.RawMessage(`{}`)); err == nil {
		t.Fatal("unsigned write must be refused")
	}
}

// Real tmux: a detached session running `cat` stands in for an agent TUI.
func TestSendPastesIntoTheSessionPaneUnderGuards(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	dir := t.TempDir()
	socket := filepath.Join(dir, "tmux.sock")
	if out, err := exec.Command("tmux", "-S", socket, "new-session", "-d", "-s", "t", "-x", "120", "-y", "20", "cat").CombinedOutput(); err != nil {
		t.Fatalf("tmux: %s", out)
	}
	defer exec.Command("tmux", "-S", socket, "kill-server").Run()
	pane, _ := exec.Command("tmux", "-S", socket, "display-message", "-p", "-t", "t", "#{pane_id}").Output()
	write := func(status, kind string, extra ...map[string]any) {
		entry := map[string]any{
			"session_id": "sess-1", "tmux_socket": socket, "tmux_session": "t", "tmux_pane": strings.TrimSpace(string(pane)),
			"status": status, "waiting_kind": kind, "agent_name": "demo"}
		for _, m := range extra {
			for k, v := range m {
				entry[k] = v
			}
		}
		doc := map[string]any{"entries": map[string]any{"sess-1": entry}}
		data, _ := json.Marshal(doc)
		if err := os.WriteFile(filepath.Join(dir, "attention.json"), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("WEZDECK_ATTENTION_FILE", filepath.Join(dir, "attention.json"))

	write("running", "") // not a Claude session (no transcript): must wait
	if _, err := sendToSession(json.RawMessage(`{"id":"sess-1","text":"hello"}`)); err == nil || !strings.Contains(err.Error(), "still working") {
		t.Fatalf("running agent must not receive input, got %v", err)
	}
	write("waiting", "permission_prompt")
	if _, err := sendToSession(json.RawMessage(`{"id":"sess-1","text":"hello"}`)); err == nil || !strings.Contains(err.Error(), "confirmation") {
		t.Fatalf("permission prompt must block free text, got %v", err)
	}
	// turn over, only a background shell left: input is allowed
	write("running", "", map[string]any{"running_kind": "background",
		"bg": map[string]any{"tasks": []map[string]any{{"id": "b1", "type": "shell", "summary": "npm run dev"}}}})
	list, err := listSessions()
	if err != nil {
		t.Fatal(err)
	}
	card := list.(map[string]any)["sessions"].([]sessionCard)[0]
	if card.RunningKind != "background" || len(card.Background) != 1 || card.Background[0].Summary != "npm run dev" {
		t.Fatalf("background not reported: %+v", card)
	}
	if _, err := sendToSession(json.RawMessage(`{"id":"sess-1","text":"while bg runs"}`)); err != nil {
		t.Fatalf("background-only session must take input: %v", err)
	}
	write("done", "")
	list, err = listSessions()
	if err != nil || len(list.(map[string]any)["sessions"].([]sessionCard)) != 1 {
		t.Fatalf("list: %v %v", list, err)
	}
	if _, err := sendToSession(json.RawMessage(`{"id":"sess-1","text":"hello from phone"}`)); err != nil {
		t.Fatalf("send: %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		screen, _ := exec.Command("tmux", "-S", socket, "capture-pane", "-p", "-t", "t").Output()
		if strings.Count(string(screen), "hello from phone") >= 2 { // echoed by the tty, then by cat
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("text never reached the pane:\n%s", screen)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if _, err := keyToSession(json.RawMessage(`{"id":"sess-1","key":"C-c"}`)); err == nil {
		t.Fatal("keys outside the allowlist must be refused")
	}
	if _, err := keyToSession(json.RawMessage(`{"id":"sess-1","key":"Escape"}`)); err != nil {
		t.Fatalf("allowed key: %v", err)
	}
}

func TestClaudeSessionTakesInputMidTurn(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	if err := os.MkdirAll(filepath.Join(home, ".claude", "projects", "p"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(home, ".claude", "projects", "p", "claude-1.jsonl"), []byte("{}\n"), 0o600)
	t.Setenv("HOME", home)
	socket := filepath.Join(dir, "s")
	if out, err := exec.Command("tmux", "-S", socket, "new-session", "-d", "-s", "c", "cat").CombinedOutput(); err != nil {
		t.Fatalf("tmux: %s", out)
	}
	defer exec.Command("tmux", "-S", socket, "kill-server").Run()
	pane, _ := exec.Command("tmux", "-S", socket, "display-message", "-p", "-t", "c", "#{pane_id}").Output()
	doc, _ := json.Marshal(map[string]any{"entries": map[string]any{"claude-1": map[string]any{
		"session_id": "claude-1", "tmux_socket": socket, "tmux_session": "c",
		"tmux_pane": strings.TrimSpace(string(pane)), "status": "running"}}})
	_ = os.WriteFile(filepath.Join(dir, "attention.json"), doc, 0o600)
	t.Setenv("WEZDECK_ATTENTION_FILE", filepath.Join(dir, "attention.json"))
	if _, err := sendToSession(json.RawMessage(`{"id":"claude-1","text":"queued while busy"}`)); err != nil {
		t.Fatalf("Claude must accept input mid-turn: %v", err)
	}
}
