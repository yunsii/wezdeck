package main

// New session from the phone — wezdeck's Ctrl+k g d: a new workstation (a
// worktree for one direction: directory <name>, branch dev/<name>, its
// one-line purpose in the git branch description) with its agent in tmux,
// via open-task-window (the desk's own path: naming, collision bumps,
// per-repo agent profile), then the first message pasted into the agent
// once its TUI is up.
//
//   repos            read   repositories a session may be created in: the
//                           ones you visited (access ledger) or that run a
//                           session now, newest visit first
//   session.new      write  {repo, name, description, prompt} → {job}; runs in
//                           the background (git fetch + agent start outlast
//                           an RPC)
//   session.new.job  read   {job} → stage creating | starting | sending |
//                           done | failed, worktree, branch, error
//
// The message is required: the phone lists sessions by their attention
// entry, which an agent only gets with its first prompt — a session created
// without one would not show up. WEZDECK_SESSION_NEW_CMD replaces
// open-task-window (the test stack: a fake that opens a `cat` pane).

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

type repoChoice struct {
	Root         string `json:"root"`
	Label        string `json:"label"`
	Visited      int64  `json:"visited,omitempty"`
	AgentProfile string `json:"agent_profile,omitempty"`
	AgentSource  string `json:"agent_source,omitempty"`
}

// knownRepos includes remembered repositories even after their last session closes.
func knownRepos() []repoChoice {
	paths := rememberedSessionRepos()
	for path, ms := range worktreeVisits() {
		paths[path] = max(paths[path], ms)
	}
	if entries, err := liveSessions(); err == nil {
		for _, e := range entries {
			if _, cwd, _, _, _, alive := paneState(e); alive && cwd != "" {
				if _, ok := paths[cwd]; !ok {
					paths[cwd] = 0
				}
			}
		}
	}
	byRoot := map[string]*repoChoice{}
	for path, ms := range paths {
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			continue
		}
		label, root, _ := gitRepoMeta(path)
		if root == "" {
			continue
		}
		c := byRoot[root]
		if c == nil {
			c = &repoChoice{Root: root, Label: label}
			byRoot[root] = c
		}
		if ms > c.Visited {
			c.Visited = ms
		}
	}
	out := make([]repoChoice, 0, len(byRoot))
	for _, c := range byRoot {
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Visited != out[j].Visited {
			return out[i].Visited > out[j].Visited
		}
		return out[i].Label < out[j].Label
	})
	return out
}

func listRepos() (any, error) {
	repos := knownRepos()
	settings, settingsErr := readRepoAgentSettings()
	if settingsErr != nil {
		relayLogf("repo_agent", "outcome=read_error err=%q", settingsErr.Error())
	}
	roots := make([]string, len(repos))
	for i := range repos {
		roots[i] = repos[i].Root
	}
	defaults := workspaceAgentProfiles(roots)
	for i := range repos {
		repos[i].AgentProfile, repos[i].AgentSource = defaults[i], "workspace"
		if settingsErr == nil && settings[repos[i].Root] != "" {
			repos[i].AgentProfile, repos[i].AgentSource = settings[repos[i].Root], "override"
		}
	}
	return map[string]any{"v": 1, "ok": true, "repos": repos, "settings_error": settingsErr != nil}, nil
}

func validateNewSessionAgent(profile string) error {
	if !registeredAgentProfile(profile) {
		return errors.New("session.new: unknown agent profile")
	}
	disabled, err := agentProfileDisabled(profile)
	if err != nil {
		return fmt.Errorf("session.new: cannot read %s agent settings: %w", profile, err)
	}
	if disabled {
		return errors.New("session.new: agent profile is disabled")
	}
	if profile == "claude_kimi" && !kimiConfigured() {
		return errors.New("session.new: configure the Kimi API key in Agents first")
	}
	return nil
}

