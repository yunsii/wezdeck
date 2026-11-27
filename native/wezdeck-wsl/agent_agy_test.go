package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAgyTranscriptAdapter(t *testing.T) {
	home := t.TempDir()
	id := "11111111-2222-4333-8444-555555555555"
	path := filepath.Join(home, ".gemini", "antigravity-cli", "brain", id,
		".system_generated", "logs", "transcript_full.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	data := strings.Join([]string{
		`{"type":"USER_INPUT","source":"USER_EXPLICIT","content":"<USER_REQUEST>\nRead sample.txt\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-26.\n</ADDITIONAL_METADATA>","created_at":"2026-11-26T07:57:37Z"}`,
		`{"type":"PLANNER_RESPONSE","source":"MODEL","created_at":"2026-11-26T07:57:38Z","model":"gemini-4-neon-medium","input_tokens":12,"cache_read_tokens":3,"output_tokens":7,"tool_calls":[{"name":"read_file","args":{"Path":"sample.txt","StartLine":10,"EndLine":25}}]}`,
		`{"type":"GENERIC","source":"MODEL","content":"Created At: 2026-11-26\nCompleted At: 2026-11-26\nCreated At: 2026-11-26\nCompleted At: 2026-11-26\n10: hello world","created_at":"2026-11-26T07:57:39Z"}`,
		`{"type":"PLANNER_RESPONSE","source":"MODEL","content":"OK","created_at":"2026-11-26T07:57:40Z","model":"gemini-4-neon-medium","input_tokens":20,"cache_read_tokens":4,"output_tokens":2}`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	adapter := agyAdapter{}
	if got := adapter.Locate(home, id); got != path {
		t.Fatalf("Locate: %q", got)
	}
	if got := adapter.Locate(home, "missing"); got != "" {
		t.Fatalf("missing transcript: %q", got)
	}
	tr, err := loadTranscript(path, "agy")
	if err != nil {
		t.Fatal(err)
	}
	if len(tr.messages) != 3 || tr.messages[0].Role != "user" || tr.messages[0].Text != "Read sample.txt" {
		t.Fatalf("user message not unwrapped: %+v", tr.messages)
	}
	read := tr.messages[1]
	if read.Tool != "read_file" || read.Kind != toolKindRead || read.Pending ||
		read.File != "sample.txt" || read.Text != "read_file sample.txt:10-25" || read.Result != "10: hello world" {
		t.Fatalf("read_file details: %+v", read)
	}
	if tr.messages[2].Text != "OK" {
		t.Fatalf("assistant message: %+v", tr.messages[2])
	}
	if tr.usage.Model != "gemini-4-neon-medium" || tr.usage.Context != 24 || tr.usage.Output != 9 || tr.usage.Turns != 2 {
		t.Fatalf("usage: %+v", tr.usage)
	}
	if got := contextLimit(tr.usage.Model); got != 1000000 {
		t.Fatalf("gemini context limit: got %d want 1000000", got)
	}
	if got := adapter.Title(path); got != "Read sample.txt" {
		t.Fatalf("title: %q", got)
	}
	if got := lastTurnAt(path, "agy"); got == 0 {
		t.Fatal("Agy last turn was not parsed")
	}
	users, files, last := handoffTranscriptDigest(path, "agy")
	if len(users) != 1 || users[0] != "Read sample.txt" || len(files) != 1 || files[0] != "sample.txt" || last != "OK" {
		t.Fatalf("handoff digest: users=%v files=%v last=%q", users, files, last)
	}
}

func TestAgyToolDetailsAndFIFOGenericResults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "transcript_full.jsonl")
	lines := []string{
		`{"type":"USER_INPUT","content":"<USER_REQUEST>\nFix bug\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting ` + "`Agent Mode`" + ` from Default to Auto.\n</USER_SETTINGS_CHANGE>","created_at":"2026-11-26T08:00:00Z"}`,
		`{"type":"PLANNER_RESPONSE","created_at":"2026-11-26T08:00:01Z","model":"gemini-4-neon-high","tool_calls":[` +
			`{"name":"run_command","args":{"CommandLine":"go test ./...","toolSummary":"Run Go tests","BypassSandbox":true}},` +
			`{"name":"edit_file","args":{"Path":"app.go","Target":"oldA\noldB","Replacement":"newA\nnewB\nnewC"}},` +
			`{"name":"write_file","args":{"Path":"new.go","Content":"package main\nfunc x() {}\n"}},` +
			`{"name":"update_steps","args":{"steps":[{"title":"Inspect","status":"done"},{"title":"Fix","status":"in_progress"}]}}` +
			`]}`,
		`{"type":"GENERIC","content":"Created At: 2026-11-26\nCompleted At: 2026-11-26\nCommand exited with code 0\nok pkg","created_at":"2026-11-26T08:00:02Z"}`,
		`{"type":"GENERIC","content":"Made 1 replacement in app.go","created_at":"2026-11-26T08:00:03Z"}`,
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tr, err := loadTranscript(path, "agy")
	if err != nil {
		t.Fatal(err)
	}
	if tr.mode != "auto" {
		t.Fatalf("mode from settings change: got %q want auto", tr.mode)
	}
	if len(tr.messages) != 5 {
		t.Fatalf("messages count: got %d (%+v)", len(tr.messages), tr.messages)
	}
	cmd := tr.messages[1]
	if cmd.Kind != toolKindCommand || cmd.Pending || !strings.Contains(cmd.Text, "[unsandboxed] Run Go tests · go test ./...") ||
		!strings.Contains(cmd.Body, "go test ./...") || !strings.Contains(cmd.Body, "[bypass-sandbox]") ||
		!strings.Contains(cmd.Result, "Command exited with code 0") {
		t.Fatalf("run_command: %+v", cmd)
	}
	edit := tr.messages[2]
	if edit.Kind != toolKindEdit || edit.Pending || edit.File != "app.go" || edit.Removed != 2 || edit.Added != 3 ||
		!strings.Contains(edit.Body, "- oldA") || !strings.Contains(edit.Body, "+ newC") ||
		edit.Result != "Made 1 replacement in app.go" {
		t.Fatalf("edit_file: %+v", edit)
	}
	write := tr.messages[3]
	if write.Kind != toolKindWrite || !write.Pending || write.File != "new.go" || write.Added != 2 ||
		!strings.Contains(write.Body, "package main") {
		t.Fatalf("write_file (still pending): %+v", write)
	}
	steps := tr.messages[4]
	if steps.Kind != toolKindTodo || !steps.Pending || steps.Text != "update_steps 1/2 · Fix" ||
		!strings.Contains(steps.Body, "✓ Inspect") || !strings.Contains(steps.Body, "● Fix") {
		t.Fatalf("update_steps: %+v", steps)
	}
	// A subsequent PLANNER_RESPONSE settles any lingering pending calls.
	tr.feedAgy([]byte(`{"type":"PLANNER_RESPONSE","content":"Done","created_at":"2026-11-26T08:00:05Z"}`))
	if tr.messages[3].Pending || tr.messages[4].Pending {
		t.Fatalf("lingering pending not settled: %+v %+v", tr.messages[3], tr.messages[4])
	}
}

