package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Resolve the checkout from a live session. The browser never supplies a
// filesystem path, socket, or terminal command.
func sessionGroupTarget(id string) (attentionEntry, string, string, error) {
	if !sessionIDPattern.MatchString(id) {
		return attentionEntry{}, "", "", errors.New("invalid session id")
	}
	entries, err := liveSessions()
	if err != nil {
		return attentionEntry{}, "", "", err
	}
	entry, ok := entries[id]
	if !ok || entry.RestartPending {
		return attentionEntry{}, "", "", errors.New("session not found")
	}
	_, cwd, command, _, profile, alive := paneState(entry)
	if !alive || !isAgentPane(command, entry) || !paneOwnsSessionAgent(command, profile, entry.AgentName) {
		return attentionEntry{}, "", "", errors.New("the session no longer owns its pane")
	}
	_, repo, tree := gitRepoMeta(cwd)
	if repo == "" || tree == "" {
		return attentionEntry{}, "", "", errors.New("session checkout unavailable")
	}
	return entry, repo, tree, nil
}

func startGroupedSession(id, agent, prompt, groupName string) (any, error) {
	entry, repo, tree, err := sessionGroupTarget(id)
	if err != nil {
		return nil, err
	}
	job := &newSessionJob{ID: newDiagID(), Stage: "creating", Repo: repo, Worktree: tree, Mode: "group", at: time.Now()}
	unlock, err := lockSessionWorktree(tree)
	if err != nil {
		return nil, err
	}
	newJobsMu.Lock()
	if reusing[tree] != "" {
		newJobsMu.Unlock()
		unlock()
		return nil, errors.New("another operation is using this worktree")
	}
	reusing[tree] = job.ID
	for existingID, existing := range newJobs {
		if time.Since(existing.at) > time.Hour {
			delete(newJobs, existingID)
		}
	}
	newJobs[job.ID] = job
	newJobsMu.Unlock()
	go func() {
		defer unlock()
		defer releaseSessionWorktree(tree)
		err := runGroupedSession(job.ID, id, entry, repo, tree, agent, prompt, groupName)
		if err != nil {
			setJob(job.ID, func(j *newSessionJob) { j.Stage, j.Error = "failed", clip(err.Error(), 300) })
		}
		relayLogf("session_group_new", "job=%s ok=%t worktree=%q", job.ID, err == nil, tree)
	}()
	return map[string]any{"v": 1, "ok": true, "job": job.ID}, nil
}

// Local Runtime and the relay are separate processes. Use the same lock
// across both so cleanup cannot race a Web start routed through the other.
func lockSessionWorktree(tree string) (func(), error) {
	dir := attentionFile() + ".worktree-locks"
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, fmt.Sprintf("%x", sha256.Sum256([]byte(tree))))
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("cannot reserve the worktree: %w", err)
	}
	return func() { _ = file.Close() }, nil
}

func releaseSessionWorktree(tree string) {
	newJobsMu.Lock()
	delete(reusing, tree)
	newJobsMu.Unlock()
}

func runGroupedSession(jobID, anchorID string, anchor attentionEntry, repo, tree, agent, prompt, groupName string) error {
	current, _, checkout, err := sessionGroupTarget(anchorID)
	if err != nil || checkout != tree || current.TmuxPane != anchor.TmuxPane || current.TmuxSocket != anchor.TmuxSocket {
		return errors.New("the source session changed before launch")
	}
	// A detached sibling window preserves the existing window layout and focus.
	session, err := tmuxCmd(anchor.TmuxSocket, "display-message", "-p", "-t", anchor.TmuxPane, "#{session_id}").Output()
	if err != nil {
		return fmt.Errorf("resolve the source tmux session: %w", err)
	}
	launcher := filepath.Join(repoRoot(), "scripts", "runtime", "agent-launcher.sh")
	out, err := tmuxCmd(anchor.TmuxSocket, "new-window", "-d", "-P", "-F", "#{pane_id}",
		"-t", strings.TrimSpace(string(session))+":", "-n", filepath.Base(tree)+"-"+agent, "-c", tree,
		"-e", "WEZDECK_FORCE_FRESH_SESSION=1", "bash", launcher, agent).Output()
	if err != nil {
		return fmt.Errorf("start an agent in the worktree: %w", err)
	}
	pane := strings.TrimSpace(string(out))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	setJob(jobID, func(j *newSessionJob) { j.Stage = "starting" })
	return sendNewSessionPrompt(ctx, jobID, anchor.TmuxSocket, pane, prompt, func() string {
		if groupName == "" {
			return ""
		}
		if err := saveSessionGroupName(repo, tree, groupName); err != nil {
			relayLogf("session_group_name", "job=%s outcome=failed err=%q", jobID, err)
			return clip(err.Error(), 300)
		}
		return ""
	})
}

