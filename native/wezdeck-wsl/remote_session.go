package main

// Remote interaction with agent sessions (docs/remote-sessions.md):
// read the live agents from attention.json, render a Claude transcript (or
// a tmux screen tail), and write into a session under guards:
//
//   - one writer: a tmux-hosted session only ever receives a paste into its
//     own TUI (never a second process resuming the same session id);
//   - mid-turn only for Claude Code (it queues input itself); other agents
//     once the turn is over or only background tasks are left;
//   - not while someone typed at the desk in the last DeskIdle seconds;
//   - every write is signed by an approved device key (ECDSA P-256, the
//     private key never leaves the phone) — Cloudflare cannot forge one;
//   - every write is logged (category=relay event=write).

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
)

// deskIdle: a phone write waits this long after the last input at the desk
// (tmux client_activity: keys, mouse, focus) so it never lands in the middle
// of someone typing there. 30 s blocked the phone for half a minute after
// merely answering a prompt at the desk; the phone now counts down and
// resends on its own ("retry in Ns").
const deskIdle = 10 * time.Second

type attentionEntry struct {
	SessionID      string `json:"session_id"`
	TmuxSocket     string `json:"tmux_socket"`
	TmuxSession    string `json:"tmux_session"`
	TmuxPane       string `json:"tmux_pane"`
	Status         string `json:"status"`
	WaitingKind    string `json:"waiting_kind"`
	Reason         string `json:"reason"`
	GitBranch      string `json:"git_branch"`
	TS             int64  `json:"ts"`
	LastUserPrompt string `json:"last_user_prompt"`
	AgentName      string `json:"agent_name"`
	WindowName     string `json:"tmux_window_name"`
	// running_kind=background: the turn ended but harness background tasks
	// (bg.tasks) are still alive — the TUI takes input (agent-attention.md
	// "Background running substate").
	RunningKind string `json:"running_kind"`
	// when this turn began / the compaction started (ms; emit.sh +
	// attention-state-lib.sh): the phone counts elapsed time from them
	// set on a session listed in place of an archived one whose pane was
	// cleared (/new, /clear): the id it replaced (liveSessions)
	ReplacedFrom   string `json:"-"`
	TurnStarted    int64  `json:"turn_started"`
	CompactStarted int64  `json:"compact_started"`
	Bg             struct {
		Tasks []bgTask `json:"tasks"`
	} `json:"bg"`
}

type bgTask struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Summary string `json:"summary"`
}

// busy: the agent is mid-turn (not just waiting on background tasks).
func (e attentionEntry) busy() bool {
	return e.Status == "running" && e.RunningKind != "background"
}

