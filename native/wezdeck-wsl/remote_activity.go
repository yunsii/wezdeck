package main

// When a session last talked, for ordering the phone's lists. The transcript
// file's mtime is not it: Claude Code touches idle transcripts (mtime only,
// millisecond-rounded, same size) long after the last turn, which kept
// floating idle sessions to the top. Read the newest conversation line's own
// timestamp instead — Claude user / assistant lines, any Codex line — from
// the file's tail, cached by size so a touched file costs nothing. Grok
// lines carry no timestamp: 0, and the caller keeps the mtime.

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"sync"
	"time"
)

type turnStamp struct {
	size int64
	at   int64 // unix ms
}

var (
	turnMu    sync.Mutex
	turnCache = map[string]turnStamp{}
)

const (
	turnTail    = 1 << 20 // first look at the last 1 MB
	turnTailMax = 8 << 20 // giant lines (request blobs): look further, once
)

// lastTurnAt returns the newest conversation timestamp in a transcript (unix
// ms), or 0 when the format has none or none was found.
func lastTurnAt(path, agent string) int64 {
	if agent != "claude" && agent != "codex" && agent != "agy" {
		return 0
	}
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	turnMu.Lock()
	if hit, ok := turnCache[path]; ok && hit.size == info.Size() {
		turnMu.Unlock()
		return hit.at
	}
	turnMu.Unlock()

	at := int64(0)
	for tail := int64(turnTail); at == 0; tail *= 4 {
		at = scanTail(path, info.Size(), tail, agent)
		if tail >= info.Size() || tail >= turnTailMax {
			break
		}
	}
	turnMu.Lock()
	turnCache[path] = turnStamp{size: info.Size(), at: at}
	turnMu.Unlock()
	return at
}

func scanTail(path string, size, tail int64, agent string) int64 {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	start := size - tail
	if start < 0 {
		start = 0
	}
	buf := make([]byte, size-start)
	if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
		return 0
	}
	lines := bytes.Split(buf, []byte("\n"))
	if start > 0 && len(lines) > 0 {
		lines = lines[1:] // the first piece is the end of a line cut by the window
	}
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 || (agent == "agy" && !bytes.Contains(line, []byte(`"created_at"`))) || (agent != "agy" && !bytes.Contains(line, []byte(`"timestamp"`))) {
			continue
		}
		var head struct {
			Type      string `json:"type"`
			Timestamp string `json:"timestamp"`
			CreatedAt string `json:"created_at"`
		}
		if json.Unmarshal(line, &head) != nil {
			continue
		}
		if agent == "agy" {
			if head.Type != "USER_INPUT" && head.Type != "PLANNER_RESPONSE" {
				continue
			}
			head.Timestamp = head.CreatedAt
		}
		if head.Timestamp == "" {
			continue
		}
		if agent == "claude" && head.Type != "user" && head.Type != "assistant" {
			continue
		}
		if ts, err := time.Parse(time.RFC3339Nano, head.Timestamp); err == nil {
			return ts.UnixMilli()
		}
	}
	return 0
}
