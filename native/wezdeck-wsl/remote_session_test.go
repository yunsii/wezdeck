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

func TestClaudeMidTurnMessagesShowAsUserLines(t *testing.T) {
	lines := []string{
		`{"type":"user","message":{"role":"user","content":"先做这个"}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"在做"}]}}`,
		// typed / sent from the phone while Claude was mid-turn
		`{"type":"attachment","attachment":{"type":"queued_command","prompt":"顺便改一下这个","commandMode":"prompt","origin":{"kind":"human"},"humanTurn":true}}`,
		// harness traffic stays out
		`{"type":"attachment","attachment":{"type":"queued_command","prompt":"<task-notification>x</task-notification>","commandMode":"task-notification","origin":{"kind":"task-notification"}}}`,
		`{"type":"attachment","attachment":{"type":"queued_command","prompt":"<agent-message>done</agent-message>","commandMode":"prompt","origin":{"kind":"peer"}}}`,
		`{"type":"attachment","attachment":{"type":"queued_command","prompt":"Goal set: x","commandMode":"prompt","origin":{"kind":"auto-continuation"}}}`,
		`{"type":"attachment","attachment":{"type":"queued_command","prompt":"<bash-input>ls</bash-input>","commandMode":"prompt"}}`,
		`{"type":"attachment","attachment":{"type":"queued_command","prompt":"旧版本没有 origin","commandMode":"prompt"}}`,
	}
	got := parseClaudeTranscript([]byte(strings.Join(lines, "\n")), 20)
	var users []string
	for _, m := range got {
		if m.Role == "user" {
			users = append(users, m.Text)
		}
	}
	if strings.Join(users, "|") != "先做这个|顺便改一下这个|旧版本没有 origin" {
		t.Fatalf("user lines: %q", users)
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

	write("running", "") // any agent takes input mid-turn (queued / steered by its TUI)
	if _, err := sendToSession(json.RawMessage(`{"id":"sess-1","text":"mid-turn"}`)); err != nil {
		t.Fatalf("running agent must take input, got %v", err)
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
	if _, err := keyToSession(json.RawMessage(`{"id":"sess-1","key":"C-z"}`)); err == nil {
		t.Fatal("keys outside the allowlist must be refused")
	}
	if _, err := keyToSession(json.RawMessage(`{"id":"sess-1","key":"Escape"}`)); err != nil {
		t.Fatalf("allowed key: %v", err)
	}
	if _, err := keyToSession(json.RawMessage(`{"id":"sess-1","key":"C-c"}`)); err != nil {
		t.Fatalf("interrupt key: %v", err)
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

// An acknowledged session leaves .entries for recent[] but is still open:
// it must stay listed (idle, sendable) while its pane runs an agent, and a
// tombstone whose pane went back to a shell must not.
func TestArchivedSessionStaysListedWhilePaneRunsAnAgent(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	_ = os.MkdirAll(bin, 0o755)
	cat, _ := exec.LookPath("cat")
	if err := os.Symlink(cat, filepath.Join(bin, "claude")); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "s")
	for _, s := range []struct{ name, cmd string }{{"agent", filepath.Join(bin, "claude")}, {"shell", cat}} {
		if out, err := exec.Command("tmux", "-S", socket, "new-session", "-d", "-s", s.name, s.cmd).CombinedOutput(); err != nil {
			t.Fatalf("tmux: %s", out)
		}
	}
	defer exec.Command("tmux", "-S", socket, "kill-server").Run()
	paneOf := func(session string) string {
		out, _ := exec.Command("tmux", "-S", socket, "display-message", "-p", "-t", session, "#{pane_id}").Output()
		return strings.TrimSpace(string(out))
	}
	doc, _ := json.Marshal(map[string]any{"entries": map[string]any{}, "recent": []map[string]any{
		{"session_id": "old-1", "tmux_socket": socket, "tmux_session": "agent", "tmux_pane": paneOf("agent"), "last_status": "done", "archived_ts": 100, "agent_name": "a"},
		{"session_id": "older-1", "tmux_socket": socket, "tmux_session": "agent", "tmux_pane": paneOf("agent"), "last_status": "done", "archived_ts": 50},
		{"session_id": "gone-1", "tmux_socket": socket, "tmux_session": "shell", "tmux_pane": paneOf("shell"), "last_status": "done", "archived_ts": 90},
	}})
	_ = os.WriteFile(filepath.Join(dir, "attention.json"), doc, 0o600)
	t.Setenv("WEZDECK_ATTENTION_FILE", filepath.Join(dir, "attention.json"))
	time.Sleep(200 * time.Millisecond) // let tmux settle pane_current_command
	list, err := listSessions()
	if err != nil {
		t.Fatal(err)
	}
	cards := list.(map[string]any)["sessions"].([]sessionCard)
	if len(cards) != 1 || cards[0].ID != "old-1" || cards[0].Status != "idle" {
		t.Fatalf("want only the newest archived agent pane as idle, got %+v", cards)
	}
	if _, err := sendToSession(json.RawMessage(`{"id":"old-1","text":"back again"}`)); err != nil {
		t.Fatalf("idle archived session must take input: %v", err)
	}
}

func TestReadSessionTitleClaudeAndGrok(t *testing.T) {
	dir := t.TempDir()
	claude := filepath.Join(dir, "c.jsonl")
	_ = os.WriteFile(claude, []byte(
		`{"type":"user","message":{"role":"user","content":"hi"}}`+"\n"+
			`{"type":"ai-title","aiTitle":"First title"}`+"\n"+
			`{"type":"ai-title","aiTitle":"Renamed title"}`+"\n",
	), 0o600)
	if got := readSessionTitle(claude, "claude"); got != "Renamed title" {
		t.Fatalf("claude title=%q", got)
	}
	grokDir := filepath.Join(dir, "g")
	_ = os.MkdirAll(grokDir, 0o755)
	chat := filepath.Join(grokDir, "chat_history.jsonl")
	_ = os.WriteFile(chat, []byte("{}\n"), 0o600)
	_ = os.WriteFile(filepath.Join(grokDir, "summary.json"), []byte(
		`{"generated_title":"Grok auto title","session_summary":"fallback"}`,
	), 0o600)
	if got := readSessionTitle(chat, "grok"); got != "Grok auto title" {
		t.Fatalf("grok title=%q", got)
	}
}

func TestMainWorktreeFromGitCommon(t *testing.T) {
	cases := []struct{ in, want string }{
		{"/home/yuns/github/wezterm-config/.git", "/home/yuns/github/wezterm-config"},
		{"/home/yuns/github/wezterm-config/.git/worktrees/dev-foo", "/home/yuns/github/wezterm-config"},
		{"/tmp/not-git", ""},
	}
	for _, c := range cases {
		if got := mainWorktreeFromGitCommon(c.in); got != c.want {
			t.Fatalf("mainWorktreeFromGitCommon(%q)=%q want %q", c.in, got, c.want)
		}
	}
	if paneRole(1) != "primary" || paneRole(2) != "secondary" {
		t.Fatal("paneRole: index 1 primary, else secondary")
	}
}

// Grok panes run under grok-focus-filter.py, so pane_current_command is
// python3. Archived ones must still list as idle when a Grok transcript
// (or agent_name) identifies them; plain python3 must not.
func TestArchivedGrokPython3PaneStaysListed(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	grokDir := filepath.Join(home, ".grok", "sessions", "%2Fwork", "grok-py")
	if err := os.MkdirAll(grokDir, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(grokDir, "chat_history.jsonl"), []byte("{}\n"), 0o600)
	t.Setenv("HOME", home)

	bin := filepath.Join(dir, "bin")
	_ = os.MkdirAll(bin, 0o755)
	cat, _ := exec.LookPath("cat")
	if err := os.Symlink(cat, filepath.Join(bin, "python3")); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "s")
	for _, s := range []struct{ name, cmd string }{
		{"grok", filepath.Join(bin, "python3")},
		{"plain", filepath.Join(bin, "python3")},
	} {
		if out, err := exec.Command("tmux", "-S", socket, "new-session", "-d", "-s", s.name, s.cmd).CombinedOutput(); err != nil {
			t.Fatalf("tmux: %s", out)
		}
	}
	defer exec.Command("tmux", "-S", socket, "kill-server").Run()
	paneOf := func(session string) string {
		out, _ := exec.Command("tmux", "-S", socket, "display-message", "-p", "-t", session, "#{pane_id}").Output()
		return strings.TrimSpace(string(out))
	}
	doc, _ := json.Marshal(map[string]any{"entries": map[string]any{}, "recent": []map[string]any{
		{"session_id": "grok-py", "tmux_socket": socket, "tmux_session": "grok", "tmux_pane": paneOf("grok"), "last_status": "done", "archived_ts": 200, "agent_name": ""},
		{"session_id": "plain-py", "tmux_socket": socket, "tmux_session": "plain", "tmux_pane": paneOf("plain"), "last_status": "done", "archived_ts": 190, "agent_name": "script"},
	}})
	_ = os.WriteFile(filepath.Join(dir, "attention.json"), doc, 0o600)
	t.Setenv("WEZDECK_ATTENTION_FILE", filepath.Join(dir, "attention.json"))
	time.Sleep(200 * time.Millisecond)
	list, err := listSessions()
	if err != nil {
		t.Fatal(err)
	}
	cards := list.(map[string]any)["sessions"].([]sessionCard)
	if len(cards) != 1 || cards[0].ID != "grok-py" || cards[0].Status != "idle" {
		t.Fatalf("want only archived Grok-under-python3 as idle, got %+v", cards)
	}
}

func TestTranscriptKeepsToolDetailsAndParsesIncrementally(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.jsonl")
	write := func(lines ...string) {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		for _, l := range lines {
			_, _ = f.WriteString(l + "\n")
		}
		f.Close()
	}
	write(
		`{"type":"user","message":{"content":"改一下标题"}}`,
		`{"type":"assistant","message":{"id":"m1","model":"claude-x","usage":{"input_tokens":5,"cache_creation_input_tokens":100,"cache_read_input_tokens":900,"output_tokens":40},"content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"a.md","old_string":"旧标题","new_string":"新标题"}}]}}`,
		`{"type":"assistant","message":{"id":"m1","model":"claude-x","usage":{"input_tokens":5,"cache_creation_input_tokens":100,"cache_read_input_tokens":900,"output_tokens":40},"content":[{"type":"text","text":""}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"The file a.md has been updated."}]}}`,
	)
	tr, err := loadTranscript(path, "claude")
	if err != nil || len(tr.messages) != 2 {
		t.Fatalf("first read: %v %+v", err, tr)
	}
	edit := tr.messages[1]
	if edit.Tool != "Edit" || edit.Text != "Edit a.md" || edit.Body != "- 旧标题\n+ 新标题" || !strings.Contains(edit.Result, "updated") ||
		edit.File != "a.md" || edit.Added != 1 || edit.Removed != 1 {
		t.Fatalf("tool details: %+v", edit)
	}
	if u := tr.usage; u.Model != "claude-x" || u.Context != 1005 || u.Turns != 1 || u.Output != 40 || u.CacheRead != 900 {
		t.Fatalf("usage (one reply over two lines counts once): %+v", u)
	}
	offset := tr.offset
	write(`{"type":"assistant","message":{"content":[{"type":"text","text":"改好了"}]}}`)
	tr, _ = loadTranscript(path, "claude")
	if len(tr.messages) != 3 || tr.messages[2].Text != "改好了" || tr.offset <= offset {
		t.Fatalf("incremental read: %+v", tr.messages)
	}
	// a partial trailing line waits for the rest
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString(`{"type":"user","message":{"content":"半`)
	f.Close()
	tr, _ = loadTranscript(path, "claude")
	if len(tr.messages) != 3 {
		t.Fatalf("partial line must wait: %d", len(tr.messages))
	}
}

func TestToolCallPendingUntilItsResult(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pending.jsonl")
	appendLine := func(l string) {
		f, _ := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		_, _ = f.WriteString(l + "\n")
		f.Close()
	}
	appendLine(`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t9","name":"Bash","input":{"command":"go test ./..."}}]}}`)
	tr, err := loadTranscript(path, "claude")
	if err != nil || len(tr.messages) != 1 || !tr.messages[0].Pending {
		t.Fatalf("a call without its result is pending: %v %+v", err, tr.messages)
	}
	appendLine(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t9","content":""}]}}`)
	tr, _ = loadTranscript(path, "claude")
	if tr.messages[0].Pending {
		t.Fatalf("an (empty) result ends pending: %+v", tr.messages[0])
	}
}

func TestGrokAndCodexTranscriptsParseAlike(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	grokDir := filepath.Join(home, ".grok", "sessions", "%2Fwork", "grok-1")
	_ = os.MkdirAll(grokDir, 0o755)
	_ = os.WriteFile(filepath.Join(grokDir, "chat_history.jsonl"), []byte(strings.Join([]string{
		`{"type":"system","content":"You are Grok"}`,
		`{"type":"user","content":[{"type":"text","text":"<user_info>x</user_info>\n<user_query>修一下按钮</user_query>"}]}`,
		`{"type":"reasoning","summary":[]}`,
		`{"type":"assistant","model_id":"grok-4.5","content":"好的","tool_calls":[{"id":"c1","name":"search_replace","arguments":"{\"file_path\":\"b.tsx\",\"old_string\":\"a\",\"new_string\":\"b\\nc\"}"}]}`,
		`{"type":"tool_result","tool_call_id":"c1","content":"ok"}`,
	}, "\n")+"\n"), 0o600)
	codexDir := filepath.Join(home, ".codex", "sessions", "2026", "11", "22")
	_ = os.MkdirAll(codexDir, 0o755)
	_ = os.WriteFile(filepath.Join(codexDir, "rollout-2026-11-22T00-00-00-codex-1.jsonl"), []byte(strings.Join([]string{
		`{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-5.5"}}}`,
		`{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"rules"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"跑测试"}]}}`,
		`{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"bash\",\"-lc\",\"go test ./...\"]}","call_id":"k1"}}`,
		`{"type":"response_item","payload":{"type":"function_call_output","call_id":"k1","output":"ok"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"通过了"}]}}`,
		`{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":5000},"total_token_usage":{"input_tokens":9000,"cached_input_tokens":4000,"output_tokens":300},"model_context_window":272000}}}`,
	}, "\n")+"\n"), 0o600)

	path, agent := findTranscript("grok-1")
	if agent != "grok" {
		t.Fatalf("grok not found: %q %q", path, agent)
	}
	g, err := loadTranscript(path, agent)
	if err != nil || len(g.messages) != 3 || g.messages[0].Text != "修一下按钮" || g.usage.Model != "grok-4.5" {
		t.Fatalf("grok: %v %+v %+v", err, g.messages, g.usage)
	}
	if tool := g.messages[2]; tool.File != "b.tsx" || tool.Added != 2 || tool.Removed != 1 || tool.Result != "ok" {
		t.Fatalf("grok tool: %+v", tool)
	}
	path, agent = findTranscript("codex-1")
	if agent != "codex" {
		t.Fatalf("codex not found: %q %q", path, agent)
	}
	c, err := loadTranscript(path, agent)
	if err != nil || len(c.messages) != 3 || c.messages[0].Text != "跑测试" || c.messages[2].Text != "通过了" {
		t.Fatalf("codex: %v %+v", err, c.messages)
	}
	if tool := c.messages[1]; tool.Body != "bash -lc go test ./..." || tool.Result != "ok" {
		t.Fatalf("codex tool: %+v", tool)
	}
	if u := c.usage; u.Model != "gpt-5.5" || u.Context != 5000 || u.ContextLimit != 272000 || u.Output != 300 || u.CacheRead != 4000 {
		t.Fatalf("codex usage: %+v", u)
	}
}
