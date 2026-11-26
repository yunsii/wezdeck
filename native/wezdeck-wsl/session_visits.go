package main

// When you last visited a worktree, from the access ledger that Alt+g / Alt+x
// sort by (scripts/runtime/access-ledger-lib.sh): "user visited / selected",
// never pane output. The phone's chat list no longer sorts by visits.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

func accessLedgerFile() string {
	if p := os.Getenv("WEZDECK_ACCESS_LEDGER"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local/state/wezterm-runtime/state/access-ledger.json")
}

// worktreeVisits maps worktree path → last access (ms). Fail-open: empty map.
func worktreeVisits() map[string]int64 {
	out := map[string]int64{}
	data, err := os.ReadFile(accessLedgerFile())
	if err != nil {
		return out
	}
	var doc struct {
		Worktrees map[string]struct {
			LastAccessMs int64 `json:"last_access_ms"`
		} `json:"worktrees"`
	}
	if json.Unmarshal(data, &doc) != nil {
		return out
	}
	for path, w := range doc.Worktrees {
		out[filepath.Clean(path)] = w.LastAccessMs
	}
	return out
}

// visitOf: the worktree's visit time, else the cwd's (a session started in a
// subdirectory, or outside git).
func visitOf(visits map[string]int64, worktree, cwd string) int64 {
	for _, p := range []string{worktree, cwd} {
		if p == "" {
			continue
		}
		if ms, ok := visits[filepath.Clean(p)]; ok {
			return ms
		}
	}
	return 0
}

// Keep repository roots separate from worktree visit timestamps so closing
// a session does not change the terminal picker's navigation history.
func rememberedSessionRepos() map[string]int64 {
	var data struct {
		Repos map[string]int64 `json:"session_repos"`
	}
	body, err := os.ReadFile(accessLedgerFile())
	if err == nil {
		_ = json.Unmarshal(body, &data)
	}
	if data.Repos == nil {
		data.Repos = map[string]int64{}
	}
	return data.Repos
}

func rememberSessionRepo(repo string) error {
	path := accessLedgerFile()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return err
	}
	doc := map[string]json.RawMessage{}
	body, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := json.Unmarshal(body, &doc); err != nil {
			return err
		}
	case !errors.Is(err, os.ErrNotExist):
		return err
	}
	if doc == nil {
		doc = map[string]json.RawMessage{}
	}
	repos := map[string]int64{}
	if raw := doc["session_repos"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &repos); err != nil {
			return err
		}
	}
	if repos == nil {
		repos = map[string]int64{}
	}
	repos[repo] = time.Now().UnixMilli()
	doc["session_repos"], err = json.Marshal(repos)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".session-repos-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	err = json.NewEncoder(tmp).Encode(doc)
	closeErr := tmp.Close()
	if err != nil || closeErr != nil {
		return errors.Join(err, closeErr)
	}
	return os.Rename(tmp.Name(), path)
}
