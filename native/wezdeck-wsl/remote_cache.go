package main

// Lightweight, self-validating hot-path caches for relay RPCs:
//   - transcript path cache: positive hits validated by os.Stat (~5 µs on ext4)
//     so `sessions` / `session` polls avoid repeated multi-directory globs;
//     `pending-*` placeholders short-circuit immediately.
//   - gitRepoMeta cache: 30 s TTL per clean directory (same horizon as
//     worktreesTTL / worktreeDescriptionTTL), caching only resolved git repos
//     so `sessions` avoids spawning `git rev-parse` per worktree every poll.

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type transcriptCacheEntry struct {
	path  string
	agent string
}

const (
	gitRepoMetaTTL = 30 * time.Second
	deadSocketTTL  = 15 * time.Second
)

type gitRepoMetaCacheEntry struct {
	at       time.Time
	repo     string
	repoRoot string
	worktree string
}

type deadSocketEntry struct {
	at      time.Time
	modTime time.Time
	existed bool
}

var (
	transcriptLocMu    sync.RWMutex
	transcriptLocCache = map[string]transcriptCacheEntry{}

	gitMetaMu    sync.RWMutex
	gitMetaCache = map[string]gitRepoMetaCacheEntry{}

	deadSocketMu    sync.RWMutex
	deadSocketCache = map[string]deadSocketEntry{}
)

func isKnownDeadTmuxSocket(socket string) bool {
	if socket == "" {
		return false
	}
	deadSocketMu.RLock()
	hit, ok := deadSocketCache[socket]
	deadSocketMu.RUnlock()
	if !ok || time.Since(hit.at) >= deadSocketTTL {
		return false
	}
	info, err := os.Stat(socket)
	if err != nil {
		return !hit.existed
	}
	return hit.existed && info.ModTime().Equal(hit.modTime)
}

func markDeadTmuxSocket(socket string) {
	if socket == "" {
		return
	}
	entry := deadSocketEntry{at: time.Now()}
	if info, err := os.Stat(socket); err == nil {
		entry.existed = true
		entry.modTime = info.ModTime()
	}
	deadSocketMu.Lock()
	if len(deadSocketCache) > 128 {
		clear(deadSocketCache)
	}
	deadSocketCache[socket] = entry
	deadSocketMu.Unlock()
}

func clearDeadTmuxSocket(socket string) {
	if socket == "" {
		return
	}
	deadSocketMu.Lock()
	delete(deadSocketCache, socket)
	deadSocketMu.Unlock()
}

func lookupTranscriptCached(home, sessionID string) (string, string, bool) {
	key := home + "\x00" + sessionID
	transcriptLocMu.RLock()
	hit, ok := transcriptLocCache[key]
	transcriptLocMu.RUnlock()
	if !ok {
		return "", "", false
	}
	if _, err := os.Stat(hit.path); err != nil {
		transcriptLocMu.Lock()
		delete(transcriptLocCache, key)
		transcriptLocMu.Unlock()
		return "", "", false
	}
	return hit.path, hit.agent, true
}

func storeTranscriptCached(home, sessionID, path, agent string) {
	if path == "" || agent == "" {
		return
	}
	key := home + "\x00" + sessionID
	transcriptLocMu.Lock()
	if len(transcriptLocCache) > 2048 {
		clear(transcriptLocCache)
	}
	transcriptLocCache[key] = transcriptCacheEntry{path: path, agent: agent}
	transcriptLocMu.Unlock()
}

func lookupGitRepoMetaCached(cwd string) (repo, repoRoot, worktree string, ok bool) {
	key := filepath.Clean(cwd)
	gitMetaMu.RLock()
	hit, found := gitMetaCache[key]
	gitMetaMu.RUnlock()
	if !found || time.Since(hit.at) >= gitRepoMetaTTL {
		return "", "", "", false
	}
	return hit.repo, hit.repoRoot, hit.worktree, true
}

func storeGitRepoMetaCached(cwd, repo, repoRoot, worktree string) {
	if repoRoot == "" {
		return
	}
	key := filepath.Clean(cwd)
	gitMetaMu.Lock()
	if len(gitMetaCache) > 512 {
		clear(gitMetaCache)
	}
	gitMetaCache[key] = gitRepoMetaCacheEntry{
		at:       time.Now(),
		repo:     repo,
		repoRoot: repoRoot,
		worktree: worktree,
	}
	gitMetaMu.Unlock()
}

func isPendingSessionID(id string) bool {
	return strings.HasPrefix(id, "pending-")
}
