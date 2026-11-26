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
	Root    string `json:"root"`
	Label   string `json:"label"`
	Visited int64  `json:"visited,omitempty"`
}

// knownRepos: main checkouts of visited worktrees and running sessions.
func knownRepos() []repoChoice {
	paths := map[string]int64{}
	for path, ms := range worktreeVisits() {
		paths[path] = ms
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
	return map[string]any{"v": 1, "ok": true, "repos": knownRepos()}, nil
}

type newSessionJob struct {
	ID        string `json:"job"`
	Stage     string `json:"stage"` // creating | starting | waiting_trust | sending | done | failed
	Repo      string `json:"repo"`
	Worktree  string `json:"worktree,omitempty"`
	Branch    string `json:"branch,omitempty"`
	SessionID string `json:"session_id,omitempty"`
	Error     string `json:"error,omitempty"`
	// Mode: new (a new direction), parallel (one more slot of a direction
	// whose slots are all busy) or reuse (an idle slot starts a new round)
	Mode     string `json:"mode,omitempty"`
	at       time.Time
	trustCh  chan struct{}
	socket   string
	pane     string
	trusting bool
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
		Repo        string `json:"repo"`
		Name        string `json:"name"`
		Description string `json:"description"`
		Prompt      string `json:"prompt"`
		Agent       string `json:"agent_profile"`
	}
	if json.Unmarshal(args, &a) != nil {
		return nil, errors.New("session.new: bad arguments")
	}
	a.Name = strings.TrimSpace(a.Name)
	a.Description = strings.TrimSpace(a.Description)
	a.Prompt = strings.TrimSpace(a.Prompt)
	a.Agent = strings.ToLower(strings.TrimSpace(a.Agent))
	if a.Agent != "" {
		profiles, err := listAgentProfiles()
		if err != nil {
			return nil, errors.New("session.new: agent profiles unavailable")
		}
		valid := false
		if rows, ok := profiles.(map[string]any)["profiles"].([]agentProfile); ok {
			for _, profile := range rows {
				if profile.ID == a.Agent {
					valid = true
					break
				}
			}
		}
		if !valid {
			return nil, errors.New("session.new: unknown agent profile")
		}
		if a.Agent == "claude_kimi" && !kimiConfigured() {
			return nil, errors.New("session.new: configure the Kimi API key in Agents first")
		}
	}
	if !validSubject(a.Name) {
		return nil, fmt.Errorf("session.new: the name needs 1–%d characters, one line", subjectMax)
	}
	if !hasSlugChar(a.Name) {
		return nil, errors.New("session.new: the name needs letters or digits (it becomes the directory and branch); put the rest in the description")
	}
	if utf8.RuneCountInString(a.Description) > descriptionMax || strings.ContainsAny(a.Description, "\r\n") {
		return nil, fmt.Errorf("session.new: the description is one line of at most %d characters", descriptionMax)
	}
	if a.Prompt == "" || utf8.RuneCountInString(a.Prompt) > promptMax {
		return nil, fmt.Errorf("session.new: the first message needs 1–%d characters", promptMax)
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
	if dirs, err := repoWorkstations(a.Repo); err == nil {
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
	job := &newSessionJob{ID: newDiagID(), Stage: "creating", Repo: a.Repo, Mode: mode, Worktree: reuse, at: time.Now()}
	newJobsMu.Lock()
	if reuse != "" {
		if reusing[reuse] != "" { // taken between the check and here
			newJobsMu.Unlock()
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
		runNewSession(job.ID, a.Repo, a.Name, a.Description, a.Prompt, a.Agent, reuse)
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

func runNewSession(id, repo, name, description, prompt, agent, reuse string) {
	fail := func(err error) {
		setJob(id, func(j *newSessionJob) { j.Stage, j.Error = "failed", clip(err.Error(), 300) })
		relayLogf("session_new", "job=%s ok=false err=%q", id, err)
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
	}
	cmd.Dir = repo
	out, err := cmd.Output()
	result := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	for sc.Scan() {
		if k, v, ok := strings.Cut(sc.Text(), "="); ok {
			result[k] = v
		}
	}
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
		j.Stage, j.Worktree, j.Branch = "starting", result["worktree_path"], result["branch_name"]
	})
	pane, err := tmuxCmd(socket, "display-message", "-p", "-t", result["window_id"], "#{pane_id}").Output()
	if err != nil {
		fail(fmt.Errorf("the new window is gone: %v", err))
		return
	}
	target := strings.TrimSpace(string(pane))
	if err := waitAgentReady(socket, target, 90*time.Second); err != nil {
		fail(err)
		return
	}
	if err := clearWorkspaceTrust(ctx, id, socket, target, true); err != nil {
		fail(err)
		return
	}
	beforeIDs := paneAttentionIDs(socket, target)
	setJob(id, func(j *newSessionJob) { j.Stage = "sending" })
	if err := pasteToPane(socket, target, prompt); err != nil {
		fail(err)
		return
	}
	waitFor := 20 * time.Second
	// test stubs set WEZDECK_SESSION_NEW_CMD and often write attention.json
	// after stage=done; keep the wait short there so they never stall.
	if os.Getenv("WEZDECK_SESSION_NEW_CMD") != "" {
		waitFor = 400 * time.Millisecond
	}
	newID := waitNewSessionID(socket, target, beforeIDs, waitFor)
	setJob(id, func(j *newSessionJob) {
		j.SessionID = newID
		j.Stage = "done"
	})
	relayLogf("session_new", "job=%s ok=true reuse=%t session_id=%s worktree=%q branch=%q",
		id, reuse != "", newID, result["worktree_path"], result["branch_name"])
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

// waitAgentReady: the pane runs something other than a shell and its screen
// has held still for 1.5 s — the agent TUI is drawn and takes input.
func waitAgentReady(socket, pane string, limit time.Duration) error {
	deadline := time.Now().Add(limit)
	last, stable := "", time.Time{}
	for time.Now().Before(deadline) {
		time.Sleep(500 * time.Millisecond)
		cmd, err := tmuxCmd(socket, "display-message", "-p", "-t", pane, "#{pane_current_command}").Output()
		if err != nil {
			return errors.New("the agent pane closed while starting")
		}
		if shells[strings.TrimSpace(string(cmd))] && !paneHasAgentProcess(socket, pane) {
			last, stable = "", time.Time{}
			continue
		}
		screen, _ := tmuxCmd(socket, "capture-pane", "-p", "-t", pane).Output()
		if s := strings.TrimSpace(string(screen)); s != "" && s == last {
			if !stable.IsZero() && time.Since(stable) >= 1500*time.Millisecond {
				return nil
			}
			if stable.IsZero() {
				stable = time.Now()
			}
		} else {
			last, stable = s, time.Time{}
		}
	}
	return errors.New("the agent did not come up within 90 s")
}
