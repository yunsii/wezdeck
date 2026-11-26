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
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
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
	ReplacedFrom string `json:"-"`
	// set on a session listed from recent[]: the archived row it came from
	// (session id + archived_ts), which is how the desk's sessions/focus
	// finds it (sessionFocus)
	archivedID     string
	archivedTS     int64
	TurnStarted    int64 `json:"turn_started"`
	CompactStarted int64 `json:"compact_started"`
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
	// set by the SessionStart clear hook (/new, /clear): the session that
	// took this pane over (agent-attention/turn-lib.sh attention_mark_cleared)
	ClearedTo string `json:"cleared_to"`
}

// sessionFocus: the payload for the local Runtime's sessions/focus (the web
// console's 在终端中打开, this computer only) — the attention row that
// action looks up: the live entry, or the archived one by id + archived_ts
// (also for a session that took over a cleared pane, which has no row of its
// own yet).
//
// detached: no tmux client shows the session (a phone-started session made
// before open-task-window learned to join the repo's WezTerm session), so
// the jump would only raise WezTerm on some other pane — the page says so
// instead of claiming a switch.
func sessionFocus(id string, e attentionEntry) map[string]any {
	out := map[string]any{"session_id": id}
	if e.archivedID != "" {
		out = map[string]any{"session_id": e.archivedID, "recent": true, "archived_ts": e.archivedTS}
	}
	if e.TmuxSession != "" && !tmuxSessionAttached(e.TmuxSocket, e.TmuxSession) {
		out["detached"] = true
		out["tmux_session"] = e.TmuxSession
	}
	return out
}

// tmuxSessionAttached: a client shows the session; unknown (tmux failed)
// counts as attached so a hiccup never blocks the jump.
func tmuxSessionAttached(socket, session string) bool {
	out, err := tmuxCmd(socket, "display-message", "-p", "-t", "="+session+":", "#{session_attached}").Output()
	if err != nil {
		return true
	}
	return strings.TrimSpace(string(out)) != "0"
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
	return liveSessionsFrom(entries, recent), nil
}

func liveSessionsFrom(entries map[string]attentionEntry, recent []recentEntry) map[string]attentionEntry {
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
		if cmd != "codex" && archivedCodexTranscript(r) != "" {
			continue
		}
		e := r.attentionEntry
		e.Status = "idle"
		e.WaitingKind = ""
		e.RunningKind = ""
		e.TS = r.ArchivedTS
		e.archivedID, e.archivedTS = r.SessionID, r.ArchivedTS
		// /new or /clear in this pane: the hook archived the old session and
		// marked it cleared_to the new one, which has no entry until its
		// first prompt. List the new session in its place (idle, empty,
		// sendable) so the phone can follow; the old id answers replaced_by.
		if next := r.ClearedTo; sessionIDPattern.MatchString(next) && next != r.SessionID {
			if _, taken := out[next]; !taken {
				e.ReplacedFrom = r.SessionID
				e.SessionID = next
				e.LastUserPrompt = ""
				e.AgentName = ""
				out[next] = e
			}
			continue
		}
		out[r.SessionID] = e
	}
	return out
}

// replacementForArchived finds the live session that took over an archived
// session's pane. The attention hook normally records cleared_to, but a
// provider can start a new rollout without emitting that marker. In that
// case the pane identity is the reliable handoff signal.
func replacementForArchived(id string, recent []recentEntry, entries map[string]attentionEntry) string {
	for _, r := range recent {
		if r.SessionID != id || r.TmuxPane == "" {
			continue
		}
		for next, e := range entries {
			if next != id && e.TmuxPane == r.TmuxPane && e.TmuxSocket == r.TmuxSocket {
				return next
			}
		}
	}
	return ""
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
	if e.TmuxPane == "" {
		return "", "", "", 0, false
	}
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
	Repo      string `json:"repo,omitempty"`
	RepoLabel string `json:"repo_label,omitempty"` // Repo through WEZDECK_REPO_ALIASES (repo_alias.go)
	RepoRoot  string `json:"repo_root,omitempty"`
	Worktree  string `json:"worktree,omitempty"`
	// WorktreeDescription: the workstation's one-line purpose (git branch
	// description, worktree_description.go)
	WorktreeDescription string `json:"worktree_description,omitempty"`
	TmuxSession         string `json:"tmux_session,omitempty"`
	TmuxPane            string `json:"tmux_pane,omitempty"`
	PaneIndex           int    `json:"pane_index,omitempty"`
	PaneRole            string `json:"pane_role,omitempty"` // primary | secondary
	// Visited: when you last visited this worktree at the desk (ms, access
	// ledger, session_visits.go); the phone sorts by it, not by output
	Visited int64 `json:"visited,omitempty"`
}