func TestAgyModeResolution(t *testing.T) {
	if got := agyModeFromArgs([]string{"agy", "--mode", "auto"}); got != "auto" {
		t.Fatalf("--mode auto: %q", got)
	}
	if got := agyModeFromArgs([]string{"agy", "--mode=accept-edits"}); got != "accept-edits" {
		t.Fatalf("--mode=accept-edits: %q", got)
	}
	if got := agyModeFromArgs([]string{"agy", "--mode", "auto", "--dangerously-skip-permissions"}); got != "full-access" {
		t.Fatalf("full-access precedence: %q", got)
	}

	dir := t.TempDir()
	t.Setenv("AGY_CONFIG_DIR", dir)
	if got := resolveAgyMode(attentionEntry{}, nil); got != "default" {
		t.Fatalf("missing settings.json should resolve to default, got %q", got)
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"agentMode":"auto"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := resolveAgyMode(attentionEntry{}, nil); got != "auto" {
		t.Fatalf("settings.json agentMode=auto: got %q", got)
	}
	if got := resolveAgyMode(attentionEntry{}, &transcript{mode: "plan"}); got != "plan" {
		t.Fatalf("transcript mode should win over settings.json: got %q", got)
	}
}

func TestAgyWorkspaceTrustIsExact(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("AGY_CONFIG_DIR", "")
	path := filepath.Join(home, ".gemini", "antigravity-cli", "settings.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"trustedWorkspaces":["/repo"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if !agyWorkspaceTrusted("/repo") || agyWorkspaceTrusted("/repo/new-worktree") {
		t.Fatal("Agy trust must be confirmed for each worktree")
	}
}

func TestAgyPendingAskAndSettlement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "transcript_full.jsonl")
	openAsk := strings.Join([]string{
		`{"step_index":0,"type":"USER_INPUT","content":"<USER_REQUEST>\nHelp\n</USER_REQUEST>"}`,
		`{"step_index":1,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"ask_question","args":{"questions":[{"question":"Which mode?","options":["(Recommended) Auto","Manual"],"is_multi_select":false},{"question":"Extras?","options":["Logs","Metrics"],"is_multi_select":true}]}}]}`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(openAsk), 0o600); err != nil {
		t.Fatal(err)
	}
	el := (agyAdapter{}).PendingAsk(path, "Question 2/2: Extras?\n> 1. Logs\n  2. Metrics")
	if el == nil || el.ToolCallID != "agy-step-1" || len(el.Questions) != 2 {
		t.Fatalf("pending ask: %+v", el)
	}
	if el.CurrentStep != 2 {
		t.Fatalf("current_step = %d, want 2", el.CurrentStep)
	}
	if got := (agyAdapter{}).PendingAsk(path, "Question 1/3: unrelated"); got == nil || got.CurrentStep != 0 {
		t.Fatalf("mismatched total should leave current_step=0: %+v", got)
	}
	if el.Questions[0].Question != "Which mode?" || len(el.Questions[0].Options) != 2 || el.Questions[0].Options[0].Label != "(Recommended) Auto" || el.Questions[0].MultiSelect {
		t.Fatalf("q0: %+v", el.Questions[0])
	}
	if !el.Questions[1].MultiSelect || len(el.Questions[1].Options) != 2 {
		t.Fatalf("q1: %+v", el.Questions[1])
	}
	// Once GENERIC arrives for that ask_question, PendingAsk clears.
	answered := openAsk + `{"step_index":2,"type":"GENERIC","content":"User selected: Auto"}` + "\n"
	if err := os.WriteFile(path, []byte(answered), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := (agyAdapter{}).PendingAsk(path, ""); got != nil {
		t.Fatalf("answered ask must clear: %+v", got)
	}
	if messagesRevFor("agy") != agyMessagesRev || agyMessagesRev < 1 {
		t.Fatalf("agy messages_rev: %d", messagesRevFor("agy"))
	}
}

func TestAgySkillsDiscoveryAndPrecedence(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := filepath.Join(t.TempDir(), "proj")
	mkSkill := func(dir, content string) {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	mkSkill(filepath.Join(cwd, ".agents", "skills", "shared"), "---\nname: shared\ndescription: project override\n---\n")
	mkSkill(filepath.Join(home, ".agents", "skills", "shared"), "---\nname: shared\ndescription: user copy\n---\n")
	mkSkill(filepath.Join(home, ".gemini", "config", "skills", "custom"), "---\nname: custom\ndescription: >-\n  multi-line\n  description\n---\n")
	mkSkill(filepath.Join(home, ".gemini", "antigravity-cli", "builtin", "skills", "guide"), "---\nname: guide\ndescription: built in\n---\n")

	raw, err := (agyAdapter{}).Skills("", cwd)
	if err != nil {
		t.Fatal(err)
	}
	list := classifySkills(raw, cwd)
	byName := map[string]skillInfo{}
	for _, s := range list {
		byName[s.Name] = s
	}
	if byName["shared"].Origin != "project" || byName["shared"].Description != "project override" {
		t.Fatalf("project precedence failed: %+v", byName["shared"])
	}
	if byName["custom"].Origin != "user" || byName["custom"].Description != "multi-line description" {
		t.Fatalf("user skill failed: %+v", byName["custom"])
	}
	if byName["guide"].Origin != "builtin" || byName["guide"].Description != "built in" {
		t.Fatalf("builtin skill failed: %+v", byName["guide"])
	}
}

func TestAgyThinkingAndScreenPermissionCard(t *testing.T) {
	path := filepath.Join(t.TempDir(), "transcript_full.jsonl")
	lines := []string{
		`{"step_index":0,"type":"USER_INPUT","content":"<USER_REQUEST>\nPush branch\n</USER_REQUEST>"}`,
		`{"step_index":1,"type":"PLANNER_RESPONSE","thinking":"Checking git push.\nNeeds bypass sandbox.","tool_calls":[{"name":"run_command","args":{"CommandLine":"git push origin master","toolSummary":"Push branch","BypassSandbox":true}}]}`,
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tr, err := loadTranscript(path, "agy")
	if err != nil {
		t.Fatal(err)
	}
	if len(tr.messages) != 3 || tr.messages[1].Role != "system" || tr.messages[1].Kind != "thought" ||
		tr.messages[1].Text != "Checking git push." || !strings.Contains(tr.messages[1].Body, "Needs bypass sandbox.") {
		t.Fatalf("thought message: %+v", tr.messages)
	}
	if !agyPermissionPromptVisible("Run this command?\n> Yes, run command\n  No, deny" + strings.Repeat("\n", 30)) {
		t.Fatal("Run this command? with trailing blank rows should be detected")
	}
	if !agyPermissionPromptVisible("Allow calling this tool?\n> Yes, allow tool call\n  No, deny tool call") {
		t.Fatal("Allow calling this tool? should be detected")
	}
	if !agyPermissionPromptVisible("Do you want to proceed?\n> 1. Yes\n  2. Yes, and always allow 'git push'") {
		t.Fatal("Do you want to proceed? + always allow should be detected")
	}
	if agyPermissionPromptVisible("确认项（Yes, run command / Yes, allow access）+ 拒绝项（No, deny / Run this command?）\n>\n? for shortcuts") {
		t.Fatal("assistant prose quoting option strings must not trigger permission card")
	}
	if agyPermissionPromptVisible("Do you trust the contents of this project?\n> Yes, I trust this folder") {
		t.Fatal("workspace trust prompt must not be treated as permission prompt")
	}
	// Incremental polls pass an empty out["messages"] slice; pending must still come from full transcript.
	screenWithAlways := strings.Join([]string{
		"Run this command?",
		"  git push origin master",
		"> Yes, run command",
		"  Yes, and always allow for commands that start with \"git push\"",
		"  No, deny",
	}, "\n")
	out := map[string]any{"status": "running", "waiting_kind": "", "messages": []chatMessage{}}
	applyAgyScreenPermission(out, pendingPermission(tr.messages, ""), screenWithAlways)
	if out["status"] != "waiting" || out["waiting_kind"] != "permission_prompt" {
		t.Fatalf("status not escalated to waiting: %+v", out)
	}
	perm, ok := out["permission"].(*pendingCall)
	if !ok || perm == nil || perm.Tool != "run_command" || !strings.Contains(perm.Body, "git push origin master") {
		t.Fatalf("permission card: %+v", out["permission"])
	}
	if len(perm.Options) != 3 ||
		perm.Options[0].Kind != "allow" || strings.Join(perm.Options[0].Keys, ",") != "Enter" ||
		perm.Options[1].Kind != "always" || strings.Join(perm.Options[1].Keys, ",") != "Down,Enter" ||
		!strings.Contains(perm.Options[1].Label, "git push") ||
		perm.Options[2].Kind != "deny" || strings.Join(perm.Options[2].Keys, ",") != "Escape" {
		t.Fatalf("parsed permission options: %+v", perm.Options)
	}
	// If the cursor in tmux already moved to the 2nd row, keys adjust relative to it.
	shifted := agyPermissionOptions("Do you want to proceed?\n  1. Yes\n> 2. Yes, and always allow 'git push'\n  3. No")
	if len(shifted) != 3 ||
		strings.Join(shifted[0].Keys, ",") != "Up,Enter" ||
		strings.Join(shifted[1].Keys, ",") != "Enter" ||
		strings.Join(shifted[2].Keys, ",") != "Escape" {
		t.Fatalf("shifted cursor options: %+v", shifted)
	}
	// Idle/completed turns or turns without an unanswered tool call must NEVER lock the composer.
	outIdle := map[string]any{"status": "done", "waiting_kind": ""}
	applyAgyScreenPermission(outIdle, pendingPermission(tr.messages, ""), "Run this command?\n> Yes, run command\n  No, deny")
	if _, locked := outIdle["permission"]; locked {
		t.Fatalf("completed turn must not surface permission card: %+v", outIdle)
	}
	outNoPending := map[string]any{"status": "running", "waiting_kind": ""}
	applyAgyScreenPermission(outNoPending, nil, "Run this command?\n> Yes, run command\n  No, deny")
	if _, locked := outNoPending["permission"]; locked {
		t.Fatalf("turn without unanswered tool call must not surface permission card: %+v", outNoPending)
	}
}

func TestAgyScreenPermissionEscalatesSessionListAndMeta(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	id := "22222222-3333-4444-8555-666666666666"
	transcriptPath := filepath.Join(home, ".gemini", "antigravity-cli", "brain", id,
		".system_generated", "logs", "transcript_full.jsonl")
	if err := os.MkdirAll(filepath.Dir(transcriptPath), 0o700); err != nil {
		t.Fatal(err)
	}
	transcriptLines := strings.Join([]string{
		`{"step_index":0,"type":"USER_INPUT","content":"<USER_REQUEST>\nDeploy\n</USER_REQUEST>"}`,
		`{"step_index":1,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"run_command","args":{"CommandLine":"git push origin master","toolSummary":"Push branch","BypassSandbox":true}}]}`,
	}, "\n") + "\n"
	if err := os.WriteFile(transcriptPath, []byte(transcriptLines), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)

	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	sh, _ := exec.LookPath("sh")
	if err := os.Symlink(sh, filepath.Join(bin, "agy")); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "s")
	cmd := "printf 'Run this command?\\n> Yes, run command\\n  No, deny\\n'; sleep 30"
	if out, err := exec.Command("tmux", "-S", socket, "new-session", "-d", "-s", "agy-perm",
		filepath.Join(bin, "agy"), "-c", cmd).CombinedOutput(); err != nil {
		t.Fatalf("tmux: %s", out)
	}
	defer exec.Command("tmux", "-S", socket, "kill-server").Run()
	paneOut, _ := exec.Command("tmux", "-S", socket, "display-message", "-p", "-t", "agy-perm", "#{pane_id}").Output()
	pane := strings.TrimSpace(string(paneOut))
	_ = exec.Command("tmux", "-S", socket, "set-option", "-p", "-t", pane, "@wezterm_pane_role", "agent-cli:agy").Run()

	attentionPath := filepath.Join(dir, "attention.json")
	doc, _ := json.Marshal(map[string]any{
		"entries": map[string]any{
			id: map[string]any{
				"session_id": id, "agent_name": "agy", "tmux_socket": socket,
				"tmux_session": "agy-perm", "tmux_pane": pane, "status": "running",
			},
		},
	})
	if err := os.WriteFile(attentionPath, doc, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEZDECK_ATTENTION_FILE", attentionPath)
	time.Sleep(250 * time.Millisecond)

	list, err := listSessions()
	if err != nil {
		t.Fatal(err)
	}
	cards := list.(map[string]any)["sessions"].([]sessionCard)
	if len(cards) != 1 || cards[0].Status != "waiting" || cards[0].WaitingKind != "permission_prompt" {
		t.Fatalf("running Agy pane with visible permission prompt must list as waiting/permission_prompt, got %+v", cards)
	}

	detail, err := sessionDetail(json.RawMessage(`{"id":"` + id + `"}`))
	if err != nil {
		t.Fatal(err)
	}
	m := detail.(map[string]any)
	if m["status"] != "waiting" || m["waiting_kind"] != "permission_prompt" {
		t.Fatalf("detail status not escalated: %+v", m)
	}
	var metaStatus, metaWaiting string
	for _, g := range m["meta"].([]metaGroup) {
		if g.Name == "state" {
			for _, r := range g.Rows {
				if r.Key == "status" {
					metaStatus = r.Value
				}
				if r.Key == "waiting_kind" {
					metaWaiting = r.Value
				}
			}
		}
	}
	if metaStatus != "waiting" || metaWaiting != "permission_prompt" {
		t.Fatalf("detail meta state must reflect escalated waiting/permission_prompt, got status=%q waiting_kind=%q", metaStatus, metaWaiting)
	}
}
