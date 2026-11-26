package main

// Cross-agent session handoff (replace in place):
//
//   session.handoff      write  {id, to, note?} → {job}
//   session.handoff.job  read   {job} → stage starting|sending|done|failed …
//
// Builds a deterministic continuation brief from the source transcript
// (no LLM), replaces the pane's agent via scripts/runtime/session-handoff.sh
// (sticks @wezterm_window_agent_profile so later F5 keeps the target), waits
// for the TUI, pastes the brief. Does not recycle the worktree and does not
// migrate the transcript — different backends only get a pointer + summary.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	handoffNoteMax  = 2000
	handoffBriefMax = 6000
)

var handoffAgents = map[string]bool{
	"claude": true, "codex": true, "grok": true, "agy": true,
}

type handoffJob struct {
	ID        string `json:"job"`
	Stage     string `json:"stage"` // starting | sending | done | failed
	FromID    string `json:"from_id"`
	FromAgent string `json:"from_agent,omitempty"`
	ToAgent   string `json:"to_agent"`
	Worktree  string `json:"worktree,omitempty"`
	Pane      string `json:"pane,omitempty"`
	SessionID string `json:"session_id,omitempty"` // Claude up front; others after paste
	// Brief is the pasted continuation text so the web console can seed a
	// queued bubble before the transcript poll catches up.
	Brief string `json:"brief,omitempty"`
	Error string `json:"error,omitempty"`
	at    time.Time
}

var (
	handoffJobsMu sync.Mutex
	handoffJobs   = map[string]*handoffJob{}
)

func setHandoffJob(id string, change func(j *handoffJob)) {
	handoffJobsMu.Lock()
	defer handoffJobsMu.Unlock()
	if j := handoffJobs[id]; j != nil {
		change(j)
	}
}

func startSessionHandoff(args json.RawMessage) (any, error) {
	var a struct {
		ID   string `json:"id"`
		To   string `json:"to"`
		Note string `json:"note"`
	}
	if json.Unmarshal(args, &a) != nil {
		return nil, errors.New("session.handoff: bad arguments")
	}
	a.To = strings.ToLower(strings.TrimSpace(a.To))
	a.Note = strings.TrimSpace(a.Note)
	if !handoffAgents[a.To] {
		return nil, errors.New("session.handoff: to must be claude, codex, grok or agy")
	}
	if utf8.RuneCountInString(a.Note) > handoffNoteMax || strings.ContainsAny(a.Note, "\x00") {
		return nil, fmt.Errorf("session.handoff: note is at most %d characters", handoffNoteMax)
	}
	e, err := guardSession(a.ID)
	if err != nil {
		return nil, err
	}
	path, fromAgent := findTranscript(e.SessionID)
	if fromAgent == "" {
		if _, _, cmd, _, _, alive := paneState(e); alive && agentCommands[cmd] {
			fromAgent = strings.TrimSuffix(cmd, ".real")
		}
	}
	if fromAgent == "" {
		fromAgent = "agent"
	}
	if fromAgent == a.To {
		return nil, fmt.Errorf("session.handoff: already on %s — use 新开会话 for a blank process of the same agent", a.To)
	}
	_, cwd, _, _, _, alive := paneState(e)
	if !alive {
		return nil, errors.New("session.handoff: the pane is gone")
	}
	if a.To == "agy" && !agyWorkspaceTrusted(cwd) {
		return nil, errors.New("session.handoff: trust this worktree in Agy at the terminal before handoff")
	}
	job := &handoffJob{
		ID: newDiagID(), Stage: "starting", FromID: a.ID, FromAgent: fromAgent,
		ToAgent: a.To, Worktree: cwd, Pane: e.TmuxPane, at: time.Now(),
	}
	handoffJobsMu.Lock()
	for id, j := range handoffJobs {
		if time.Since(j.at) > time.Hour {
			delete(handoffJobs, id)
		}
	}
	handoffJobs[job.ID] = job
	handoffJobsMu.Unlock()
	go runSessionHandoff(job.ID, e, path, fromAgent, a.To, a.Note)
	return map[string]any{"v": 1, "ok": true, "job": job.ID}, nil
}