type newSessionJob struct {
	ID           string `json:"job"`
	Stage        string `json:"stage"` // creating | starting | waiting_trust | sending | done | failed
	Repo         string `json:"repo"`
	RepoLabel    string `json:"repo_label,omitempty"`
	AgentProfile string `json:"agent_profile,omitempty"`
	Prompt       string `json:"prompt,omitempty"`
	GroupName    string `json:"group_name,omitempty"`
	AnchorID     string `json:"anchor_session_id,omitempty"`
	CreatedAt    int64  `json:"created_at,omitempty"`
	Worktree     string `json:"worktree,omitempty"`
	Branch       string `json:"branch,omitempty"`
	SessionID    string `json:"session_id,omitempty"`
	Error        string `json:"error,omitempty"`
	Warning      string `json:"warning,omitempty"`
	// Mode: new (a new direction), parallel (one more slot of a direction
	// whose slots are all busy) or reuse (an idle slot starts a new round)
	Mode       string `json:"mode,omitempty"`
	at         time.Time
	finishedAt time.Time
	trustCh    chan struct{}
	socket     string
	pane       string
	trusting   bool
	outboxID   string
}

func repoLabelFor(repo string) string {
	if repo == "" {
		return ""
	}
	label, _, _ := gitRepoMeta(repo)
	if label == "" {
		label = filepath.Base(repo)
	}
	if alias := parseRepoAliases(repoAliasSpec())[label]; alias != "" {
		return alias
	}
	return label
}

// activeNewSessionJobsFor returns creating/waiting/recent-failed jobs so the web
// session list can show in-flight sessions across switches and reloads.
func activeNewSessionJobsFor(cards []sessionCard) []newSessionJob {
	listed := make(map[string]bool, len(cards))
	listedWorktrees := make(map[string]bool, len(cards))
	for _, c := range cards {
		listed[c.ID] = true
		if c.Worktree != "" {
			listedWorktrees[c.Worktree] = true
		}
	}
	newJobsMu.Lock()
	defer newJobsMu.Unlock()
	out := make([]newSessionJob, 0)
	for _, j := range newJobs {
		if j == nil {
			continue
		}
		ended := j.finishedAt
		if ended.IsZero() {
			ended = j.at
		}
		switch j.Stage {
		case "done":
			if j.SessionID != "" && listed[j.SessionID] {
				continue
			}
			if j.SessionID == "" && j.Worktree != "" && listedWorktrees[j.Worktree] {
				continue
			}
			if time.Since(ended) > 30*time.Second {
				continue
			}
		case "failed":
			if time.Since(ended) > 10*time.Minute {
				continue
			}
		default:
			if time.Since(j.at) > time.Hour {
				continue
			}
		}
		out = append(out, *j)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt > out[j].CreatedAt
		}
		return out[i].ID < out[j].ID
	})
	return out
}

var (
	newJobsMu sync.Mutex
	newJobs   = map[string]*newSessionJob{}
	// reusing: slots a running job is reusing, so a second 新会话 for the
	// same direction does not pick the same one
	reusing = map[string]string{}
)

func setJob(id string, change func(j *newSessionJob)) {
	newJobsMu.Lock()
	defer newJobsMu.Unlock()
	if j := newJobs[id]; j != nil {
		change(j)
	}
}

const (
	subjectMax     = 60
	descriptionMax = 120
	promptMax      = 8000
)

// hasSlugChar: the name becomes the directory and branch (open-task-window
// slugifies to [a-z0-9-]), so it needs at least one ASCII letter or digit.
func hasSlugChar(s string) bool {
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			return true
		}
	}
	return false
}

