package main

// `workstations {repo}` (read): a repository's workstations grouped by
// direction, each with whether it can start a new round now — what the web
// console's 新会话 offers before it reuses one (docs/workspaces.md
// "Workstations").
//
// A slot is idle when both halves hold:
//   - git: `worktree-task idle` — clean, and its tip is in origin/HEAD
//     (pushed-only is not enough; read without a fetch, so a just-merged
//     tip may still show undelivered, the safe side — the reuse itself
//     fetches and checks again)
//   - agent: no live attention entry in the slot is running or waiting
//
// Direction membership is the branch's workstationDirection key (set when a
// parallel slot is opened), else the slot is its own direction.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type workstationSlot struct {
	Path    string `json:"path"`
	Name    string `json:"name"` // the directory without an old dev- prefix
	Branch  string `json:"branch"`
	State   string `json:"state"` // idle | running | waiting | dirty | undelivered | detached
	Reason  string `json:"reason,omitempty"`
	Visited int64  `json:"visited,omitempty"`
}

type workstationDirection struct {
	Name        string            `json:"name"`
	Description string            `json:"description,omitempty"`
	Idle        int               `json:"idle"`
	Visited     int64             `json:"visited,omitempty"`
	Slots       []workstationSlot `json:"slots"`
}

func listWorkstations(args json.RawMessage) (any, error) {
	var a struct {
		Repo string `json:"repo"`
	}
	_ = json.Unmarshal(args, &a)
	if !isKnownRepo(a.Repo) {
		return nil, errors.New("workstations: not a repository you work in")
	}
	dirs, err := repoWorkstations(a.Repo)
	if err != nil {
		return nil, err
	}
	return map[string]any{"v": 1, "ok": true, "directions": dirs}, nil
}

func isKnownRepo(root string) bool {
	if root == "" {
		return false
	}
	for _, r := range knownRepos() {
		if r.Root == root {
			return true
		}
	}
	return false
}

// repoWorkstations: directions newest visit first, slots likewise.
func repoWorkstations(repo string) ([]workstationDirection, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", repo, "worktree", "list", "--porcelain").Output()
	if err != nil {
		return nil, errors.New("workstations: git worktree list failed")
	}
	var slots []workstationSlot
	path, branch := "", ""
	flush := func() {
		base := filepath.Base(path)
		if path != "" && filepath.Clean(path) != filepath.Clean(repo) &&
			!strings.HasPrefix(base, "ticket-") && !strings.HasPrefix(base, "claw-") {
			slots = append(slots, workstationSlot{Path: path, Name: strings.TrimPrefix(base, "dev-"), Branch: branch})
		}
		path, branch = "", ""
	}
	sc := bufio.NewScanner(strings.NewReader(string(out) + "\n"))
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "worktree "):
			path = strings.TrimPrefix(line, "worktree ")
		case strings.HasPrefix(line, "branch refs/heads/"):
			branch = strings.TrimPrefix(line, "branch refs/heads/")
		case line == "":
			flush()
		}
	}

	busy := busyWorktrees()
	visits := worktreeVisits()
	var wg sync.WaitGroup
	for i := range slots {
		s := &slots[i]
		s.Visited = visits[s.Path]
		if st := busy[s.Path]; st != "" {
			s.State, s.Reason = st, map[string]string{"running": "the agent is working", "waiting": "the agent is waiting for you"}[st]
			continue
		}
		if s.Branch == "" {
			s.State, s.Reason = "detached", "detached HEAD"
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.State, s.Reason = gitIdle(s.Path)
		}()
	}
	wg.Wait()

	byName := map[string]*workstationDirection{}
	var order []string
	for _, s := range slots {
		name := s.Name
		if s.Branch != "" {
			if d := gitConfig(repo, "branch."+s.Branch+".workstationDirection"); d != "" {
				name = d
			}
		}
		d := byName[name]
		if d == nil {
			d = &workstationDirection{Name: name}
			byName[name] = d
			order = append(order, name)
		}
		d.Slots = append(d.Slots, s)
		if s.State == "idle" {
			d.Idle++
		}
		if s.Visited > d.Visited {
			d.Visited = s.Visited
		}
		if d.Description == "" && s.Branch != "" {
			d.Description = worktreeDescription(repo, s.Branch)
		}
	}
	dirs := make([]workstationDirection, 0, len(order))
	for _, name := range order {
		d := byName[name]
		sort.SliceStable(d.Slots, func(i, j int) bool { return d.Slots[i].Visited > d.Slots[j].Visited })
		dirs = append(dirs, *d)
	}
	sort.SliceStable(dirs, func(i, j int) bool { return dirs[i].Visited > dirs[j].Visited })
	return dirs, nil
}

// busyWorktrees: worktree path → "running" / "waiting" for every live
// attention entry whose pane is mid-turn or waiting on you.
func busyWorktrees() map[string]string {
	busy := map[string]string{}
	entries, err := liveSessions()
	if err != nil {
		return busy
	}
	for _, e := range entries {
		status := e.Status
		if e.WaitingKind != "" {
			status = "waiting"
		}
		if status != "running" && status != "waiting" {
			continue
		}
		_, cwd, _, _, _, alive := paneState(e)
		if !alive || cwd == "" {
			continue
		}
		_, _, wt := gitRepoMeta(cwd)
		if wt == "" {
			continue
		}
		if busy[wt] != "waiting" { // waiting on you outranks running
			busy[wt] = status
		}
	}
	return busy
}

// gitIdle runs `worktree-task idle` (no fetch): "idle", or the state and why.
func gitIdle(path string) (state, reason string) {
	cmdPath := os.Getenv("WEZDECK_WORKTREE_TASK_CMD")
	if cmdPath == "" {
		cmdPath = filepath.Join(repoRoot(), "scripts", "runtime", "worktree", "worktree-task")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, cmdPath, "idle", "--cwd", path).Output()
	for _, line := range strings.Split(string(out), "\n") {
		if v, ok := strings.CutPrefix(line, "state="); ok {
			state = v
		} else if v, ok := strings.CutPrefix(line, "reason="); ok {
			reason = v
		}
	}
	if state == "" {
		return "unknown", "could not check (worktree-task idle)"
	}
	return state, reason
}

func gitConfig(repo, key string) string {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, "git", "-C", repo, "config", "--get", key).Output()
	return strings.TrimSpace(string(out))
}

// idleSlot: the slot of `direction` to reuse — idle, most recently visited.
func idleSlot(dirs []workstationDirection, direction string) (workstationSlot, bool) {
	for _, d := range dirs {
		if d.Name != direction {
			continue
		}
		for _, s := range d.Slots { // sorted by visit
			if s.State == "idle" {
				return s, true
			}
		}
	}
	return workstationSlot{}, false
}