func handoffJobStatus(args json.RawMessage) (any, error) {
	var a struct {
		Job string `json:"job"`
	}
	_ = json.Unmarshal(args, &a)
	handoffJobsMu.Lock()
	defer handoffJobsMu.Unlock()
	j := handoffJobs[a.Job]
	if j == nil {
		return nil, errors.New("session.handoff.job: unknown job")
	}
	return map[string]any{"v": 1, "ok": true, "job": *j}, nil
}

func runSessionHandoff(id string, e attentionEntry, transcript, fromAgent, toAgent, note string) {
	fail := func(err error) {
		setHandoffJob(id, func(j *handoffJob) { j.Stage, j.Error = "failed", clip(err.Error(), 300) })
		relayLogf("session_handoff", "job=%s ok=false err=%q", id, err)
	}
	brief := buildHandoffBrief(e, transcript, fromAgent, toAgent, note)
	setHandoffJob(id, func(j *handoffJob) { j.Brief = brief })
	cmdPath := os.Getenv("WEZDECK_SESSION_HANDOFF_CMD")
	if cmdPath == "" {
		cmdPath = filepath.Join(repoRoot(), "scripts", "runtime", "session-handoff.sh")
	}
	argv := []string{cmdPath, "--pane", e.TmuxPane, "--to", toAgent, "--from", fromAgent}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "bash", argv...)
	cmd.Env = os.Environ()
	if e.TmuxSocket != "" {
		cmd.Env = append(cmd.Env, "TMUX="+e.TmuxSocket+",0,0")
	}
	if p := os.Getenv("WEZDECK_ATTENTION_FILE"); p != "" {
		cmd.Env = append(cmd.Env, "WEZDECK_ATTENTION_STATE_PATH="+p, "WEZTERM_ATTENTION_LOCK_FILE="+p+".lock")
	}
	out, err := cmd.Output()
	result := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	for sc.Scan() {
		if k, v, ok := strings.Cut(sc.Text(), "="); ok {
			result[k] = v
		}
	}
	if err != nil || result["outcome"] != "respawned" {
		msg := result["outcome"]
		if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
			msg = strings.TrimSpace(string(ee.Stderr))
		} else if msg == "" && err != nil {
			msg = err.Error()
		}
		fail(fmt.Errorf("handoff respawn failed: %s", clip(msg, 200)))
		return
	}
	newID := result["session_id"]
	if newID != "" {
		setHandoffJob(id, func(j *handoffJob) { j.SessionID = newID })
	}
	if err := waitAgentReady(e.TmuxSocket, e.TmuxPane, 90*time.Second); err != nil {
		fail(err)
		return
	}
	setHandoffJob(id, func(j *handoffJob) { j.Stage = "sending" })
	if err := pasteToPane(e.TmuxSocket, e.TmuxPane, brief); err != nil {
		fail(err)
		return
	}
	// After paste, wait for the target session to appear so the web page can
	// open it and seed a queued bubble keyed by the real id (Grok/Codex mint
	// the id on the first prompt; Claude already returned one above).
	if newID == "" {
		waitFor := 45 * time.Second
		// test stubs set WEZDECK_SESSION_HANDOFF_CMD; don't hang the job
		if os.Getenv("WEZDECK_SESSION_HANDOFF_CMD") != "" {
			waitFor = 800 * time.Millisecond
		}
		newID = waitHandoffSessionID(e, e.SessionID, toAgent, waitFor)
		if newID != "" {
			setHandoffJob(id, func(j *handoffJob) { j.SessionID = newID })
			markHandoffCleared(e, newID)
		}
	}
	setHandoffJob(id, func(j *handoffJob) { j.Stage = "done" })
	relayLogf("session_handoff", "job=%s ok=true from=%s to=%s pane=%s new=%s",
		id, fromAgent, toAgent, e.TmuxPane, newID)
}

// waitHandoffSessionID waits until attention lists a new session on this
// pane (session detail needs that entry — a bare transcript path is not
// enough for the web console to open).
func waitHandoffSessionID(e attentionEntry, fromID, _ string, limit time.Duration) string {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if sid := handoffSessionFromAttention(e, fromID); sid != "" {
			return sid
		}
		time.Sleep(400 * time.Millisecond)
	}
	return ""
}