func validSubject(s string) bool {
	if s == "" || utf8.RuneCountInString(s) > subjectMax {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func startNewSession(args json.RawMessage) (any, error) {
	var a struct {
		Repo        string  `json:"repo"`
		Name        string  `json:"name"`
		Description string  `json:"description"`
		Prompt      string  `json:"prompt"`
		Agent       string  `json:"agent_profile"`
		Anchor      string  `json:"anchor_session_id"`
		GroupName   *string `json:"group_name"`
		NewGroup    bool    `json:"new_group"`
	}
	if json.Unmarshal(args, &a) != nil {
		return nil, errors.New("session.new: bad arguments")
	}
	a.Name = strings.TrimSpace(a.Name)
	a.Description = strings.TrimSpace(a.Description)
	a.Prompt = strings.TrimSpace(a.Prompt)
	a.Agent = strings.ToLower(strings.TrimSpace(a.Agent))
	if a.Agent != "" {
		if err := validateNewSessionAgent(a.Agent); err != nil {
			return nil, err
		}
	}
	groupName := ""
	if a.GroupName != nil {
		groupName = strings.TrimSpace(*a.GroupName)
		if !validSubject(groupName) {
			return nil, fmt.Errorf("session.new: the group name needs 1–%d characters, one line", subjectMax)
		}
	}
	allocate := a.Anchor == "" && (a.NewGroup || a.GroupName != nil)
	if allocate {
		if a.Name != "" || a.Description != "" {
			return nil, errors.New("session.new: a new group allocates its own checkout")
		}
		a.Description = groupName
		a.Name = "session-" + newDiagID()
	} else if a.NewGroup {
		return nil, errors.New("session.new: cannot allocate a checkout for an existing session")
	}
	if a.Anchor == "" && !validSubject(a.Name) {
		return nil, fmt.Errorf("session.new: the name needs 1–%d characters, one line", subjectMax)
	}
	if a.Anchor == "" && !hasSlugChar(a.Name) {
		return nil, errors.New("session.new: the name needs letters or digits (it becomes the directory and branch); put the rest in the description")
	}
	if utf8.RuneCountInString(a.Description) > descriptionMax || strings.ContainsAny(a.Description, "\r\n") {
		return nil, fmt.Errorf("session.new: the description is one line of at most %d characters", descriptionMax)
	}
	if a.Prompt == "" || utf8.RuneCountInString(a.Prompt) > promptMax {
		return nil, fmt.Errorf("session.new: the first message needs 1–%d characters", promptMax)
	}
	if a.Agent == "" {
		repo := a.Repo
		if a.Anchor != "" {
			_, targetRepo, _, err := sessionGroupTarget(a.Anchor)
			if err != nil {
				return nil, err
			}
			repo = targetRepo
		}
		var err error
		a.Agent, _, err = repoAgentProfile(repo)
		if err != nil {
			return nil, err
		}
		if err := validateNewSessionAgent(a.Agent); err != nil {
			return nil, err
		}
	}
	if a.Anchor != "" {
		return startGroupedSession(a.Anchor, a.Agent, a.Prompt, groupName)
	}
	allowed := false
	for _, r := range knownRepos() {
		allowed = allowed || r.Root == a.Repo
	}
	if !allowed {
		return nil, errors.New("session.new: not a repository you work in")
	}
	// the direction the name stands for: reuse its idle slot, else open one
	// more (open-task-window bumps a taken name into a parallel slot), else
	// a new direction
	mode, reuse := "new", ""
	direction := directionSlug(a.Name)
	if dirs, err := repoWorkstations(a.Repo); !allocate && err == nil {
		newJobsMu.Lock()
		for _, d := range dirs {
			if d.Name != direction {
				continue
			}
			mode = "parallel"
			for _, s := range d.Slots {
				if s.State == "idle" && reusing[s.Path] == "" {
					mode, reuse = "reuse", s.Path
					break
				}
			}
		}
		newJobsMu.Unlock()
	}
	unlock := func() {}
	if reuse != "" {
		var err error
		unlock, err = lockSessionWorktree(reuse)
		if err != nil {
			return nil, err
		}
	}
	now := time.Now()
	outboxRec, _ := outboxRecordStart(sentRecord{
		Kind:      "session_new",
		RepoKey:   a.Repo,
		RepoLabel: repoLabelFor(a.Repo),
		Worktree:  reuse,
		Agent:     profileFamily(a.Agent),
		Text:      a.Prompt,
		Status:    "pasting",
	})
	job := &newSessionJob{
		ID:           newDiagID(),
		Stage:        "creating",
		Repo:         a.Repo,
		RepoLabel:    repoLabelFor(a.Repo),
		AgentProfile: a.Agent,
		Prompt:       a.Prompt,
		GroupName:    groupName,
		CreatedAt:    now.UnixMilli(),
		Mode:         mode,
		Worktree:     reuse,
		at:           now,
		outboxID:     outboxRec.ID,
	}
	newJobsMu.Lock()
	if reuse != "" {
		if reusing[reuse] != "" { // taken between the check and here
			newJobsMu.Unlock()
			unlock()
			return nil, errors.New("session.new: that workstation was just taken; try again")
		}
		reusing[reuse] = job.ID
	}
	for id, j := range newJobs { // keep the last hour
		if time.Since(j.at) > time.Hour {
			delete(newJobs, id)
		}
	}
	newJobs[job.ID] = job
	newJobsMu.Unlock()
	go func() {
		defer unlock()
		runNewSession(job.ID, mode, a.Repo, a.Name, a.Description, a.Prompt, a.Agent, reuse)
		if reuse != "" {
			newJobsMu.Lock()
			delete(reusing, reuse)
			newJobsMu.Unlock()
		}
	}()
	return map[string]any{"v": 1, "ok": true, "job": job.ID}, nil
}

func newSessionJobStatus(args json.RawMessage) (any, error) {
	var a struct {
		Job string `json:"job"`
	}
	_ = json.Unmarshal(args, &a)
	newJobsMu.Lock()
	defer newJobsMu.Unlock()
	j := newJobs[a.Job]
	if j == nil {
		return nil, errors.New("session.new.job: unknown job")
	}
	return map[string]any{"v": 1, "ok": true, "job": *j}, nil
}

func approveNewSessionTrust(args json.RawMessage) (any, error) {
	var a struct {
		Job     string `json:"job"`
		Confirm bool   `json:"confirm"`
	}
	if json.Unmarshal(args, &a) != nil || !a.Confirm {
		return nil, errors.New("session.new.trust: explicit confirmation required")
	}
	newJobsMu.Lock()
	j := newJobs[a.Job]
	if j == nil || j.Stage != "waiting_trust" || j.trustCh == nil || j.trusting {
		newJobsMu.Unlock()
		return nil, errors.New("session.new.trust: no pending workspace trust prompt")
	}
	j.trusting = true
	socket, pane, ready := j.socket, j.pane, j.trustCh
	newJobsMu.Unlock()
	screen, err := tmuxCmd(socket, "capture-pane", "-p", "-t", pane).Output()
	kind, keys := detectWorkspaceTrustPrompt(string(screen))
	if err != nil || kind == "" {
		setJob(a.Job, func(j *newSessionJob) { j.trusting = false })
		return nil, errors.New("session.new.trust: the workspace trust prompt is no longer shown")
	}
	sendArgs := append([]string{"send-keys", "-t", pane}, keys...)
	if err := tmuxCmd(socket, sendArgs...).Run(); err != nil {
		setJob(a.Job, func(j *newSessionJob) { j.trusting = false })
		return nil, errors.New("session.new.trust: the agent pane is no longer available")
	}
	setJob(a.Job, func(j *newSessionJob) { j.Stage = "starting" })
	ready <- struct{}{}
	relayLogf("session_new_trust", "job=%s kind=%s outcome=confirmed", a.Job, kind)
	return map[string]any{"v": 1, "ok": true}, nil
}

func lineHasSelectionMarker(screen, needle string) bool {
	for _, line := range strings.Split(screen, "\n") {
		if !strings.Contains(line, needle) {
			continue
		}
		trimmed := strings.TrimSpace(line)
		for _, prefix := range []string{">", "❯", "›", "●", "▸"} {
			if strings.HasPrefix(trimmed, prefix) {
				return true
			}
		}
	}
	return false
}

// detectWorkspaceTrustPrompt identifies first-open workspace trust dialogs
// across Agy, Claude Code, and Codex, returning the agent kind and the tmux
// send-keys sequence that confirms trust.
func detectWorkspaceTrustPrompt(screen string) (string, []string) {
	if strings.Contains(screen, "Do you trust the contents of this project?") &&
		strings.Contains(screen, "Yes, I trust this folder") {
		if lineHasSelectionMarker(screen, "Yes, I trust this folder") {
			return "agy", []string{"Enter"}
		}
		return "agy", []string{"Up", "Enter"}
	}
	if (strings.Contains(screen, "Do you trust the files in this folder?") ||
		strings.Contains(screen, "Is this a project you created or one you trust?")) &&
		(strings.Contains(screen, "Yes, I trust this folder") ||
			strings.Contains(screen, "Yes, proceed")) {
		return "claude", []string{"Enter"}
	}
	if strings.Contains(screen, "Do you trust the contents of this directory?") &&
		(strings.Contains(screen, "Yes, continue") ||
			strings.Contains(screen, "Press enter to continue")) {
		return "codex", []string{"Enter"}
	}
	return "", nil
}

func agyTrustPrompt(screen string) bool {
	kind, _ := detectWorkspaceTrustPrompt(screen)
	return kind == "agy"
}

func waitTrustPromptClear(ctx context.Context, socket, pane string) error {
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return errors.New("workspace trust did not finish in time")
		case <-ticker.C:
			screen, err := tmuxCmd(socket, "capture-pane", "-p", "-t", pane).Output()
			if err != nil {
				return errors.New("the agent pane closed during workspace trust")
			}
			if kind, _ := detectWorkspaceTrustPrompt(string(screen)); kind == "" {
				return nil
			}
		}
	}
}