func attentionFile() string {
	if p := os.Getenv("WEZDECK_ATTENTION_FILE"); p != "" {
		return p
	}
	matches, _ := filepath.Glob("/mnt/c/Users/*/AppData/Local/wezterm-runtime/state/agent-attention/attention.json")
	if len(matches) > 0 {
		return matches[0]
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local/state/wezterm-runtime/state/agent-attention/attention.json")
}

type recentEntry struct {
	attentionEntry
	LastStatus string `json:"last_status"`
	ArchivedTS int64  `json:"archived_ts"`
}

func readAttentionDoc() (map[string]attentionEntry, []recentEntry, error) {
	data, err := os.ReadFile(attentionFile())
	if err != nil {
		return nil, nil, err
	}
	var doc struct {
		Entries map[string]attentionEntry `json:"entries"`
		Recent  []recentEntry             `json:"recent"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, nil, err
	}
	return doc.Entries, doc.Recent, nil
}

// agentCommands: what an agent TUI pane runs (pane_current_command).
var agentCommands = map[string]bool{"claude": true, "codex": true, "grok": true, "grok.real": true}

// isAgentPane: true when the pane still hosts an agent TUI. Grok is started
// under grok-focus-filter.py, so pane_current_command is often "python3"
// while grok.real is the child — accept that when the session id (or
// agent_name) is known to be Grok, so archived Grok panes stay on the
// phone's 会话 list instead of vanishing until the next message.
func isAgentPane(cmd string, e attentionEntry) bool {
	if agentCommands[cmd] {
		return true
	}
	if cmd != "python3" {
		return false
	}
	if strings.EqualFold(e.AgentName, "grok") {
		return true
	}
	if _, agent := findTranscript(e.SessionID); agent == "grok" {
		return true
	}
	return false
}

// liveSessions merges the live entries with archived ones (recent[]) whose
// pane still runs an agent: an acknowledged or idle-for-30-min session drops
// out of .entries but is still open and takes input. Archived ones get
// status "idle"; per pane only the newest session id counts (/clear makes a
// new one).
func liveSessions() (map[string]attentionEntry, error) {
	entries, recent, err := readAttentionDoc()
	if err != nil {
		return nil, err
	}
	out := map[string]attentionEntry{}
	panes := map[string]bool{}
	for id, e := range entries {
		out[id] = e
		panes[e.TmuxSocket+"|"+e.TmuxPane] = true
	}
	sort.Slice(recent, func(i, j int) bool { return recent[i].ArchivedTS > recent[j].ArchivedTS })
	for _, r := range recent {
		key := r.TmuxSocket + "|" + r.TmuxPane
		if r.SessionID == "" || r.TmuxPane == "" || panes[key] {
			continue
		}
		panes[key] = true
		_, _, cmd, _, alive := paneState(r.attentionEntry)
		if !alive || !isAgentPane(cmd, r.attentionEntry) {
			continue
		}
		e := r.attentionEntry
		e.Status = "idle"
		e.WaitingKind = ""
		e.RunningKind = ""
		e.TS = r.ArchivedTS
		// /new or /clear in this pane: the hook archived the old session and
		// pinned the new one to the pane, which has no entry until its first
		// prompt. List the new session in its place (idle, empty, sendable)
		// so the phone can follow it; the old id answers replaced_by.
		if pin := panePinnedSession(r.attentionEntry); pin != "" && pin != r.SessionID {
			if _, taken := out[pin]; !taken {
				e.ReplacedFrom = r.SessionID
				e.SessionID = pin
				e.LastUserPrompt = ""
				e.AgentName = ""
				out[pin] = e
			}
			continue
		}
		out[r.SessionID] = e
	}
	return out, nil
}

// panePinnedSession: the session the pane is pinned to (tmux pane option
// @wezterm_agent_session_id, set by the SessionStart clear hook —
// agent-session-resolve.sh agent_session_pin_pane), "" when none.
func panePinnedSession(e attentionEntry) string {
	out, err := tmuxCmd(e.TmuxSocket, "display-message", "-p", "-t", e.TmuxPane,
		"#{@wezterm_agent_session_id}").Output()
	if err != nil {
		return ""
	}
	pin := strings.TrimSpace(string(out))
	if !sessionIDPattern.MatchString(pin) {
		return ""
	}
	return pin
}

func tmuxCmd(socket string, args ...string) *exec.Cmd {
	full := args
	if socket != "" {
		full = append([]string{"-S", socket}, args...)
	}
	return exec.Command("tmux", full...)
}

// paneState: the pane's id, cwd, current command, index, and whether it exists.
func paneState(e attentionEntry) (id, cwd, cmd string, index int, alive bool) {
	out, err := tmuxCmd(e.TmuxSocket, "display-message", "-p", "-t", e.TmuxPane,
		"#{pane_id}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_index}").Output()
	if err != nil {
		return "", "", "", 0, false
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), "\t", 4)
	if len(parts) != 4 || parts[0] != e.TmuxPane {
		return "", "", "", 0, false
	}
	index, _ = strconv.Atoi(parts[3])
	return parts[0], parts[1], parts[2], index, true
}

// windowActivity: last output in the session's tmux window (unix ms), 0 if unknown.
func windowActivity(e attentionEntry) int64 {
	out, err := tmuxCmd(e.TmuxSocket, "display-message", "-p", "-t", e.TmuxPane, "#{window_activity}").Output()
	if err != nil {
		return 0
	}
	v, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return 0
	}
	return v * 1000
}

// paneInfo: cwd and whether the pane still exists.
func paneInfo(e attentionEntry) (cwd string, alive bool) {
	_, cwd, _, _, alive = paneState(e)
	return cwd, alive
}

// gitRepoMeta: repo family label + main checkout root + this worktree path.
// Soft-fails fast so listSessions stays snappy when git is missing or slow.
func gitRepoMeta(cwd string) (repo, repoRoot, worktree string) {
	worktree = cwd
	if cwd == "" {
		return "", "", ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", cwd, "rev-parse", "--show-toplevel", "--git-common-dir").Output()
	if err != nil {
		return filepath.Base(cwd), "", cwd
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) == 0 || lines[0] == "" {
		return filepath.Base(cwd), "", cwd
	}
	worktree = lines[0]
	repo = filepath.Base(worktree)
	if len(lines) < 2 || lines[1] == "" {
		return repo, worktree, worktree
	}
	common := lines[1]
	if !filepath.IsAbs(common) {
		common = filepath.Clean(filepath.Join(cwd, common))
	}
	repoRoot = mainWorktreeFromGitCommon(common)
	if repoRoot == "" {
		repoRoot = worktree
	} else {
		repo = filepath.Base(repoRoot)
	}
	return repo, repoRoot, worktree
}

// mainWorktreeFromGitCommon turns git-common-dir into the primary checkout path.
func mainWorktreeFromGitCommon(common string) string {
	clean := filepath.Clean(common)
	const marker = string(filepath.Separator) + ".git" + string(filepath.Separator) + "worktrees" + string(filepath.Separator)
	if i := strings.Index(clean, marker); i >= 0 {
		return clean[:i]
	}
	if filepath.Base(clean) == ".git" {
		return filepath.Dir(clean)
	}
	return ""
}

func paneRole(index int) string {
	if index <= 1 {
		return "primary"
	}
	return "secondary"
}

// deskActivity: newest keyboard activity of any client attached to the
// session (unix seconds), 0 when none is attached.
func deskActivity(e attentionEntry) int64 {
	out, err := tmuxCmd(e.TmuxSocket, "list-clients", "-t", e.TmuxSession, "-F", "#{client_activity}").Output()
	if err != nil {
		return 0
	}
	var newest int64
	for _, line := range strings.Fields(string(out)) {
		if v, err := strconv.ParseInt(line, 10, 64); err == nil && v > newest {
			newest = v
		}
	}
	return newest
}

type sessionCard struct {
	ID          string   `json:"id"`
	Agent       string   `json:"agent"`
	Name        string   `json:"name"`
	Title       string   `json:"title,omitempty"` // auto /rename title when known
	Window      string   `json:"window"`
	Cwd         string   `json:"cwd"`
	Branch      string   `json:"branch"`
	Status      string   `json:"status"`
	WaitingKind string   `json:"waiting_kind,omitempty"`
	LastPrompt  string   `json:"last_prompt"`
	TS          int64    `json:"ts"`
	Transcript  bool     `json:"transcript"`
	DeskIdleS   int64    `json:"desk_idle_s"`
	RunningKind string   `json:"running_kind,omitempty"`
	Background  []bgTask `json:"background"`
	// Tree grouping (repo family → worktree → pane). tmux fields are optional
	// mount info so ticket agents on the same worktree can join later.
	Repo        string `json:"repo,omitempty"`
	RepoLabel   string `json:"repo_label,omitempty"` // Repo through WEZDECK_REPO_ALIASES (repo_alias.go)
	RepoRoot    string `json:"repo_root,omitempty"`
	Worktree    string `json:"worktree,omitempty"`
	TmuxSession string `json:"tmux_session,omitempty"`
	TmuxPane    string `json:"tmux_pane,omitempty"`
	PaneIndex   int    `json:"pane_index,omitempty"`
	PaneRole    string `json:"pane_role,omitempty"` // primary | secondary
	// Visited: when you last visited this worktree at the desk (ms, access
	// ledger, session_visits.go); the phone sorts by it, not by output
	Visited int64 `json:"visited,omitempty"`
}

var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

func listSessions() (any, error) {
	entries, err := liveSessions()
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	cards := []sessionCard{}
	gitCache := map[string][3]string{} // cwd → repo, repoRoot, worktree
	visits := worktreeVisits()
	aliases := parseRepoAliases(repoAliasSpec())
	for id, e := range entries {
		if e.TmuxPane == "" {
			continue
		}
		_, cwd, _, index, alive := paneState(e)
		if !alive {
			continue
		}
		card := sessionCard{ID: id, Name: e.AgentName, Window: e.WindowName, Cwd: cwd, Branch: e.GitBranch,
			Status: e.Status, WaitingKind: e.WaitingKind, LastPrompt: e.LastUserPrompt, TS: e.TS, Agent: "agent",
			RunningKind: e.RunningKind, Background: backgroundOf(e),
			TmuxSession: e.TmuxSession, TmuxPane: e.TmuxPane, PaneIndex: index, PaneRole: paneRole(index)}
		if meta, ok := gitCache[cwd]; ok {
			card.Repo, card.RepoRoot, card.Worktree = meta[0], meta[1], meta[2]
		} else {
			repo, root, wt := gitRepoMeta(cwd)
			gitCache[cwd] = [3]string{repo, root, wt}
			card.Repo, card.RepoRoot, card.Worktree = repo, root, wt
		}
		if label := aliases[card.Repo]; label != "" {
			card.RepoLabel = label
		}
		card.Visited = visitOf(visits, card.Worktree, cwd)
		// Activity = when the conversation last moved: the newest turn in the
		// transcript (remote_activity.go); the status ts (bumped for
		// background-only sessions) and tmux window_activity (any pane in the
		// window, TUI redraws) would reorder idle sessions, so they are only
		// the fallback for agents without a transcript.
		if path, agent := findTranscript(e.SessionID); path != "" {
			card.Agent = agent
			card.Transcript = true
			card.Title = readSessionTitle(path, agent)
			// the newest turn's own timestamp; mtime only for formats
			// without one (remote_activity.go: Claude touches idle files)
			if at := lastTurnAt(path, agent); at > 0 {
				card.TS = at
			} else if info, err := os.Stat(path); err == nil {
				card.TS = info.ModTime().UnixMilli()
			}
		} else if act := windowActivity(e); act > card.TS {
			card.TS = act
		}
		if act := deskActivity(e); act > 0 {
			card.DeskIdleS = now - act
		} else {
			card.DeskIdleS = -1
		}
		cards = append(cards, card)
	}
	// newest conversation activity first
	sort.Slice(cards, func(i, j int) bool { return cards[i].TS > cards[j].TS })
	return map[string]any{"v": 1, "ok": true, "sessions": cards}, nil
}

func backgroundOf(e attentionEntry) []bgTask {
	if e.RunningKind != "background" || e.Bg.Tasks == nil {
		return []bgTask{}
	}
	out := make([]bgTask, 0, len(e.Bg.Tasks))
	for _, t := range e.Bg.Tasks {
		out = append(out, bgTask{ID: t.ID, Type: t.Type, Summary: clip(t.Summary, 120)})
	}
	return out
}

type chatMessage struct {
	Role   string `json:"role"` // user | assistant | tool | system (Kind "compact": context compaction marker, Body = summary)
	Text   string `json:"text"`
	TS     string `json:"ts,omitempty"`
	Tool   string `json:"tool,omitempty"`   // tool name (role=tool)
	Body   string `json:"body,omitempty"`   // what the tool was asked to do: diff, file preview, command
	Result string `json:"result,omitempty"` // what came back (clipped)
	// Pending: the call has gone out and no result came back yet (the phone
	// shows it as running while the session is busy)
	Pending bool `json:"pending,omitempty"`
	// Kind: the shared tool kind (agent_adapter.go toolKind*), so the phone
	// summarises a run without knowing each agent's tool names.
	Kind string `json:"kind,omitempty"`
	// File / Added / Removed: what a file tool touched, counted on the full
	// input (Body is clipped for the phone).
	File    string `json:"file,omitempty"`
	Added   int    `json:"added,omitempty"`
	Removed int    `json:"removed,omitempty"`
	// Images: refs ("<line byte offset>.<nth image in that line>") to images
	// embedded base64 in the transcript — pasted at the desk, or returned by a
	// tool; the phone fetches them with session.image (remote_image.go).
	Images []string `json:"images,omitempty"`
}

func lineCount(s string) int {
	if s == "" {
		return 0
	}
	return strings.Count(strings.TrimRight(s, "\n"), "\n") + 1
}

func inputString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func toolFile(input map[string]any) string {
	return inputString(input, "file_path", "target_file", "path", "filename")
}

func editPairs(input map[string]any) [][2]string {
	if o, n := inputString(input, "old_string", "old_str"), inputString(input, "new_string", "new_str"); o != "" || n != "" {
		return [][2]string{{o, n}}
	}
	var out [][2]string
	edits, _ := input["edits"].([]any)
	for _, e := range edits {
		m, _ := e.(map[string]any)
		out = append(out, [2]string{inputString(m, "old_string", "old_str"), inputString(m, "new_string", "new_str")})
	}
	return out
}

// writes: a whole-file write (Claude Write, Grok write/create_file, …).
func writeContent(name string, input map[string]any) (string, bool) {
	content := inputString(input, "content", "contents", "file_text")
	lower := strings.ToLower(name)
	if content == "" || toolFile(input) == "" || !(strings.Contains(lower, "write") || strings.Contains(lower, "create")) {
		return "", false
	}
	return content, true
}

// toolStats: file and changed-line counts, judged by the input's shape so
// Claude, Grok and Codex tools count alike (old/new strings = edit,
// content + write/create = whole-file write).
func toolStats(name string, input map[string]any) (file string, added, removed int) {
	file = toolFile(input)
	if pairs := editPairs(input); len(pairs) > 0 && file != "" {
		for _, p := range pairs {
			removed += lineCount(p[0])
			added += lineCount(p[1])
		}
		return file, added, removed
	}
	if content, ok := writeContent(name, input); ok {
		return file, lineCount(content), 0
	}
	return file, 0, 0
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

func clipLines(s string, lines int) string {
	parts := strings.Split(s, "\n")
	if len(parts) <= lines {
		return s
	}
	return strings.Join(parts[:lines], "\n") + fmt.Sprintf("\n… (+%d lines)", len(parts)-lines)
}

// toolBody: the part of a tool call a reviewer wants to see on a phone.
func toolBody(name string, input map[string]any) string {
	diff := func(oldText, newText string) string {
		var b strings.Builder
		for _, l := range strings.Split(oldText, "\n") {
			b.WriteString("- " + l + "\n")
		}
		for _, l := range strings.Split(newText, "\n") {
			b.WriteString("+ " + l + "\n")
		}
		return strings.TrimRight(b.String(), "\n")
	}
	if pairs := editPairs(input); len(pairs) > 0 {
		var parts []string
		for _, p := range pairs {
			parts = append(parts, diff(p[0], p[1]))
		}
		return clipLines(strings.Join(parts, "\n…\n"), 120)
	}
	if content, ok := writeContent(name, input); ok {
		return clipLines(content, 40)
	}
	if cmd := inputString(input, "command", "cmd"); cmd != "" {
		return clip(cmd, 2000)
	}
	if list, ok := input["command"].([]any); ok { // codex shell: ["bash","-lc","…"]
		var words []string
		for _, w := range list {
			if v, ok := w.(string); ok {
				words = append(words, v)
			}
		}
		return clip(strings.Join(words, " "), 2000)
	}
	return ""
}

func toolSummary(name string, input map[string]any) string {
	if v := inputString(input, "file_path", "target_file", "path", "description", "command", "cmd", "pattern", "query", "url", "prompt"); v != "" {
		return clip(name+" "+v, 160)
	}
	return name
}

// transcript: a session file (Claude / Grok / Codex) parsed incrementally — only bytes
// appended since the last read are parsed, so a 30 MB transcript is read
// once and each poll costs the new lines.
type transcript struct {
	format   string // claude | grok | codex
	offset   int64
	size     int64
	messages []chatMessage
	tools    map[string]int // tool_use_id → index in messages
	agents   map[string]int // Claude subagent id → its Agent call's index (hand-back reports)
	usage    sessionUsage
	lastMsg  string       // message id whose usage was counted (one reply spans several lines)
	outputs  []outputMark // per reply: when, how many output tokens (turnOutput)
	lineOff  int64        // file offset of the line being fed
}

// markCompact appends a context-compaction marker (role system, kind compact;
// Text = what triggered it: auto | manual).
func (t *transcript) markCompact(trigger, ts string) {
	if trigger == "" {
		trigger = "auto"
	}
	t.messages = append(t.messages, chatMessage{Role: "system", Kind: "compact", Text: trigger, TS: ts})
}

// attachCompactSummary puts the summary the agent continues from on the
// latest compact marker (it follows the boundary line).
func (t *transcript) attachCompactSummary(summary string) {
	for i := len(t.messages) - 1; i >= 0; i-- {
		if t.messages[i].Kind == "compact" {
			if t.messages[i].Body == "" {
				t.messages[i].Body = clip(summary, 6000)
			}
			return
		}
	}
}

// compactions: how many times the context was compacted and the index of the
// latest marker (-1 when never).
func (t *transcript) compactions() (count, last int) {
	last = -1
	for i, m := range t.messages {
		if m.Kind == "compact" {
			count++
			last = i
		}
	}
	return count, last
}

// sessionUsage: what the session has spent, from each reply's `usage`.
// Context = the last reply's full input (fresh + cache read + cache write).
type sessionUsage struct {
	Model        string `json:"model,omitempty"`
	Context      int    `json:"context"`
	ContextLimit int    `json:"context_limit"`
	Turns        int    `json:"turns"`
	Output       int    `json:"output"`
	Input        int    `json:"input"`      // fresh + cache write
	CacheRead    int    `json:"cache_read"` // served from cache
}

var (
	transcriptsMu sync.Mutex
	transcripts   = map[string]*transcript{}
)

func (t *transcript) feed(data []byte) {
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 1<<20), 64<<20)
	adapter := adapterFor(t.format)
	if adapter == nil {
		adapter = claudeAdapter{}
	}
	// lineOff: where the line being fed starts in the file (image refs)
	t.lineOff = t.offset
	for scanner.Scan() {
		line := scanner.Bytes()
		adapter.Feed(t, line)
		t.lineOff += int64(len(line)) + 1
	}
}

// toolKind asks this transcript's adapter for the shared kind of a tool call.
func (t *transcript) toolKind(name string, input map[string]any) string {
	if a := adapterFor(t.format); a != nil {
		return a.ToolKind(name, input)
	}
	return toolKindByName(nil, name, input)
}

func (t *transcript) addTool(id, name, argsJSON, ts string) {
	var input map[string]any
	if json.Unmarshal([]byte(argsJSON), &input) != nil {
		input = map[string]any{"command": argsJSON}
	}
	file, added, removed := toolStats(name, input)
	t.messages = append(t.messages, chatMessage{Role: "tool", Tool: name, Text: toolSummary(name, input),
		Body: toolBody(name, input), TS: ts, File: file, Added: added, Removed: removed,
		Kind: t.toolKind(name, input)})
	if id != "" {
		t.tools[id] = len(t.messages) - 1
		t.messages[len(t.messages)-1].Pending = true
	}
}

func (t *transcript) setResult(id, out string) {
	if idx, ok := t.tools[id]; ok {
		t.messages[idx].Result = clipLines(clip(out, 3000), 40)
		t.messages[idx].Pending = false
		delete(t.tools, id)
	}
}

// userText: what the person typed; harness-injected context (<user_info>,
// <system-reminder>…) is dropped, a <user_query> wrapper is unwrapped.
func userText(text string) string {
	if i := strings.Index(text, "<user_query>"); i >= 0 {
		rest := text[i+len("<user_query>"):]
		if j := strings.Index(rest, "</user_query>"); j >= 0 {
			rest = rest[:j]
		}
		return strings.TrimSpace(rest)
	}
	if strings.HasPrefix(strings.TrimSpace(text), "<") {
		return ""
	}
	return text
}

// loadTranscript returns the parsed transcript, reading only what was
// appended since last time (a shrunk file is re-read from the start).
func loadTranscript(path, format string) (*transcript, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	transcriptsMu.Lock()
	defer transcriptsMu.Unlock()
	t := transcripts[path]
	if t == nil || info.Size() < t.size {
		t = &transcript{format: format, tools: map[string]int{}}
		transcripts[path] = t
	}
	if info.Size() == t.offset {
		return t, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, info.Size()-t.offset)
	n, err := f.ReadAt(buf, t.offset)
	if err != nil && n == 0 {
		return nil, err
	}
	buf = buf[:n]
	end := bytes.LastIndexByte(buf, '\n')
	if end < 0 {
		return t, nil // partial line: wait for the rest
	}
	t.feed(buf[:end+1])
	t.offset += int64(end + 1)
	t.size = info.Size()
	return t, nil
}

// parseClaudeTranscript parses a whole transcript (tests and one-off use).
func parseClaudeTranscript(data []byte, limit int) []chatMessage {
	t := &transcript{format: "claude", tools: map[string]int{}}
	t.feed(data)
	if len(t.messages) > limit {
		return t.messages[len(t.messages)-limit:]
	}
	return t.messages
}

func sessionDetail(args json.RawMessage) (any, error) {
	var a sessionArgs
	if json.Unmarshal(args, &a) != nil || !sessionIDPattern.MatchString(a.ID) {
		return nil, errors.New("invalid session id")
	}
	if a.Limit <= 0 {
		a.Limit = 60
	}
	if a.Limit > 5000 {
		a.Limit = 5000
	}
	entries, err := liveSessions()
	if err != nil {
		return nil, err
	}
	e, ok := entries[a.ID]
	if !ok {
		// cleared in its pane (/new, /clear): point the page at the session
		// that took its place
		for id, other := range entries {
			if other.ReplacedFrom == a.ID {
				return map[string]any{"v": 1, "ok": true, "id": a.ID, "replaced_by": id, "status": "idle"}, nil
			}
		}
		return nil, errors.New("session not found (ended or not tracked)")
	}
	out := map[string]any{"v": 1, "ok": true, "id": a.ID, "status": e.Status, "waiting_kind": e.WaitingKind,
		"running_kind": e.RunningKind, "background": backgroundOf(e), "agent": "agent",
		"name": e.AgentName, "window": e.WindowName, "branch": e.GitBranch}
	// mid-turn progress from hooks, not the screen: when the turn / the
	// compaction began (the phone ticks the elapsed time itself)
	if e.Status == "running" || e.Status == "waiting" {
		if e.TurnStarted > 0 {
			out["turn_started"] = e.TurnStarted
		}
		if e.RunningKind == "compacting" && e.CompactStarted > 0 {
			out["compact_started"] = e.CompactStarted
		}
	}
	path, agent := findTranscript(e.SessionID)
	out["reference"] = sessionReference(e, path, agent)
	out["meta"] = sessionMeta(e, path, agent, nil)
	if path != "" {
		out["agent"] = agent
		if title := readSessionTitle(path, agent); title != "" {
			out["title"] = title
		}
		if agent == "grok" {
			// Prefer disk truth: an unanswered Ask may outlive a flaky waiting flag.
			if el := pendingGrokElicitation(path); el != nil {
				out["elicitation"] = el
			}
			plan := map[string]any{}
			if excerpt := grokPlanExcerpt(path, 2500); excerpt != "" {
				plan["excerpt"] = excerpt
			}
			if pendingGrokPlanApproval(path) {
				plan["awaiting_approval"] = true
			}
			if len(plan) > 0 {
				out["plan"] = plan
			}
		}
		t, err := loadTranscript(path, agent)
		if err != nil {
			return nil, err
		}
		out["meta"] = sessionMeta(e, path, agent, t)
		transcriptsMu.Lock()
		total := len(t.messages)
		start, end, span := sessionWindow(t.messages, a)
		out["messages"] = append([]chatMessage(nil), t.messages[start:end]...)
		compactions, lastCompact := t.compactions()
		if e.TurnStarted > 0 && (e.Status == "running" || e.Status == "waiting") {
			out["turn_output"] = t.turnOutput(e.TurnStarted)
		}
		transcriptsMu.Unlock()
		out["total"] = total
		out["start"] = start
		out["span"] = span
		if compactions > 0 {
			// the phone pages back to here by default; earlier is pre-compaction history
			out["compacted_at"] = lastCompact
			out["compactions"] = compactions
		}
		usage := t.usage
		if usage.ContextLimit == 0 {
			usage.ContextLimit = contextLimit(usage.Model)
		}
		out["usage"] = usage
		if a := adapterFor(agent); a != nil {
			out["capabilities"] = a.Capabilities()
		}
		if agent == "claude" {
			// what its subagents (Agent tool, forked skills) are doing
			out["subagents"] = subagentsOf(path)
		}
		if agent == "claude" {
			if size := claudeContextSize(e.SessionID); size > 0 {
				usage.ContextLimit = size
				out["usage"] = usage
			}
			if limits := claudeAccountLimits(); limits != nil {
				out["account"] = limits
			}
		}
	}
	screen, err := tmuxCmd(e.TmuxSocket, "capture-pane", "-p", "-J", "-t", e.TmuxPane, "-S", "-60").Output()
	if err == nil {
		out["screen"] = strings.TrimRight(string(screen), "\n ")
	}
	if agent == "claude" && path != "" {
		if el := pendingClaudeElicitation(path); el != nil {
			el.Review = askReviewing(string(screen))
			out["elicitation"] = el
		}
	}
	return out, nil
}

// ------------------------------------------------------------- device keys

type deviceRecord struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	PublicKey string `json:"public_key"` // base64url, uncompressed P-256 point
	At        string `json:"at"`
}

type deviceStore struct {
	Approved []deviceRecord `json:"approved"`
	Pending  []deviceRecord `json:"pending"`
}

var deviceMu sync.Mutex

func deviceFile() string {
	if p := os.Getenv("WEZDECK_REMOTE_DEVICES"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "wezdeck", "remote-devices.json")
}

func loadDevices() deviceStore {
	var s deviceStore
	if data, err := os.ReadFile(deviceFile()); err == nil {
		_ = json.Unmarshal(data, &s)
	}
	return s
}

// lockDevices takes the cross-process lock on the device store. The relay
// (register) and install-remote-relay.sh (--approve / --revoke) both
// read-modify-write the file; without a shared lock a register racing a
// revoke could write the revoked device back as approved.
func lockDevices() (unlock func()) {
	path := deviceFile() + ".lock"
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return func() {}
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_EX)
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		f.Close()
	}
}

// printable drops control characters (ESC, CR, BEL …): a device name is
// attacker-chosen and is printed in the owner's terminal by --devices.
func printable(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '\u2028' || r == '\u2029' {
			return -1
		}
		return r
	}, s)
}

func saveDevices(s deviceStore) error {
	// empty lists stay [] (not null) so other readers can iterate them
	if s.Approved == nil {
		s.Approved = []deviceRecord{}
	}
	if s.Pending == nil {
		s.Pending = []deviceRecord{}
	}
	_ = os.MkdirAll(filepath.Dir(deviceFile()), 0o700)
	data, _ := json.MarshalIndent(s, "", "  ")
	// write-then-rename: a reader never sees a half-written store
	tmp := deviceFile() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, deviceFile())
}

func deviceID(pub []byte) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:8])
}

func parsePublicKey(b64 string) (*ecdsa.PublicKey, []byte, error) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(b64, "="))
	if err != nil || len(raw) != 65 || raw[0] != 4 {
		return nil, nil, errors.New("public key must be an uncompressed P-256 point")
	}
	x := new(big.Int).SetBytes(raw[1:33])
	y := new(big.Int).SetBytes(raw[33:])
	if !elliptic.P256().IsOnCurve(x, y) {
		return nil, nil, errors.New("public key is not on P-256")
	}
	return &ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, raw, nil
}

// registerDevice records a pending key; approval happens on the host
// (install-remote-relay.sh --approve).
func registerDevice(args json.RawMessage) (any, error) {
	var a struct {
		PublicKey string `json:"public_key"`
		Name      string `json:"name"`
	}
	if json.Unmarshal(args, &a) != nil {
		return nil, errors.New("invalid payload")
	}
	_, raw, err := parsePublicKey(a.PublicKey)
	if err != nil {
		return nil, err
	}
	id := deviceID(raw)
	deviceMu.Lock()
	defer deviceMu.Unlock()
	defer lockDevices()()
	s := loadDevices()
	for _, d := range s.Approved {
		if d.ID == id {
			return map[string]any{"v": 1, "ok": true, "id": id, "state": "approved"}, nil
		}
	}
	for _, d := range s.Pending {
		if d.ID == id {
			return map[string]any{"v": 1, "ok": true, "id": id, "state": "pending"}, nil
		}
	}
	if len(s.Pending) >= 5 {
		s.Pending = s.Pending[1:]
	}
	s.Pending = append(s.Pending, deviceRecord{ID: id, Name: clip(printable(a.Name), 40), PublicKey: a.PublicKey, At: time.Now().Format(time.RFC3339)})
	if err := saveDevices(s); err != nil {
		return nil, err
	}
	return map[string]any{"v": 1, "ok": true, "id": id, "state": "pending"}, nil
}

var (
	nonceMu   sync.Mutex
	nonceSeen = map[string]time.Time{}
)

type signedWrite struct {
	Action string          `json:"action"`
	Args   json.RawMessage `json:"args"`
	TS     int64           `json:"ts"`
	Nonce  string          `json:"nonce"`
}

// verifyWrite checks the frame's signature over its exact payload text and
// returns the signed action and args (unsigned frame fields are ignored).
func verifyWrite(frameAction string, args json.RawMessage) (*signedWrite, string, error) {
	var env struct {
		Device  string `json:"device"`
		Payload string `json:"payload"`
		Sig     string `json:"sig"`
	}
	if json.Unmarshal(args, &env) != nil || env.Payload == "" || env.Sig == "" {
		return nil, "", errors.New("write is not signed: enable writing on this device first")
	}
	s := loadDevices()
	var pub *ecdsa.PublicKey
	for _, d := range s.Approved {
		if d.ID == env.Device {
			pub, _, _ = parsePublicKey(d.PublicKey)
		}
	}
	if pub == nil {
		return nil, "", errors.New("device not approved: run install-remote-relay.sh --approve on the host")
	}
	sig, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(env.Sig, "="))
	if err != nil || len(sig) != 64 {
		return nil, "", errors.New("bad signature encoding")
	}
	digest := sha256.Sum256([]byte(env.Payload))
	if !ecdsa.Verify(pub, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		return nil, "", errors.New("signature does not verify")
	}
	var w signedWrite
	if json.Unmarshal([]byte(env.Payload), &w) != nil || w.Action != frameAction {
		return nil, "", errors.New("signed payload does not match the request")
	}
	skew := time.Since(time.UnixMilli(w.TS))
	if skew > 2*time.Minute || skew < -2*time.Minute {
		return nil, "", errors.New("request expired: check the phone's clock")
	}
	nonceMu.Lock()
	defer nonceMu.Unlock()
	loadNonces()
	for k, at := range nonceSeen {
		if time.Since(at) > 5*time.Minute {
			delete(nonceSeen, k)
		}
	}
	if _, dup := nonceSeen[w.Nonce]; dup || w.Nonce == "" {
		return nil, "", errors.New("replayed request")
	}
	nonceSeen[w.Nonce] = time.Now()
	saveNonces()
	return &w, env.Device, nil
}

// ----------------------------------------------------------------- writes

func guardSession(id string) (attentionEntry, error) {
	if !sessionIDPattern.MatchString(id) {
		return attentionEntry{}, errors.New("invalid session id")
	}
	entries, err := liveSessions()
	if err != nil {
		return attentionEntry{}, err
	}
	e, ok := entries[id]
	if !ok {
		return attentionEntry{}, errors.New("session not found (ended or not tracked)")
	}
	if _, alive := paneInfo(e); !alive {
		return attentionEntry{}, errors.New("the session's tmux pane is gone")
	}
	if act := deskActivity(e); act > 0 && time.Since(time.Unix(act, 0)) < deskIdle {
		ago := time.Since(time.Unix(act, 0))
		// "retry in Ns" is parsed by the phone, which counts down and resends
		return attentionEntry{}, fmt.Errorf("someone typed at the desk %ds ago; retry in %ds",
			int(ago.Seconds()), int((deskIdle-ago).Seconds())+1)
	}
	return e, nil
}

func sendToSession(args json.RawMessage) (any, error) {
	var a struct {
		ID          string   `json:"id"`
		Text        string   `json:"text"`
		Attachments []string `json:"attachments"`
	}
	if json.Unmarshal(args, &a) != nil || len(a.Text) > 20000 ||
		(strings.TrimSpace(a.Text) == "" && len(a.Attachments) == 0) {
		return nil, errors.New("message must be 1–20000 characters")
	}
	note, err := attachmentNote(a.Attachments)
	if err != nil {
		return nil, err
	}
	if note != "" {
		a.Text = strings.TrimSpace(strings.TrimSpace(a.Text) + "\n\n" + note)
	}
	e, err := guardSession(a.ID)
	if err != nil {
		return nil, err
	}
	// No busy guard: every agent TUI we host takes input mid-turn. Claude Code
	// queues it and schedules it itself, Grok queues a follow-up for after the
	// turn (`[ui].follow_up_behavior`, default "queue"), Codex steers the
	// active turn with it. Only a pending confirmation blocks free text.
	if e.WaitingKind != "" {
		return nil, errors.New("the agent is asking for a confirmation; answer it with the keys first")
	}
	if err := pasteToPane(e.TmuxSocket, e.TmuxPane, a.Text); err != nil {
		return nil, err
	}
	_ = tmuxCmd(e.TmuxSocket, "display-message", "-d", "4000", "-t", e.TmuxPane, "手机发来一条消息").Run()
	return map[string]any{"v": 1, "ok": true, "sent": len([]rune(a.Text))}, nil
}

// pasteToPane pastes text into a pane as one bracketed paste, then Enter —
// how the phone's messages reach an agent TUI (also a new session's first
// message, session_new.go).
func pasteToPane(socket, pane, text string) error {
	text = pasteSafe(text)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// one buffer per send: two sends in flight (two tabs, two sessions) used
	// to share "wezdeck-remote", so load(X) load(Y) paste→X could put Y's text
	// into X's pane
	buffer := "wezdeck-remote-" + newDiagID()
	load := exec.CommandContext(ctx, "tmux")
	if socket != "" {
		load.Args = append(load.Args, "-S", socket)
	}
	load.Args = append(load.Args, "load-buffer", "-b", buffer, "-")
	load.Stdin = strings.NewReader(text)
	if out, err := load.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux load-buffer: %s", strings.TrimSpace(string(out)))
	}
	if out, err := tmuxCmd(socket, "paste-buffer", "-p", "-d", "-b", buffer, "-t", pane).CombinedOutput(); err != nil {
		return fmt.Errorf("tmux paste-buffer: %s", strings.TrimSpace(string(out)))
	}
	time.Sleep(150 * time.Millisecond)
	if out, err := tmuxCmd(socket, "send-keys", "-t", pane, "Enter").CombinedOutput(); err != nil {
		return fmt.Errorf("tmux send-keys: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

func socketArgs(e attentionEntry) []string {
	if e.TmuxSocket == "" {
		return nil
	}
	return []string{"-S", e.TmuxSocket}
}

// Keys a phone may press: answer a permission / choice dialog, move in a
// picker, or interrupt (C-c — Grok and many TUIs only stop on Ctrl+C).
// Keys a phone may press: dialog digits, nav, interrupt, and Grok plan-review
// letters (a=approve, s=request changes, q=quit plan, y=copy — see Grok plan mode docs).
var allowedKeys = map[string]bool{
	"Enter": true, "Escape": true, "Up": true, "Down": true, "Tab": true,
	"1": true, "2": true, "3": true, "4": true, "C-c": true,
	"a": true, "s": true, "q": true, "y": true,
}

func keyToSession(args json.RawMessage) (any, error) {
	var a struct {
		ID  string `json:"id"`
		Key string `json:"key"`
	}
	if json.Unmarshal(args, &a) != nil || !allowedKeys[a.Key] {
		return nil, errors.New("key not allowed")
	}
	e, err := guardSession(a.ID)
	if err != nil {
		return nil, err
	}
	if out, err := tmuxCmd(e.TmuxSocket, "send-keys", "-t", e.TmuxPane, a.Key).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("tmux send-keys: %s", strings.TrimSpace(string(out)))
	}
	return map[string]any{"v": 1, "ok": true}, nil
}

var ticketIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,96}$`)

// replyTicket runs `ticket reply` as the phone's owner (via=mobile).
func replyTicket(args json.RawMessage) (any, error) {
	var a struct {
		ID       string `json:"id"`
		Text     string `json:"text"`
		Continue bool   `json:"continue"`
	}
	if json.Unmarshal(args, &a) != nil || !ticketIDPattern.MatchString(a.ID) || strings.TrimSpace(a.Text) == "" || len(a.Text) > 20000 {
		return nil, errors.New("invalid reply")
	}
	argv := []string{"reply", "--id", a.ID, "--decision", a.Text}
	if a.Continue {
		argv = append(argv, "--continue")
	}
	return runTicketCLI("ticket reply", argv)
}

// attachTicket opens the ticket's agent session in a tmux window of the
// target repo (`ticket attach`, skills/agent-collab/lib/attach.py): the
// escape hatch when a tappable answer is not enough.
func attachTicket(args json.RawMessage) (any, error) {
	var a struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(args, &a) != nil || !ticketIDPattern.MatchString(a.ID) {
		return nil, errors.New("invalid attach")
	}
	return runTicketCLI("ticket attach", []string{"attach", "--id", a.ID})
}

// runTicketCLI runs skills/agent-collab/ticket and returns its last JSON line.
func runTicketCLI(label string, args []string) (any, error) {
	argv := append([]string{filepath.Join(repoRoot(), "skills", "agent-collab", "ticket")}, args...)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = append(os.Environ(), "TICKET_TRIGGER_SOURCE=mobile")
	out, err := cmd.CombinedOutput()
	last := strings.TrimSpace(string(out))
	if i := strings.LastIndexByte(last, '\n'); i >= 0 {
		last = last[i+1:]
	}
	if err != nil {
		// attach prints {"ok":false,"error":…} on stdout; surface just the reason
		var failed struct {
			Error string `json:"error"`
		}
		if json.Unmarshal([]byte(last), &failed) == nil && failed.Error != "" {
			last = failed.Error
		}
		return nil, fmt.Errorf("%s: %s", label, clip(last, 300))
	}
	var result any
	if json.Unmarshal([]byte(last), &result) != nil {
		result = map[string]any{"v": 1, "ok": true}
	}
	return result, nil
}