var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

func listSessions() (any, error) {
	return listSessionsFor(false)
}

func listSessionsFor(includeArchived bool) (any, error) {
	active, recent, err := readAttentionDoc()
	if err != nil {
		return nil, err
	}
	entries := liveSessionsFrom(active, recent)
	now := time.Now()
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
		card.WorktreeDescription = worktreeDescription(card.RepoRoot, card.Branch)
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
			card.DeskIdleS = now.Unix() - act
		} else {
			card.DeskIdleS = -1
		}
		cards = append(cards, card)
	}
	if includeArchived {
		listed := make(map[string]bool, len(cards))
		for _, card := range cards {
			listed[card.ID] = true
		}
		for _, r := range recent {
			if _, live := entries[r.SessionID]; live || listed[r.SessionID] || r.ClearedTo != "" ||
				replacementForArchived(r.SessionID, recent, entries) != "" ||
				now.Sub(time.UnixMilli(r.ArchivedTS)) >= recentFinishedSession {
				continue
			}
			if path := archivedCodexTranscript(r); path != "" {
				cards = append(cards, archivedCodexCard(r, path))
				listed[r.SessionID] = true
			}
		}
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

func sessionDetail(args json.RawMessage) (any, error) {
	return sessionDetailFor(args, false)
}

func sessionDetailFor(args json.RawMessage, includeArchived bool) (any, error) {
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
	active, recent, err := readAttentionDoc()
	if err != nil {
		return nil, err
	}
	entries := liveSessionsFrom(active, recent)
	e, ok := entries[a.ID]
	path, agent := "", ""
	readOnly := false
	if !ok {
		if next := replacementForArchived(a.ID, recent, entries); next != "" {
			return map[string]any{"v": 1, "ok": true, "id": a.ID, "replaced_by": next, "status": "idle"}, nil
		}
		// cleared in its pane (/new, /clear): point the page at the session
		// that took its place
		for id, other := range entries {
			if other.ReplacedFrom == a.ID {
				return map[string]any{"v": 1, "ok": true, "id": a.ID, "replaced_by": id, "status": "idle"}, nil
			}
		}
		if includeArchived {
			for _, r := range recent {
				if r.SessionID == a.ID {
					if path = archivedCodexTranscript(r); path != "" {
						e = attentionEntry{SessionID: a.ID, Status: "idle", TS: r.ArchivedTS,
							AgentName: r.AgentName, WindowName: r.WindowName, GitBranch: r.GitBranch}
						agent, readOnly = "codex", true
					}
					break
				}
			}
		}
		if !readOnly {
			return nil, errors.New("session not found (ended or not tracked)")
		}
	} else {
		path, agent = findTranscript(e.SessionID)
	}
	// ts: the entry's last change, so the page's seen-ack (clear with ts)
	// clears this state only, not a newer one
	out := map[string]any{"v": 1, "ok": true, "id": a.ID, "status": e.Status, "ts": e.TS, "waiting_kind": e.WaitingKind,
		"running_kind": e.RunningKind, "background": enrichBackground(backgroundOf(e), nil, e.SessionID), "agent": "agent",
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
	if path == "" {
		// no transcript yet (a fresh session after /new): the pane's command
		// still says which agent it is, so the page can offer its commands
		if _, _, cmd, _, alive := paneState(e); alive && agentCommands[cmd] {
			out["agent"] = strings.TrimSuffix(cmd, ".real")
		}
	}
	if cwd, alive := paneInfo(e); alive {
		if git := worktreeGitStatus(cwd); git != nil {
			out["git"] = git
		}
		// the terminal's status line, for the web bottom bar (session_env.go)
		if list := repoWorktrees(cwd); len(list) > 0 {
			out["worktrees"] = list
		}
		if repo, _, _ := gitRepoMeta(cwd); repo != "" {
			label := repo
			if alias := parseRepoAliases(repoAliasSpec())[repo]; alias != "" {
				label = alias
			}
			out["repo_label"] = label
		}
	}
	if node := terminalNodeVersion(); node != "" {
		out["node"] = node
	}
	out["reference"] = sessionReference(e, path, agent)
	if readOnly {
		out["read_only"] = true
	} else {
		out["focus"] = sessionFocus(a.ID, e)
	}
	out["meta"] = sessionMeta(e, path, agent, nil)
	if path != "" {
		out["agent"] = agent
		if title := readSessionTitle(path, agent); title != "" {
			out["title"] = title
		}
		if p, ok := adapterFor(agent).(planReader); ok {
			if plan := p.PendingPlan(path); plan != nil {
				// awaiting_approval only while attention is waiting — after
				// Ctrl+C the TUI is Ready but updates.jsonl may still lack
				// status=completed; keep excerpt, drop the sticky review card.
				if e.Status != "waiting" {
					if _, ok := plan["awaiting_approval"]; ok {
						delete(plan, "awaiting_approval")
						relayLogf("session_prompt", "suppressed=plan_approval id=%s status=%s", a.ID, e.Status)
					}
				}
				if len(plan) > 0 {
					out["plan"] = plan
				}
			}
		}
		t, err := loadTranscript(path, agent)
		if err != nil {
			return nil, err
		}
		out["meta"] = sessionMeta(e, path, agent, t)
		transcriptsMu.Lock()
		total := len(t.messages)
		windowArgs := a
		if agent == "codex" {
			windowArgs = a.forMessagesRev(codexMessagesRev)
			out["messages_rev"] = codexMessagesRev
			if (a.Since != nil || a.Before != nil) && windowArgs.Since == nil && windowArgs.Before == nil {
				relayLogf("session_cursor", "id=%s agent=codex outcome=revision_reset", a.ID)
			}
		}
		start, end, span := sessionWindow(t.messages, windowArgs)
		out["messages"] = append([]chatMessage(nil), t.messages[start:end]...)
		compactions, lastCompact := t.compactions()
		if e.TurnStarted > 0 && (e.Status == "running" || e.Status == "waiting") {
			out["turn_output"] = t.turnOutput(e.TurnStarted)
		}
		if e.Status == "waiting" && e.WaitingKind == "permission_prompt" {
			if p := pendingPermission(t.messages, planToolOf(agent)); p != nil {
				out["permission"] = p
			}
		}
		if t.mode != "" {
			out["mode"] = t.mode
		}
		// the page refetches session.skills when this changes
		if rev := skillsRev(t.skills); rev != "" {
			out["skills_rev"] = rev
		}
		// what each background task is: the call that started it
		if bg := backgroundOf(e); len(bg) > 0 {
			out["background"] = enrichBackground(bg, t, e.SessionID)
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
		if usage.Model == "" && agent == "grok" {
			usage.Model, _ = grokSummaryModel(path)
		}
		if usage.ContextLimit == 0 {
			usage.ContextLimit = contextLimit(usage.Model)
		}
		out["usage"] = usage
		if a := adapterFor(agent); a != nil {
			out["capabilities"] = capabilitiesOf(a)
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
	if readOnly {
		return out, nil
	}
	screen, err := tmuxCmd(e.TmuxSocket, "capture-pane", "-p", "-J", "-t", e.TmuxPane, "-S", "-60").Output()
	if err == nil {
		out["screen"] = strings.TrimRight(string(screen), "\n ")
	}
	if r, ok := adapterFor(agent).(askReader); ok && path != "" {
		if el := r.PendingAsk(path, string(screen)); el != nil {
			// Same gate as Claude permission: disk may still show an Ask after
			// mid-turn abort; only surface it while attention is waiting.
			if e.Status == "waiting" {
				out["elicitation"] = el
			} else {
				relayLogf("session_prompt", "suppressed=elicitation id=%s status=%s", a.ID, e.Status)
			}
		}
	}
	return out, nil
}
