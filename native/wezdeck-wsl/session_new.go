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
			if _, cwd, _, _, alive := paneState(e); alive && cwd != "" {
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
	ID       string `json:"job"`
	Stage    string `json:"stage"` // creating | starting | sending | done | failed
	Repo     string `json:"repo"`
	Worktree string `json:"worktree,omitempty"`
	Branch   string `json:"branch,omitempty"`
	Error    string `json:"error,omitempty"`
	at       time.Time
}

var (
	newJobsMu sync.Mutex
	newJobs   = map[string]*newSessionJob{}
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
	}
	if json.Unmarshal(args, &a) != nil {
		return nil, errors.New("session.new: bad arguments")
	}
	a.Name = strings.TrimSpace(a.Name)
	a.Description = strings.TrimSpace(a.Description)
	a.Prompt = strings.TrimSpace(a.Prompt)
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
	job := &newSessionJob{ID: newDiagID(), Stage: "creating", Repo: a.Repo, at: time.Now()}
	newJobsMu.Lock()
	for id, j := range newJobs { // keep the last hour
		if time.Since(j.at) > time.Hour {
			delete(newJobs, id)
		}
	}
	newJobs[job.ID] = job
	newJobsMu.Unlock()
	go runNewSession(job.ID, a.Repo, a.Name, a.Description, a.Prompt)
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

func runNewSession(id, repo, name, description, prompt string) {
	fail := func(err error) {
		setJob(id, func(j *newSessionJob) { j.Stage, j.Error = "failed", clip(err.Error(), 300) })
		relayLogf("session_new", "job=%s ok=false err=%q", id, err)
	}
	cmdPath := os.Getenv("WEZDECK_SESSION_NEW_CMD")
	if cmdPath == "" {
		cmdPath = filepath.Join(repoRoot(), "scripts", "runtime", "worktree", "open-task-window")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, cmdPath, "--no-attach", "--description", description, "--", name)
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
	setJob(id, func(j *newSessionJob) { j.Stage = "sending" })
	if err := pasteToPane(socket, target, prompt); err != nil {
		fail(err)
		return
	}
	setJob(id, func(j *newSessionJob) { j.Stage = "done" })
	relayLogf("session_new", "job=%s ok=true worktree=%q branch=%q", id, result["worktree_path"], result["branch_name"])
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
		if shells[strings.TrimSpace(string(cmd))] {
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