// clearWorkspaceTrust auto-confirms a workspace trust dialog on a newly created
// session for a repository the user explicitly chose. If auto-confirm does not
// clear the prompt in time, it falls back to waiting_trust for manual Web
// confirmation instead of pasting the user's message into the dialog.
func clearWorkspaceTrust(ctx context.Context, id, socket, pane string, allowManualFallback bool) error {
	screen, err := tmuxCmd(socket, "capture-pane", "-p", "-t", pane).Output()
	if err != nil {
		return errors.New("the agent pane closed before trust could be checked")
	}
	kind, keys := detectWorkspaceTrustPrompt(string(screen))
	if kind == "" {
		return nil
	}
	sendArgs := append([]string{"send-keys", "-t", pane}, keys...)
	if err := tmuxCmd(socket, sendArgs...).Run(); err != nil {
		return errors.New("the agent pane closed while confirming workspace trust")
	}
	autoCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	clearErr := waitTrustPromptClear(autoCtx, socket, pane)
	cancel()
	if clearErr == nil {
		relayLogf("session_new_trust", "job=%s kind=%s outcome=auto_confirmed", id, kind)
		return waitAgentReady(socket, pane, 60*time.Second)
	}
	if !allowManualFallback {
		return clearErr
	}
	ready := make(chan struct{}, 1)
	setJob(id, func(j *newSessionJob) {
		j.Stage, j.socket, j.pane, j.trustCh = "waiting_trust", socket, pane, ready
	})
	relayLogf("session_new_trust", "job=%s kind=%s outcome=waiting", id, kind)
	select {
	case <-ctx.Done():
		return errors.New("workspace trust was not confirmed in time")
	case <-ready:
	}
	if err := waitTrustPromptClear(ctx, socket, pane); err != nil {
		return err
	}
	return waitAgentReady(socket, pane, 60*time.Second)
}

