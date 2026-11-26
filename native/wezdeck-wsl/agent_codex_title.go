package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var codexTitleIndex struct {
	mu     sync.Mutex
	path   string
	info   os.FileInfo
	titles map[string]string
}

func codexSessionTitle(rollout string) string {
	const rolloutPrefix = "rollout-2006-01-02T15-04-05-"
	base, ok := strings.CutSuffix(filepath.Base(rollout), ".jsonl")
	if !ok || !strings.HasPrefix(base, "rollout-") || len(base) <= len(rolloutPrefix) {
		return ""
	}
	id := base[len(rolloutPrefix):]
	// The rollout is under <codex home>/sessions/YYYY/MM/DD.
	index := filepath.Join(filepath.Dir(rollout), "..", "..", "..", "..", "session_index.jsonl")

	codexTitleIndex.mu.Lock()
	defer codexTitleIndex.mu.Unlock()
	info, err := os.Stat(index)
	if err != nil {
		return ""
	}
	cached := codexTitleIndex.info
	if cached != nil && codexTitleIndex.path == index && os.SameFile(cached, info) &&
		cached.Size() == info.Size() && cached.ModTime().Equal(info.ModTime()) {
		return codexTitleIndex.titles[id]
	}

	started := time.Now()
	data, err := os.ReadFile(index)
	if err != nil {
		relayLogf("session_title_index", "agent=codex outcome=read_error")
		return ""
	}
	titles := make(map[string]string)
	for len(data) > 0 {
		var line []byte
		line, data, _ = bytes.Cut(data, []byte{'\n'})
		var entry struct {
			ID    string  `json:"id"`
			Title *string `json:"thread_name"`
		}
		if json.Unmarshal(line, &entry) == nil && entry.ID != "" && entry.Title != nil {
			titles[entry.ID] = strings.TrimSpace(*entry.Title)
		}
	}
	codexTitleIndex.path, codexTitleIndex.info, codexTitleIndex.titles = index, info, titles
	relayLogf("session_title_index", "agent=codex outcome=refreshed entries=%d ms=%d", len(titles), time.Since(started).Milliseconds())
	return titles[id]
}