func handoffSessionFromAttention(e attentionEntry, fromID string) string {
	raw, err := os.ReadFile(attentionFile())
	if err != nil {
		return ""
	}
	var doc struct {
		Entries map[string]attentionEntry `json:"entries"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return ""
	}
	for id, ent := range doc.Entries {
		if id == fromID || id == "" {
			continue
		}
		if e.TmuxPane != "" && ent.TmuxPane == e.TmuxPane &&
			(e.TmuxSocket == "" || ent.TmuxSocket == e.TmuxSocket) {
			return id
		}
	}
	return ""
}

func markHandoffCleared(e attentionEntry, newID string) {
	script := filepath.Join(repoRoot(), "scripts", "runtime", "attention-state-lib.sh")
	if _, err := os.Stat(script); err != nil {
		return
	}
	cmd := exec.Command("bash", "-c",
		`source "$1" && attention_mark_cleared "$2" "$3" "$4"`,
		"handoff-cleared", script, e.TmuxSocket, e.TmuxPane, newID)
	cmd.Env = os.Environ()
	if p := os.Getenv("WEZDECK_ATTENTION_FILE"); p != "" {
		cmd.Env = append(cmd.Env, "WEZDECK_ATTENTION_STATE_PATH="+p, "WEZTERM_ATTENTION_LOCK_FILE="+p+".lock")
	}
	_ = cmd.Run()
}

// buildHandoffBrief: deterministic continuation prompt — reference header +
// recent user intents + last assistant tail + touched files + optional note.
func buildHandoffBrief(e attentionEntry, transcript, fromAgent, toAgent, note string) string {
	title := e.AgentName
	if title == "" {
		title = e.WindowName
	}
	if t := readSessionTitle(transcript, fromAgent); t != "" {
		title = t
	}
	if title == "" {
		title = e.SessionID
	}
	ref := sessionReference(e, transcript, fromAgent)
	var b strings.Builder
	b.WriteString(fmt.Sprintf("[wezdeck 接力] %s（%s → %s）\n", title, fromAgent, toAgent))
	// Drop the first line of the plain reference (it duplicates the header).
	if i := strings.IndexByte(ref, '\n'); i >= 0 {
		b.WriteString(ref[i+1:])
	} else {
		b.WriteString(ref)
	}
	b.WriteString("\n\n## 任务\n")
	users, files, lastAssist := handoffTranscriptDigest(transcript, fromAgent)
	if len(users) == 0 {
		b.WriteString("（源会话没有可抽取的用户消息；请直接读 transcript。）\n")
	} else {
		for _, u := range users {
			b.WriteString("- ")
			b.WriteString(u)
			b.WriteByte('\n')
		}
	}
	b.WriteString("\n## 现状\n")
	if lastAssist != "" {
		b.WriteString(lastAssist)
		b.WriteByte('\n')
	} else {
		b.WriteString("（无助手收尾摘要。）\n")
	}
	if len(files) > 0 {
		b.WriteString("\n关键文件：\n")
		for _, f := range files {
			b.WriteString("- ")
			b.WriteString(f)
			b.WriteByte('\n')
		}
	}
	b.WriteString("\n## 请你\n")
	b.WriteString("在同一 cwd 继续；先读 transcript 末尾与相关文件核对，再动手。\n")
	b.WriteString("不要 recycle / 不要重置 worktree。\n")
	if note != "" {
		b.WriteString("\n## 补充\n")
		b.WriteString(note)
		b.WriteByte('\n')
	}
	out := b.String()
	if utf8.RuneCountInString(out) > handoffBriefMax {
		runes := []rune(out)
		out = string(runes[:handoffBriefMax-20]) + "\n…（brief 已截断）\n"
	}
	return out
}

func handoffTranscriptDigest(path, agent string) (users []string, files []string, lastAssist string) {
	if path == "" {
		return nil, nil, ""
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, ""
	}
	defer f.Close()
	fileSet := map[string]struct{}{}
	var userBuf []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		switch agent {
		case "claude":
			handoffDigestClaude(line, &userBuf, fileSet, &lastAssist)
		case "grok":
			handoffDigestGrok(line, &userBuf, fileSet, &lastAssist)
		case "codex":
			handoffDigestCodex(line, &userBuf, fileSet, &lastAssist)
		case "agy":
			handoffDigestAgy(line, &userBuf, fileSet, &lastAssist)
		}
	}
	// last up to 6 user turns, each clipped
	start := 0
	if len(userBuf) > 6 {
		start = len(userBuf) - 6
	}
	for _, u := range userBuf[start:] {
		users = append(users, clip(compactHandoffText(u), 280))
	}
	for f := range fileSet {
		files = append(files, f)
		if len(files) >= 12 {
			break
		}
	}
	lastAssist = clip(compactHandoffText(lastAssist), 600)
	return users, files, lastAssist
}

func handoffDigestClaude(line []byte, users *[]string, files map[string]struct{}, lastAssist *string) {
	var o struct {
		Type    string `json:"type"`
		Message struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &o) != nil {
		return
	}
	if o.Type == "user" {
		if text := handoffContentText(o.Message.Content); text != "" && !handoffSkipUserText(text) {
			*users = append(*users, text)
		}
		return
	}
	if o.Type != "assistant" {
		return
	}
	var parts []struct {
		Type  string         `json:"type"`
		Text  string         `json:"text"`
		Name  string         `json:"name"`
		Input map[string]any `json:"input"`
	}
	_ = json.Unmarshal(o.Message.Content, &parts)
	var texts []string
	for _, p := range parts {
		switch p.Type {
		case "text":
			if strings.TrimSpace(p.Text) != "" {
				texts = append(texts, p.Text)
			}
		case "tool_use":
			for _, k := range []string{"file_path", "path", "target_file", "notebook_path"} {
				if v, ok := p.Input[k].(string); ok && v != "" {
					files[clip(v, 160)] = struct{}{}
				}
			}
		}
	}
	if len(texts) > 0 {
		*lastAssist = strings.Join(texts, "\n")
	}
}

func handoffDigestGrok(line []byte, users *[]string, files map[string]struct{}, lastAssist *string) {
	var o map[string]any
	if json.Unmarshal(line, &o) != nil {
		return
	}
	role, _ := o["role"].(string)
	text, _ := o["content"].(string)
	if text == "" {
		if c, ok := o["text"].(string); ok {
			text = c
		}
	}
	switch role {
	case "user":
		if text != "" && !handoffSkipUserText(text) {
			*users = append(*users, text)
		}
	case "assistant":
		if text != "" {
			*lastAssist = text
		}
	}
	_ = files // Grok chat_history rarely carries tool paths in one line
}

func handoffDigestCodex(line []byte, users *[]string, files map[string]struct{}, lastAssist *string) {
	var o struct {
		Type string `json:"type"`
		Item struct {
			Type    string `json:"type"`
			Role    string `json:"role"`
			Text    string `json:"text"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"item"`
		Payload json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(line, &o) != nil {
		return
	}
	text := o.Item.Text
	for _, c := range o.Item.Content {
		if c.Text != "" {
			text += c.Text
		}
	}
	role := o.Item.Role
	if role == "" && (o.Type == "user" || o.Type == "assistant") {
		role = o.Type
	}
	switch role {
	case "user":
		if text != "" && !handoffSkipUserText(text) {
			*users = append(*users, text)
		}
	case "assistant":
		if text != "" {
			*lastAssist = text
		}
	}
	_ = files
}

func handoffContentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) != nil {
		return ""
	}
	var b strings.Builder
	for _, p := range parts {
		if p.Type == "text" && p.Text != "" {
			if b.Len() > 0 {
				b.WriteByte('\n')
			}
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

func handoffSkipUserText(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return true
	}
	// skill / command injections and tool_result wrappers
	if strings.HasPrefix(s, "<") || strings.HasPrefix(s, "Base directory for this skill:") {
		return true
	}
	if strings.Contains(s, "<command-name>") || strings.Contains(s, "commandMode") {
		return true
	}
	return false
}

func compactHandoffText(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	var b strings.Builder
	blank := false
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimRightFunc(line, unicode.IsSpace)
		if line == "" {
			if blank {
				continue
			}
			blank = true
			continue
		}
		blank = false
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(line)
	}
	return strings.TrimSpace(b.String())
}