func paneAttentionIDs(socket, pane string) map[string]bool {
	out := map[string]bool{}
	entries, _, err := readAttentionDoc()
	if err != nil {
		return out
	}
	for id, ent := range entries {
		if id != "" && ent.TmuxPane == pane && (socket == "" || ent.TmuxSocket == socket) {
			out[id] = true
		}
	}
	return out
}

func waitNewSessionID(socket, pane string, before map[string]bool, limit time.Duration) string {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		for id := range paneAttentionIDs(socket, pane) {
			if !before[id] {
				return id
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	return ""
}

// directionSlug: the direction a typed name stands for, as the host names
// it (open-task-window → wt_workstation_plan; web workstationSlug).
func directionSlug(name string) string {
	name = strings.TrimSpace(name)
	for _, p := range []string{"dev-", "dev/"} {
		name = strings.TrimPrefix(name, p)
	}
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			dash = false
		} else if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	return strings.TrimSuffix(b.String(), "-")
}

func jobOutboxID(id string) string {
	newJobsMu.Lock()
	defer newJobsMu.Unlock()
	if j := newJobs[id]; j != nil {
		return j.outboxID
	}
	return ""
}

func runNewSession(id, mode, repo, name, description, prompt, agent, reuse string) {
	started := time.Now()
	if mode == "" {
		mode = "new"
		if reuse != "" {
			mode = "reuse"
		}
	}
	tel := newSessionTelemetry{Stage: "worktree"}
	var worktreePath, branchName string
	fail := func(err error) {
		tel.TotalMS = time.Since(started).Milliseconds()
		setJob(id, func(j *newSessionJob) {
			j.Stage, j.Error, j.finishedAt = "failed", clip(err.Error(), 300), time.Now()
		})
		if oid := jobOutboxID(id); oid != "" {
			_, _ = outboxUpdate(oid, func(r *sentRecord) {
				r.Status = "failed"
				r.Error = clip(err.Error(), 300)
				if tel.Pane != "" {
					r.Pane = tel.Pane
				}
				if worktreePath != "" {
					r.Worktree = worktreePath
				}
			})
		}
		relayLogf("session_new",
			"job=%s mode=%s agent=%q reuse=%t ok=false stage=%s pane=%q cmd=%q session_id=%q worktree=%q branch=%q worktree_ms=%d ready_ms=%d ready_reason=%q banner_seen=%t trust_ms=%d paste_ms=%d wait_id_ms=%d nudges=%d total_ms=%d err=%q",
			id, mode, agent, reuse != "", tel.Stage, tel.Pane, tel.Command, tel.SessionID,
			worktreePath, branchName, tel.WorktreeMS, tel.ReadyMS, tel.ReadyReason, tel.BannerSeen,
			tel.TrustMS, tel.PasteMS, tel.WaitIDMS, tel.Nudges, tel.TotalMS, err)
	}
	cmdPath := os.Getenv("WEZDECK_SESSION_NEW_CMD")
	if cmdPath == "" {
		cmdPath = filepath.Join(repoRoot(), "scripts", "runtime", "worktree", "open-task-window")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, cmdPath, newSessionCreateArgs(name, description, agent)...)
	if reuse != "" {
		reusePath := os.Getenv("WEZDECK_SESSION_REUSE_CMD") // the test stack's stand-in
		if reusePath == "" {
			reusePath = filepath.Join(repoRoot(), "scripts", "runtime", "worktree", "reuse-workstation")
		}
		cmd = exec.CommandContext(ctx, reusePath, newSessionReuseArgs(reuse, agent)...)
	} else {
		// Fresh worktrees have no prior conversation; bypass resume --last so
		// Codex/Claude boot straight into a blank TUI.
		cmd.Env = append(os.Environ(), "WEZDECK_FORCE_FRESH_SESSION=1")
	}
	cmd.Dir = repo
	wtStart := time.Now()
	out, err := cmd.Output()
	tel.WorktreeMS = time.Since(wtStart).Milliseconds()
	result := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	for sc.Scan() {
		if k, v, ok := strings.Cut(sc.Text(), "="); ok {
			result[k] = v
		}
	}
	worktreePath, branchName = result["worktree_path"], result["branch_name"]
	if err != nil || result["window_id"] == "" {
		msg := "no tmux window was opened"
		if ee, ok := err.(*exec.ExitError); ok {
			msg = strings.TrimSpace(string(ee.Stderr))
		} else if err != nil {
			msg = err.Error()
		}
		fail(errors.New(clip(msg, 300)))
		return
	}
	socket := result["tmux_socket"] // the test fake names its socket
	setJob(id, func(j *newSessionJob) {
		j.Stage, j.Worktree, j.Branch = "starting", worktreePath, branchName
	})
	tel.Stage = "pane"
	pane, err := tmuxCmd(socket, "display-message", "-p", "-t", result["window_id"], "#{pane_id}").Output()
	if err != nil {
		fail(fmt.Errorf("the new window is gone: %v", err))
		return
	}
	target := strings.TrimSpace(string(pane))
	tel.Pane = target
	if err := sendNewSessionPromptWithTelemetry(ctx, id, socket, target, prompt, nil, &tel); err != nil {
		fail(err)
		return
	}
	tel.TotalMS = time.Since(started).Milliseconds()
	relayLogf("session_new",
		"job=%s mode=%s agent=%q reuse=%t ok=true stage=done pane=%q cmd=%q session_id=%q worktree=%q branch=%q worktree_ms=%d ready_ms=%d ready_reason=%q banner_seen=%t trust_ms=%d paste_ms=%d wait_id_ms=%d nudges=%d total_ms=%d",
		id, mode, agent, reuse != "", tel.Pane, tel.Command, tel.SessionID,
		worktreePath, branchName, tel.WorktreeMS, tel.ReadyMS, tel.ReadyReason, tel.BannerSeen,
		tel.TrustMS, tel.PasteMS, tel.WaitIDMS, tel.Nudges, tel.TotalMS)
}

func sendNewSessionPrompt(ctx context.Context, id, socket, target, prompt string, afterSend func() string) error {
	var tel newSessionTelemetry
	return sendNewSessionPromptWithTelemetry(ctx, id, socket, target, prompt, afterSend, &tel)
}

func sendNewSessionPromptWithTelemetry(ctx context.Context, id, socket, target, prompt string, afterSend func() string, tel *newSessionTelemetry) error {
	tel.Pane = target
	tel.Stage = "ready"
	readyInfo, err := waitAgentReadyDetailed(socket, target, 90*time.Second)
	tel.ReadyMS = readyInfo.Duration.Milliseconds()
	tel.ReadyReason = readyInfo.Reason
	tel.Command = readyInfo.Command
	tel.BannerSeen = readyInfo.BannerSeen
	if err != nil {
		return err
	}
	tel.Stage = "trust"
	trustStart := time.Now()
	if err := clearWorkspaceTrust(ctx, id, socket, target, true); err != nil {
		tel.TrustMS = time.Since(trustStart).Milliseconds()
		return err
	}
	tel.TrustMS = time.Since(trustStart).Milliseconds()
	beforeIDs := paneAttentionIDs(socket, target)
	setJob(id, func(j *newSessionJob) { j.Stage = "sending" })
	tel.Stage = "paste"
	pasteStart := time.Now()
	err = pasteToPane(socket, target, prompt)
	tel.PasteMS = time.Since(pasteStart).Milliseconds()
	logPaneWrite(attentionEntry{SessionID: "job:" + id, TmuxSocket: socket, TmuxPane: target}, id, "session.new", pasteStart, err)
	if err != nil {
		return err
	}
	waitFor := 20 * time.Second
	// test stubs set WEZDECK_SESSION_NEW_CMD and often write attention.json
	// after stage=done; keep the wait short there so they never stall.
	if os.Getenv("WEZDECK_SESSION_NEW_CMD") != "" || os.Getenv("WEZDECK_SESSION_REUSE_CMD") != "" {
		waitFor = sessionIDStubWait
	}
	warning := ""
	if afterSend != nil {
		warning = afterSend()
	}
	tel.Stage = "wait_session_id"
	waitStart := time.Now()
	newID, nudges, paneDead, lastCmd := waitNewSessionIDWithNudge(ctx, id, socket, target, prompt, beforeIDs, waitFor)
	tel.WaitIDMS = time.Since(waitStart).Milliseconds()
	tel.Nudges = nudges
	if lastCmd != "" {
		tel.Command = lastCmd
	}
	tel.SessionID = newID
	if newID == "" && requireNewSessionAttentionID() {
		if paneDead {
			return errors.New("the agent exited before accepting the first message")
		}
		waitLabel := waitFor.Round(time.Second)
		if waitLabel <= 0 {
			waitLabel = waitFor.Round(time.Millisecond)
		}
		return fmt.Errorf("the agent did not accept the first message within %s; retry or check the terminal", waitLabel)
	}
	var wt string
	setJob(id, func(j *newSessionJob) {
		j.SessionID = newID
		j.Warning = warning
		j.Stage = "done"
		j.finishedAt = time.Now()
		wt = j.Worktree
	})
	if oid := jobOutboxID(id); oid != "" {
		_, _ = outboxUpdate(oid, func(r *sentRecord) {
			r.Status = "pending"
			r.Pane = target
			if newID != "" {
				r.SessionID = newID
			}
			if wt != "" {
				r.Worktree = wt
			}
		})
	}
	tel.Stage = "done"
	return nil
}

func newSessionCreateArgs(name, description, agent string) []string {
	args := []string{"--no-attach", "--description", description}
	if agent != "" {
		args = append(args, "--agent-profile", agent)
	}
	return append(args, "--", name)
}

func newSessionReuseArgs(path, agent string) []string {
	args := []string{"--no-attach"}
	if agent != "" {
		args = append(args, "--agent-profile", agent)
	}
	return append(args, path)
}

var shells = map[string]bool{"bash": true, "zsh": true, "sh": true, "fish": true, "dash": true}