func deleteGroupedSession(args json.RawMessage) (any, error) {
	var request struct {
		ID      string `json:"id"`
		Confirm bool   `json:"confirm"`
	}
	if json.Unmarshal(args, &request) != nil || !request.Confirm {
		return nil, errors.New("session.delete requires confirmation")
	}
	entry, repo, tree, err := sessionGroupTarget(request.ID)
	if err != nil {
		return nil, err
	}
	unlock, err := lockSessionWorktree(tree)
	if err != nil {
		return nil, err
	}
	defer unlock()
	newJobsMu.Lock()
	if reusing[tree] != "" {
		newJobsMu.Unlock()
		return nil, errors.New("another operation is using this worktree")
	}
	reusing[tree] = request.ID
	newJobsMu.Unlock()
	defer releaseSessionWorktree(tree)

	if _, err := guardSession(request.ID); err != nil {
		return nil, err
	}
	current, _, checkout, err := sessionGroupTarget(request.ID)
	if err != nil || checkout != tree || current.TmuxPane != entry.TmuxPane || current.TmuxSocket != entry.TmuxSocket {
		return nil, errors.New("the pane changed before deletion")
	}
	marker := closedSessionMarker(request.ID)
	if err := os.MkdirAll(filepath.Dir(marker), 0700); err != nil {
		return nil, err
	}
	pin, err := tmuxCmd(entry.TmuxSocket, "display-message", "-p", "-t", entry.TmuxPane, "#{@wezterm_agent_session_id}").Output()
	if err != nil {
		return nil, errors.New("cannot verify the session pane")
	}
	if pinned := strings.TrimSpace(string(pin)); pinned != "" && pinned != request.ID && pinned != entry.ReplacedFrom {
		return nil, errors.New("the pane is pinned to another session")
	}
	if err := os.WriteFile(marker, nil, 0600); err != nil {
		return nil, err
	}
	if err := tmuxCmd(entry.TmuxSocket, "kill-pane", "-t", entry.TmuxPane).Run(); err != nil {
		_ = os.Remove(marker)
		return nil, fmt.Errorf("close session pane: %w", err)
	}
	outcome := "primary"
	if tree != repo {
		outcome = "in_use"
		paths, err := tmuxCmd(entry.TmuxSocket, "list-panes", "-a", "-F", "#{pane_start_path}").Output()
		if err != nil || !strings.Contains("\n"+string(paths), "\n"+tree+"\n") {
			outcome = reclaimEmptySessionWorktree(repo, tree)
		}
	}
	relayLogf("session_delete", "id=%s worktree=%q outcome=%s", request.ID, tree, outcome)
	return map[string]any{"v": 1, "ok": true, "worktree_outcome": outcome}, nil
}

func closedSessionMarker(id string) string {
	return filepath.Join(attentionFile()+".closed-sessions", id)
}

func sessionWasClosed(id string) bool {
	if !sessionIDPattern.MatchString(id) {
		return false
	}
	_, err := os.Stat(closedSessionMarker(id))
	return err == nil
}

func reclaimEmptySessionWorktree(repo, tree string) string {
	if tree == repo {
		return "primary"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	git := func(args ...string) *exec.Cmd {
		return exec.CommandContext(ctx, "git", append([]string{"-C", tree}, args...)...)
	}
	branch, err := git("symbolic-ref", "--quiet", "--short", "HEAD").Output()
	if err != nil || !strings.HasPrefix(string(branch), "dev/") {
		return "unmanaged"
	}
	if git("merge-base", "--is-ancestor", "HEAD", "origin/HEAD").Run() != nil {
		return "undelivered"
	}
	status, err := git("status", "--porcelain", "--untracked-files=all", "--ignored=matching").Output()
	if err != nil || len(status) > 0 {
		return "dirty"
	}
	// Check processes as well as sessions. A shell or an agent before its
	// first attention event can still be using the checkout.
	processes, err := filepath.Glob("/proc/[0-9]*/cwd")
	if err != nil {
		return "in_use"
	}
	for _, process := range processes {
		cwd, err := os.Readlink(process)
		if err == nil && (cwd == tree || strings.HasPrefix(cwd, tree+"/")) {
			return "in_use"
		}
	}
	reclaim := filepath.Join(repoRoot(), "scripts", "runtime", "worktree", "worktree-task")
	cmd := exec.CommandContext(ctx, "bash", reclaim, "reclaim", "--worktree-root", tree,
		"--provider-mode", "off", "--keep-branch")
	cmd.Dir = repo
	if err := cmd.Run(); err != nil {
		return "retained"
	}
	return "removed"
}

// The group belongs to the checkout. Managed workstations share the same
// description writer as the terminal. The primary checkout uses its branch
// description because the workstation command only accepts linked checkouts.
func saveSessionGroupName(repo, tree, name string) error {
	if repo != tree {
		args, err := json.Marshal(map[string]string{"worktree": tree, "text": name})
		if err != nil {
			return err
		}
		_, err = describeWorktree(args)
		return err
	}
	return describePrimaryCheckout(repo, name)
}
