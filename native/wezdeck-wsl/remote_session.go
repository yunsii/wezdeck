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
	"encoding/json"
	"errors"
	"os"
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
	RunningKind    string `json:"running_kind"`
	RestartPending bool   `json:"restart_pending"`
	// when this turn began / the compaction started (ms; emit.sh +
	// attention-state-lib.sh): the phone counts elapsed time from them
	// set on a session listed in place of an archived one whose pane was
	// cleared (/new, /clear): the id it replaced (liveSessions)
	ReplacedFrom string `json:"-"`
	// set on a session listed from recent[]: the archived row it came from
	// (session id + archived_ts), which is how the desk's sessions/focus
	// finds it (sessionFocus)
	archivedID      string
	archivedTS      int64
	archivedOrderAt int64
	TurnStarted     int64 `json:"turn_started"`
	CompactStarted  int64 `json:"compact_started"`
	Bg              struct {
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
	return resolveDefaultAttentionFile()
}

type recentEntry struct {
	attentionEntry
	LastStatus string `json:"last_status"`
	LiveTS     int64  `json:"live_ts"`
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
	attached := true
	if e.TmuxSession != "" {
		attached = tmuxSessionAttached(e.TmuxSocket, e.TmuxSession)
	}
	return sessionFocusWithAttached(id, e, attached, true)
}

func sessionFocusWithAttached(id string, e attentionEntry, attached, known bool) map[string]any {
	out := map[string]any{"session_id": id}
	if e.archivedID != "" {
		out = map[string]any{"session_id": e.archivedID, "recent": true, "archived_ts": e.archivedTS}
	}
	if e.TmuxSession != "" && known && !attached {
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
var agentCommands = map[string]bool{"claude": true, "codex": true, "grok": true, "grok.real": true, "agy": true}

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
	out, _, _ := liveSessionsWithContext(entries, recent)
	return out
}

func liveSessionsWithContext(entries map[string]attentionEntry, recent []recentEntry) (map[string]attentionEntry, map[string]tmuxPaneSnap, map[string]bool) {
	out := map[string]attentionEntry{}
	panes := map[string]bool{}
	sockets := map[string]bool{}
	var missingPaneIDs []string
	for id, e := range entries {
		if e.TmuxPane == "" {
			missingPaneIDs = append(missingPaneIDs, id)
			continue
		}
		out[id] = e
		panes[e.TmuxSocket+"|"+e.TmuxPane] = true
		sockets[e.TmuxSocket] = true
	}
	observeMissingPaneEntries(missingPaneIDs)
	for _, r := range recent {
		if r.TmuxPane != "" {
			sockets[r.TmuxSocket] = true
		}
	}
	snap := snapshotTmuxPanes(sockets)
	closed := closedSessionsSet()
	// session_id → pane still advertising that pin (another window may keep
	// running a session this pane's cleared_to replaced).
	pins := agentSessionPinsFromSnap(snap)
	sort.Slice(recent, func(i, j int) bool { return recent[i].ArchivedTS > recent[j].ArchivedTS })
	paneMeta := recentPaneMeta(recent)
	for _, r := range recent {
		key := r.TmuxSocket + "|" + r.TmuxPane
		if r.SessionID == "" || r.TmuxPane == "" || panes[key] || closed[r.SessionID] {
			continue
		}
		panes[key] = true
		p, alive := snap[key]
		if !alive {
			continue
		}
		cmd, profile := p.cmd, p.profile
		isPending := strings.HasPrefix(r.ClearedTo, "pending-")
		if !isAgentPaneSnap(p, r.attentionEntry) &&
			!(isPending && agentCommands[profileFamily(profile)] && paneHasLauncherProcessSnap(p)) {
			continue
		}
		if cmd != "codex" && archivedCodexTranscript(r) != "" {
			continue
		}
		e := r.attentionEntry
		backfillRecentPaneMeta(&e, paneMeta, key)
		e.Status = "idle"
		e.WaitingKind = ""
		e.RunningKind = ""
		e.TS = r.ArchivedTS
		e.archivedID, e.archivedTS = r.SessionID, r.ArchivedTS
		if r.LastStatus == "done" {
			e.archivedOrderAt = r.LiveTS
		}
		// /new or /clear in this pane: the hook archived the old session and
		// marked it cleared_to the new one, which has no entry until its
		// first prompt. List the new session in its place (idle, empty,
		// sendable) so the phone can follow; the old id answers replaced_by.
		if next := r.ClearedTo; sessionIDPattern.MatchString(next) && next != r.SessionID {
			if current, taken := out[next]; !taken || current.TmuxPane == "" {
				e.ReplacedFrom = r.SessionID
				e.archivedOrderAt = 0
				e.SessionID = next
				e.LastUserPrompt = ""
				e.AgentName = ""
				out[next] = e
			}
			// Same session id may still be the live pin on another pane
			// (two worktree windows): keep listing it there.
			if pin, ok := pins[r.SessionID]; ok &&
				(pin.TmuxSocket != r.TmuxSocket || pin.TmuxPane != r.TmuxPane) {
				if _, taken := out[r.SessionID]; !taken {
					out[r.SessionID] = pin
					panes[pin.TmuxSocket+"|"+pin.TmuxPane] = true
				}
			}
			continue
		}
		if !paneOwnsSessionAgent(cmd, profile, r.AgentName) {
			continue
		}
		out[r.SessionID] = e
	}
	return out, snap, closed
}

// replacementForArchived finds the live session that took over an archived
// session's pane, including a pending id created for a fresh restart.
// The pane identity also handles rollouts without a cleared_to marker.
func replacementForArchived(id string, recent []recentEntry, entries map[string]attentionEntry) string {
	for _, r := range recent {
		if (r.SessionID != id && r.ClearedTo != id) || r.TmuxPane == "" {
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

var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

func listSessions() (any, error) {
	return listSessionsWithTiming(false, nil)
}

func listSessionsFor(includeArchived bool) (any, error) {
	return listSessionsWithTiming(includeArchived, nil)
}

func listSessionsWithTiming(includeArchived bool, timing *rpcTiming) (any, error) {
	t0 := time.Now()
	active, recent, err := readAttentionDoc()
	timing.add("read_ms", time.Since(t0))
	if err != nil {
		return nil, err
	}
	t1 := time.Now()
	entries, paneSnap, closed := liveSessionsWithContext(active, recent)
	timing.add("live_ms", time.Since(t1))
	tCards := time.Now()
	now := time.Now()
	cards := []sessionCard{}
	gitCache := map[string][3]string{} // cwd → repo, repoRoot, worktree
	deskBySock := map[string]map[string]int64{}
	visits := worktreeVisits()
	aliases := parseRepoAliases(repoAliasSpec())
	for id, e := range entries {
		if e.TmuxPane == "" {
			continue
		}
		p, alive := paneSnap[e.TmuxSocket+"|"+e.TmuxPane]
		if !alive {
			continue
		}
		cwd, cmd, index, profile, interrupt := p.cwd, p.cmd, p.index, p.profile, p.interrupt
		readOnly := codexPaneUnavailable(e.AgentName, cmd)
		if readOnly {
			e = e.asReadOnly()
		} else if e.interrupted(interrupt) {
			e.Status = "idle"
			e.RunningKind = ""
		}
		card := sessionCard{ID: id, Name: e.AgentName, Window: e.WindowName, Cwd: cwd, Branch: e.GitBranch,
			Status: e.Status, WaitingKind: e.WaitingKind, LastPrompt: e.LastUserPrompt, TS: e.TS, Agent: "agent",
			TimeSource:  "attention",
			RunningKind: e.RunningKind, RestartPending: e.RestartPending, Background: backgroundOf(e),
			TmuxSession: e.TmuxSession, TmuxPane: e.TmuxPane, PaneIndex: index, PaneRole: paneRole(index),
			AgentProfile: profile, TicketID: ticketIDForSession(e, cwd)}
		if family := paneAgentFamily(e, cmd, profile); family != "" {
			card.Agent = family
		}
		if e.TmuxSession != "" {
			card.Detached = !p.attached
		}
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
			if !readOnly && !paneOwnsSessionAgent(cmd, profile, agent) {
				continue
			}
			card.Agent = agent
			card.Transcript = true
			card.Title = resolveSessionTitle(e.SessionID, path, agent)
			// the newest turn's own timestamp; mtime only for formats
			// without one (remote_activity.go: Claude touches idle files)
			if at := lastTurnAt(path, agent); at > 0 {
				card.TS = at
				card.TimeSource = "transcript_turn"
			} else if info, err := os.Stat(path); err == nil {
				card.TS = info.ModTime().UnixMilli()
				card.TimeSource = "transcript_mtime"
			}
			// Agy has no PermissionRequest hook: mirror the detail page's screen
			// permission detection so the list, unread badge, and Alt+j show waiting.
			if agent == "agy" && card.Status == "running" && card.WaitingKind == "" && agyListCardWaiting(e, path) {
				card.Status = "waiting"
				card.WaitingKind = "permission_prompt"
			}
		} else {
			windowAt := int64(0)
			if card.TS <= 0 {
				if p.windowActivity > 0 {
					windowAt = p.windowActivity
				} else {
					windowAt = windowActivity(e)
				}
			}
			card.TS, card.TimeSource = sessionFallbackTime(card.TS, windowAt)
		}
		card.OrderAt = sessionOrderAt(e, card.TS)
		card.OrderSource = sessionOrderSource(e, card.TimeSource)
		observeSessionOrder(card, e.TS)
		sockDesk, cachedDesk := deskBySock[e.TmuxSocket]
		if !cachedDesk {
			sockDesk = deskActivityBySession(e.TmuxSocket)
			deskBySock[e.TmuxSocket] = sockDesk
		}
		if act := sockDesk[e.TmuxSession]; act > 0 {
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
			if _, live := entries[r.SessionID]; live || listed[r.SessionID] || r.ClearedTo != "" || closed[r.SessionID] ||
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
	timing.add("cards_ms", time.Since(tCards))
	tPost := time.Now()
	// Resume on pane A while the prior "new" session still runs on pane B:
	// both would list; the empty splash on A is noise — drop it when B still
	// has visible chat (same worktree). A fresh /new with no sibling content
	// stays (needs a row for the first message).
	cards = dropEmptyHandoffSplashes(cards, recent)
	// newest conversation activity first
	sort.Slice(cards, func(i, j int) bool { return cards[i].TS > cards[j].TS })
	listed := make(map[string]bool, len(cards))
	for _, c := range cards {
		listed[c.ID] = true
	}
	redirects := sessionRedirectsFromSnap(recent, entries, paneSnap, listed)
	jobs := activeNewSessionJobsFor(cards)
	timing.add("post_ms", time.Since(tPost))
	return map[string]any{
		"v": 1, "ok": true, "sessions": cards,
		"creating_jobs": jobs,
		"redirects":     redirects,
	}, nil
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
	return sessionDetailWithTiming(args, false, nil)
}

func sessionDetailFor(args json.RawMessage, includeArchived bool) (any, error) {
	return sessionDetailWithTiming(args, includeArchived, nil)
}

func sessionDetailWithTiming(args json.RawMessage, includeArchived bool, timing *rpcTiming) (any, error) {
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
	tRead := time.Now()
	active, recent, err := readAttentionDoc()
	timing.add("read_ms", time.Since(tRead))
	if err != nil {
		return nil, err
	}
	tLive := time.Now()
	entries, paneSnap, _ := liveSessionsWithContext(active, recent)
	timing.add("live_ms", time.Since(tLive))
	tMeta := time.Now()
	e, ok := entries[a.ID]
	path, agent := "", ""
	cwd, cmd, profile := "", "", ""
	var paneIndex int
	paneAlive, paneAttached := false, true
	interrupted := false
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
				if r.SessionID == a.ID && !sessionWasClosed(a.ID) {
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
		var interrupt string
		if p, alive := paneSnap[e.TmuxSocket+"|"+e.TmuxPane]; alive {
			cwd, cmd, paneIndex, profile, interrupt, paneAlive, paneAttached = p.cwd, p.cmd, p.index, p.profile, p.interrupt, true, p.attached
		}
		readOnly = codexPaneUnavailable(e.AgentName, cmd)
		interrupted = !readOnly && paneAlive && e.interrupted(interrupt)
		if readOnly {
			e = e.asReadOnly()
		} else if interrupted {
			e.Status = "idle"
			e.RunningKind = ""
		}
		if !readOnly && path != "" && paneAlive && !paneOwnsSessionAgent(cmd, profile, agent) {
			path, agent = "", ""
		}
	}
	// ts: the entry's last change, so the page's seen-ack (clear with ts)
	// clears this state only, not a newer one
	out := map[string]any{"v": 1, "ok": true, "id": a.ID, "status": e.Status, "ts": e.TS, "waiting_kind": e.WaitingKind, "restart_pending": e.RestartPending,
		"running_kind": e.RunningKind, "background": enrichBackground(backgroundOf(e), nil, e.SessionID), "agent": "agent",
		"name": e.AgentName, "window": e.WindowName, "branch": e.GitBranch}
	if interrupted {
		out["interrupted"] = true
	}
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
		// or managed profile still says which agent it is
		if paneAlive {
			if family := paneAgentFamily(e, cmd, profile); family != "" {
				agent = family
				out["agent"] = agent
			}
		}
		if agent == "agy" {
			out["mode"] = resolveAgyMode(e, nil)
		}
	}
	if paneAlive && cwd != "" {
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
	out["reference"] = sessionReferenceWithCwd(e, path, agent, cwd)
	if readOnly {
		out["read_only"] = true
	} else {
		out["focus"] = sessionFocusWithAttached(a.ID, e, paneAttached, paneAlive)
	}
	if e.ReplacedFrom != "" {
		rebindOutboxSession(e.ReplacedFrom, a.ID)
	}
	if !strings.HasPrefix(a.ID, "pending-") && e.TmuxPane != "" {
		if pendingIDs := recentPendingIDsForPane(recent, e.TmuxSocket, e.TmuxPane); len(pendingIDs) > 0 {
			rebindPendingOutboxForPane(e.TmuxPane, pendingIDs, a.ID)
		}
	}
	var agyPending *pendingCall
	var loadedTranscript *transcript
	var allMsgsForOutbox []chatMessage
	timing.add("meta_ms", time.Since(tMeta))
	tTranscript := time.Now()
	if path != "" {
		out["agent"] = agent
		if title := resolveSessionTitle(a.ID, path, agent); title != "" {
			out["title"] = title
		}
		if hist := resolveSessionTitleHistory(a.ID, path, agent); len(hist) > 0 {
			out["title_history"] = hist
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
		loadedTranscript = t
		out["meta"] = sessionMetaWithPane(e, path, agent, t, cwd, cmd, paneIndex, paneAlive)
		transcriptsMu.Lock()
		total := len(t.messages)
		windowArgs := a
		if rev := messagesRevFor(agent); rev > 0 {
			windowArgs = a.forMessagesRev(rev)
			out["messages_rev"] = rev
			if (a.Since != nil || a.Before != nil) && windowArgs.Since == nil && windowArgs.Before == nil {
				relayLogf("session_cursor", "id=%s agent=%s outcome=revision_reset", a.ID, agent)
			}
		}
		start, end, span := sessionWindowLogged(a.ID, agent, t.messages, windowArgs)
		out["messages"] = append([]chatMessage(nil), t.messages[start:end]...)
		compactions, lastCompact := t.compactions()
		if e.TurnStarted > 0 && (e.Status == "running" || e.Status == "waiting") {
			out["turn_output"] = t.turnOutput(e.TurnStarted)
		}
		if rate := sessionTokenRateFor(e.SessionID, t); rate != nil {
			out["token_rate"] = rate
		}
		if e.Status == "waiting" && e.WaitingKind == "permission_prompt" {
			if p := pendingPermission(t.messages, planToolOf(agent)); p != nil {
				out["permission"] = p
			}
		} else if agent == "agy" {
			agyPending = pendingPermission(t.messages, "")
		}
		mode := t.mode
		// the page refetches session.skills when this changes
		if rev := skillsRev(t.skills); rev != "" {
			out["skills_rev"] = rev
		}
		// what each background task is: the call that started it
		if bg := backgroundOf(e); len(bg) > 0 {
			out["background"] = enrichBackground(bg, t, e.SessionID)
		}
		if hasUnsettledOutbox(a.ID) {
			allMsgsForOutbox = append([]chatMessage(nil), t.messages...)
		}
		transcriptsMu.Unlock()
		if agent == "agy" && mode == "" {
			mode = resolveAgyMode(e, nil)
		}
		if mode != "" {
			out["mode"] = mode
		}
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
		if usage.Model == "" && agent == "agy" {
			usage.Model = agyDefaultModel()
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
		if lr, ok := adapterFor(agent).(limitsReader); ok {
			if size := lr.ContextSize(e.SessionID); size > 0 {
				usage.ContextLimit = size
				out["usage"] = usage
			}
			if limits := lr.AccountLimits(usage.Model); limits != nil {
				out["account"] = limits
			}
		}
	} else {
		out["meta"] = sessionMetaWithPane(e, path, agent, nil, cwd, cmd, paneIndex, paneAlive)
	}
	timing.add("transcript_ms", time.Since(tTranscript))
	if outbox := reconcileSessionOutbox(a.ID, allMsgsForOutbox, e.busy(), time.Now().UnixMilli()); len(outbox) > 0 {
		out["outbox"] = outbox
	}
	if readOnly {
		return out, nil
	}
	tScreen := time.Now()
	screen, err := tmuxCmd(e.TmuxSocket, "capture-pane", "-p", "-J", "-t", e.TmuxPane, "-S", "-60").Output()
	timing.add("screen_ms", time.Since(tScreen))
	if err == nil {
		trimmed := strings.TrimRight(string(screen), "\n ")
		out["screen"] = trimmed
		if agent == "agy" && applyAgyScreenPermission(out, agyPending, trimmed) {
			e.Status = "waiting"
			e.WaitingKind = "permission_prompt"
			out["meta"] = sessionMetaWithPane(e, path, agent, loadedTranscript, cwd, cmd, paneIndex, paneAlive)
		}
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
